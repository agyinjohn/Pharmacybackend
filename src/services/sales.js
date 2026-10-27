const { Product, Prescription, Sale, Shift, Customer } = require('../models');
const { bad, forbidden, conflict, seq, round2 } = require('../utils/http');
const { priceFor, deductFefo, restore, registerEntry } = require('./stock');

const DISCOUNT_LIMIT = { cashier: 0.05, pharmacist: 0.1, branch_manager: 0.3, owner: 1 };
const RX_LEVELS = ['prescription_only', 'controlled'];

const maxFor = (rx, item) => item.qty * (1 + (rx.refillsAllowed || 0));

// Atomically claims quantity against a prescription. Because the counter lives on the one shared
// prescription record, the same prescription cannot be over-dispensed at two branches at once.
const claimRx = async (rx, product, qty) => {
  const item = rx.items.find((i) => String(i.product) === String(product));
  if (!item) throw bad('That medicine is not on the prescription');
  const max = maxFor(rx, item);
  const res = await Prescription.updateOne(
    { _id: rx._id, status: { $in: ['verified', 'partial'] } },
    { $inc: { 'items.$[e].dispensedQty': qty } },
    { arrayFilters: [{ 'e.product': item.product, 'e.dispensedQty': { $lte: max - qty } }] },
  );
  if (res.modifiedCount !== 1) {
    throw conflict(`${item.name || 'Item'} exceeds the quantity allowed on prescription ${rx.rxNo} (${item.dispensedQty}/${max} already dispensed)`);
  }
};

const unclaimRx = (rx, product, qty) => Prescription.updateOne(
  { _id: rx._id },
  { $inc: { 'items.$[e].dispensedQty': -qty } },
  { arrayFilters: [{ 'e.product': product }] },
);

const refreshRxStatus = async (rxId) => {
  const rx = await Prescription.findById(rxId);
  if (!rx) return;
  const all = rx.items.every((i) => i.dispensedQty >= maxFor(rx, i));
  const any = rx.items.some((i) => i.dispensedQty > 0);
  const next = all ? 'dispensed' : any ? 'partial' : (['partial', 'dispensed'].includes(rx.status) ? 'verified' : rx.status);
  if (next !== rx.status) { rx.status = next; await rx.save(); }
};

const completeSale = async ({ user, org, branch, items, customerId, discount = 0, payments = [], prescriptionId, channel = 'pos', allowNoShift = false }) => {
  if (!items?.length) throw bad('Add at least one item');
  const products = await Product.find({ _id: { $in: items.map((i) => i.product) }, org, active: true });
  const byId = new Map(products.map((p) => [String(p._id), p]));

  // Merge duplicate lines so limits and stock are checked against the real total.
  const merged = new Map();
  for (const i of items) {
    const qty = Number(i.qty);
    if (!Number.isInteger(qty) || qty < 1) throw bad('Quantities must be whole numbers of at least 1');
    merged.set(String(i.product), (merged.get(String(i.product)) || 0) + qty);
  }
  const lines = [...merged].map(([pid, qty]) => {
    const p = byId.get(pid);
    if (!p) throw bad('A product in the basket no longer exists');
    return { p, qty };
  });

  const rxLines = lines.filter((l) => RX_LEVELS.includes(l.p.legalStatus));
  let rx = null;
  if (rxLines.length) {
    if (!user.isPharmacistInGoodStanding()) {
      throw forbidden('Prescription-only and controlled medicines are dispensed by a registered pharmacist in good standing');
    }
    if (!prescriptionId) throw bad('A verified prescription is required for prescription-only and controlled medicines');
    rx = await Prescription.findOne({ _id: prescriptionId, org });
    if (!rx || !['verified', 'partial'].includes(rx.status)) throw conflict('Prescription is not verified');
    if (rxLines.some((l) => l.p.legalStatus === 'controlled') && !rx.paperOriginalSeen) {
      throw conflict('Controlled drugs need the signed paper original to be sighted and recorded on the prescription');
    }
  }

  // Shift handling for sales at the counter.
  let shift = null;
  if (channel === 'pos') {
    shift = await Shift.findOne({ org, branch, cashier: user._id, status: 'open' });
    if (!shift && user.role === 'cashier' && !allowNoShift) throw conflict('Open your shift before selling');
  }

  const claimed = [];
  const taken = [];
  try {
    const saleItems = [];
    for (const { p, qty } of lines) {
      if (rx && RX_LEVELS.includes(p.legalStatus)) {
        await claimRx(rx, p._id, qty);
        claimed.push({ product: p._id, qty });
      }
      const lots = await deductFefo({ org, branch, product: p._id, qty, label: p.brand });
      taken.push(...lots);
      const unitPrice = priceFor(p, branch);
      const base = unitPrice * qty;
      saleItems.push({
        product: p._id, name: `${p.brand}${p.strength ? ' ' + p.strength : ''}`, qty, unitPrice,
        taxRate: p.taxRate, tax: round2(base * p.taxRate), lineTotal: round2(base),
        cost: round2(lots.reduce((s, l) => s + l.cost * l.qty, 0) / qty),
        lots: lots.map(({ batch, batchNo, expiry, qty: q }) => ({ batch, batchNo, expiry, qty: q })),
      });
    }

    const subtotal = round2(saleItems.reduce((s, i) => s + i.lineTotal, 0));
    const limit = DISCOUNT_LIMIT[user.role] || 0;
    const disc = round2(Number(discount) || 0);
    if (disc < 0 || disc > subtotal * limit + 0.001) {
      throw forbidden(`Your role may give at most ${Math.round(limit * 100)}% discount on a sale`);
    }
    const ratio = subtotal ? (subtotal - disc) / subtotal : 1;
    const tax = round2(saleItems.reduce((s, i) => s + i.tax, 0) * ratio);
    const total = round2(subtotal - disc + tax);

    // 'auto' settles the exact total in cash (used when a pharmacist dispenses from the queue).
    if (payments === 'auto') payments = [{ method: 'cash', amount: total }];
    const paid = round2(payments.reduce((s, p) => s + Number(p.amount || 0), 0));
    if (paid + 0.001 < total) throw bad(`Payment short by ${round2(total - paid).toFixed(2)}`);
    const cashPaid = payments.filter((p) => p.method === 'cash').reduce((s, p) => s + Number(p.amount), 0);
    const change = round2(paid - total);
    if (change > cashPaid + 0.001) throw bad('Change can only be given against cash');

    let customer = null;
    const creditAmount = payments.filter((p) => p.method === 'credit').reduce((s, p) => s + Number(p.amount), 0);
    if (customerId) customer = await Customer.findOne({ _id: customerId, org });
    if (creditAmount > 0) {
      if (!customer) throw bad('Choose a credit customer first');
      if (customer.balance + creditAmount > customer.creditLimit) throw conflict('Credit limit exceeded for this customer');
    }

    const sale = await Sale.create({
      org, branch, receiptNo: seq('R'), cashier: user._id, customer: customer?._id, shift: shift?._id,
      prescription: rx?._id, channel, items: saleItems, subtotal, discount: disc, tax, total,
      payments: payments.map((p) => ({ method: p.method, amount: Number(p.amount), reference: p.reference })),
      changeGiven: change,
    });

    if (creditAmount > 0) await Customer.updateOne({ _id: customer._id }, { $inc: { balance: creditAmount } });
    if (customer) await Customer.updateOne({ _id: customer._id }, { $inc: { loyaltyPoints: Math.floor(total / 10) } });
    if (shift && cashPaid) await Shift.updateOne({ _id: shift._id }, { $inc: { cashSales: round2(cashPaid - change) } });

    if (rx) {
      for (const { p, qty } of rxLines) {
        const sold = saleItems.find((i) => String(i.product) === String(p._id));
        await Prescription.updateOne({ _id: rx._id }, {
          $push: { dispensings: { at: new Date(), by: user._id, sale: sale._id, lines: [{ product: p._id, qty, batchNo: sold.lots.map((l) => l.batchNo).join(',') }] } },
        });
        if (p.legalStatus === 'controlled') {
          await registerEntry({
            org, branch, product: p._id, productName: sold.name, type: 'supply', qty,
            counterparty: rx.patientName, patient: rx.patientName, prescriber: rx.prescriber.name,
            prescriberAddress: rx.prescriber.address, rxNo: rx.rxNo,
            batchNo: sold.lots.map((l) => l.batchNo).join(','), pharmacist: user._id, pharmacistName: user.name,
          });
        }
      }
      await refreshRxStatus(rx._id);
    }
    return sale;
  } catch (e) {
    await restore(taken);
    for (const c of claimed) await unclaimRx(rx, c.product, c.qty);
    throw e;
  }
};

const refundSale = async ({ user, sale, lines, reason }) => {
  if (!reason || !reason.trim()) throw bad('A reason is required for a refund');
  if (['refunded'].includes(sale.status)) throw conflict('Sale is already fully refunded');
  const refunded = new Map();
  sale.refunds.forEach((r) => r.lines.forEach((l) => refunded.set(String(l.product), (refunded.get(String(l.product)) || 0) + l.qty)));
  const toReturn = lines && lines.length ? lines : sale.items.map((i) => ({ product: i.product, qty: i.qty - (refunded.get(String(i.product)) || 0) })).filter((l) => l.qty > 0);
  if (!toReturn.length) throw conflict('Nothing left to refund');

  const products = await Product.find({ _id: { $in: toReturn.map((l) => l.product) } });
  const prodMap = new Map(products.map((p) => [String(p._id), p]));
  let amount = 0;
  const restocked = [];
  for (const l of toReturn) {
    const item = sale.items.find((i) => String(i.product) === String(l.product));
    const qty = Number(l.qty);
    if (!item || !Number.isInteger(qty) || qty < 1) throw bad('Invalid refund line');
    if (qty > item.qty - (refunded.get(String(l.product)) || 0)) throw bad(`Cannot refund more than was sold of ${item.name}`);
    const p = prodMap.get(String(l.product));
    if (RX_LEVELS.includes(p.legalStatus) && !user.isPharmacistInGoodStanding()) {
      throw forbidden('Refunds of prescription-only or controlled items need a pharmacist');
    }
    amount += (item.lineTotal / item.qty + item.tax / item.qty) * qty;
    let left = qty;
    for (const lot of item.lots) {
      const put = Math.min(lot.qty, left);
      if (put > 0) { restocked.push({ batch: lot.batch, qty: put }); left -= put; }
    }
    if (p.legalStatus === 'controlled') {
      await registerEntry({
        org: sale.org, branch: sale.branch, product: p._id, productName: item.name, type: 'correction', qty,
        pharmacist: user._id, pharmacistName: user.name, rxNo: undefined, note: `Customer return, receipt ${sale.receiptNo}: ${reason}`,
      });
    }
  }
  await restore(restocked);
  sale.refunds.push({ at: new Date(), by: user._id, reason, amount: round2(amount), lines: toReturn.map((l) => ({ product: l.product, qty: Number(l.qty) })) });
  const totalRefunded = sale.refunds.reduce((s, r) => s + r.amount, 0);
  sale.status = totalRefunded + 0.01 >= sale.total ? 'refunded' : 'partially_refunded';
  await sale.save();
  return sale;
};

module.exports = { completeSale, refundSale, refreshRxStatus, claimRx, unclaimRx, DISCOUNT_LIMIT, RX_LEVELS };

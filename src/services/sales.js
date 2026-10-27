const { Product, Prescription, Sale, Shift, Customer, Ledger, Promotion, Organization } = require('../models');
const { priceBasket } = require('./pricing');
const { bad, forbidden, conflict, seq, round2 } = require('../utils/http');
const { priceFor, deductFefo, restore, registerEntry, available } = require('./stock');

const DISCOUNT_LIMIT = { cashier: 0.05, pharmacist: 0.1, branch_manager: 0.3, owner: 1 };
const RX_LEVELS = ['prescription_only', 'controlled'];

const activePromotions = (org) => Promotion.find({ org, active: true });

// Price a basket without touching stock: used by the till to show promotions before charging.
const quoteSale = async ({ org, branch, items, discount = 0 }) => {
  const products = await Product.find({ _id: { $in: items.map((i) => i.product) }, org, active: true });
  const lines = items.map((i) => { const p = products.find((x) => String(x._id) === String(i.product)); return p && { p, qty: Number(i.qty), unitPrice: priceFor(p, branch) }; }).filter(Boolean);
  const r = priceBasket(lines, { promos: await activePromotions(org), manualDiscount: discount, channel: 'pos', branch });
  return { ...r, lines: r.lines.map((l) => ({ product: l.p._id, qty: l.qty, unitPrice: l.unitPrice, gross: l.gross, promoDiscount: l.promoDiscount, promoName: l.promoName, tax: l.tax, net: l.net })) };
};

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

const completeSale = async ({ user, org, branch, items, customerId, discount = 0, payments = [], prescriptionId, channel = 'pos', allowNoShift = false, clientId, offlineAt, allowShortfall = false, offlineRx = false }) => {
  if (!items?.length) throw bad('Add at least one item');
  if (clientId) {
    const dup = await Sale.findOne({ org, clientId });
    if (dup) return dup; // already synced: idempotent
  }
  const flags = [];
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
    if (!rx) throw conflict('Prescription not found');
    if (offlineRx && rxLines.some((l) => l.p.legalStatus === 'controlled')) throw conflict('Controlled drugs cannot be dispensed offline');
    if (!['verified', 'partial'].includes(rx.status)) {
      // Dispensed offline from a cached copy: the medicine has already been handed over, so record it and flag it.
      if (!offlineRx) throw conflict('Prescription is not verified');
      flags.push(`Prescription ${rx.rxNo} was "${rx.status}" when this offline dispensing synced`);
    }
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
  let pointsToRedeem = 0; let redeemedFrom = null;
  try {
    const saleItems = [];
    for (const { p, qty } of lines) {
      if (rx && RX_LEVELS.includes(p.legalStatus)) {
        try {
          if (offlineRx && !['verified', 'partial'].includes(rx.status)) throw conflict('not claimable');
          await claimRx(rx, p._id, qty);
          claimed.push({ product: p._id, qty });
        } catch (e) {
          if (!offlineRx) throw e;
          // NFR-05: cross-branch duplicate fills found after sync are flagged for review, not rejected.
          flags.push(`Possible duplicate or over-fill on ${rx.rxNo}: ${p.brand} x${qty} (${e.message === 'not claimable' ? 'prescription closed' : e.message})`);
          await Prescription.updateOne({ _id: rx._id, 'items.product': p._id }, { $inc: { 'items.$.dispensedQty': qty } });
        }
      }
      // Offline sales are already handed over, so we record what stock we have and flag the rest
      // for review instead of failing the sync.
      let takeQty = qty; let shortfall = 0;
      if (allowShortfall) {
        const have = await available(org, branch, p._id);
        takeQty = Math.min(qty, have); shortfall = qty - takeQty;
        if (shortfall) flags.push(`Stock shortfall on ${p.brand}: sold ${qty}, system had ${have}`);
      }
      const lots = takeQty > 0 ? await deductFefo({ org, branch, product: p._id, qty: takeQty, label: p.brand }) : [];
      taken.push(...lots);
      saleItems.push({
        product: p._id, name: `${p.brand}${p.strength ? ' ' + p.strength : ''}`, qty, shortfall, unitPrice: priceFor(p, branch), taxRate: p.taxRate,
        cost: lots.length ? round2(lots.reduce((s, l) => s + l.cost * l.qty, 0) / takeQty) : p.cost,
        lots: lots.map(({ batch, batchNo, expiry, qty: q }) => ({ batch, batchNo, expiry, qty: q })),
      });
    }

    // Promotions first, then the cashier's manual discount (limited by role) on what is left.
    const priced = priceBasket(lines.map(({ p, qty }) => ({ p, qty, unitPrice: priceFor(p, branch) })), { promos: await activePromotions(org), manualDiscount: discount, channel, branch });
    const limit = DISCOUNT_LIMIT[user.role] || 0;
    const disc = round2(Number(discount) || 0);
    if (disc < 0 || disc > priced.afterPromo * limit + 0.001) {
      throw forbidden(`Your role may give at most ${Math.round(limit * 100)}% discount on a sale`);
    }
    priced.lines.forEach((pl) => {
      const it = saleItems.find((x) => String(x.product) === String(pl.p._id));
      Object.assign(it, { lineTotal: pl.gross, promoDiscount: pl.promoDiscount, promoName: pl.promoName, tax: pl.tax, net: pl.net });
    });
    const { subtotal, tax, total } = priced;

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

    // Loyalty redemption (FR-CUS-04): points are taken atomically and given back if the sale fails.
    const loyalty = (await Organization.findById(org, 'settings.loyalty'))?.settings?.loyalty || {};
    const loyaltyAmount = round2(payments.filter((p) => p.method === 'loyalty').reduce((s, p) => s + Number(p.amount), 0));
    if (loyaltyAmount > 0) {
      if (!loyalty.enabled) throw conflict('Loyalty redemption is switched off');
      if (!customer) throw bad('Attach the customer to redeem points');
      if (loyaltyAmount > total + 0.001) throw bad('Points cannot pay more than the sale total');
      pointsToRedeem = Math.ceil(loyaltyAmount / loyalty.pointValue - 1e-9);
      if (pointsToRedeem < (loyalty.minRedeemPoints || 0)) throw bad(`At least ${loyalty.minRedeemPoints} points must be redeemed at a time`);
      const r = await Customer.updateOne({ _id: customer._id, loyaltyPoints: { $gte: pointsToRedeem } }, { $inc: { loyaltyPoints: -pointsToRedeem } });
      if (r.modifiedCount !== 1) { pointsToRedeem = 0; throw conflict(`${customer.name} does not have enough points`); }
      redeemedFrom = customer._id;
    }
    const pointsEarned = customer && loyalty.enabled !== false ? Math.floor((total - loyaltyAmount) * (loyalty.pointsPerCedi ?? 0.1)) : 0;

    const sale = await Sale.create({
      org, branch, receiptNo: seq('R'), cashier: user._id, customer: customer?._id, shift: shift?._id,
      prescription: rx?._id, channel, clientId, offlineAt, flags, items: saleItems, subtotal, discount: round2(disc + priced.promoDiscount), promoDiscount: priced.promoDiscount, tax, total,
      pointsEarned, pointsRedeemed: pointsToRedeem,
      payments: payments.map((p) => ({ method: p.method, amount: Number(p.amount), reference: p.reference })),
      changeGiven: change,
      ...(offlineAt && { createdAt: new Date(offlineAt) }),
    });

    if (creditAmount > 0) {
      await Customer.updateOne({ _id: customer._id }, { $inc: { balance: creditAmount } });
      await Ledger.create({ org, customer: customer._id, type: 'charge', amount: creditAmount, ref: sale.receiptNo, sale: sale._id, by: user._id });
    }
    if (pointsEarned > 0) await Customer.updateOne({ _id: customer._id }, { $inc: { loyaltyPoints: pointsEarned } });
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
    if (redeemedFrom && pointsToRedeem) await Customer.updateOne({ _id: redeemedFrom }, { $inc: { loyaltyPoints: pointsToRedeem } });
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
    amount += (item.net !== undefined && item.net !== null ? item.net / item.qty : item.lineTotal / item.qty + item.tax / item.qty) * qty;
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
  // Money paid with loyalty points goes back as points, in proportion to the refund.
  const loyaltyPaid = sale.payments.filter((p) => p.method === 'loyalty').reduce((s, p) => s + p.amount, 0);
  if (loyaltyPaid > 0 && sale.customer && sale.pointsRedeemed) {
    const back = Math.round(sale.pointsRedeemed * Math.min(1, amount / sale.total));
    if (back > 0) await Customer.updateOne({ _id: sale.customer }, { $inc: { loyaltyPoints: back } });
  }
  sale.refunds.push({ at: new Date(), by: user._id, reason, amount: round2(amount), lines: toReturn.map((l) => ({ product: l.product, qty: Number(l.qty) })) });
  const totalRefunded = sale.refunds.reduce((s, r) => s + r.amount, 0);
  sale.status = totalRefunded + 0.01 >= sale.total ? 'refunded' : 'partially_refunded';
  await sale.save();
  return sale;
};

module.exports = { completeSale, refundSale, quoteSale, refreshRxStatus, claimRx, unclaimRx, DISCOUNT_LIMIT, RX_LEVELS };

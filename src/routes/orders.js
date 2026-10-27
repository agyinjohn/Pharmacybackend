const router = require('express').Router();
const { Order, Prescription, Sale, Branch, User, Product } = require('../models');
const { wrap, bad, notFound, conflict, forbidden, round2, seq } = require('../utils/http');
const { staff, roles, branch, writable } = require('../middleware/auth');
const { audit } = require('../services/audit');
const { notify } = require('../services/notify');
const { deductFefo, restore, priceFor, available } = require('../services/stock');
const { claimRx, unclaimRx, refreshRxStatus } = require('../services/sales');
const payments = require('../services/payments');

// Money back to the customer on the original method (CP-PAY-03). Provider failures are recorded, not thrown.
const refundPayment = async (o) => {
  if (o.payment.status !== 'paid') return;
  o.payment.status = 'refunded';
  if (o.payment.provider === 'paystack') {
    try { await payments.refund(o.payment.reference); } catch (e) { o.history.push({ status: o.status, by: 'system', note: `Automatic refund failed (${e.message}); refund manually` }); }
  }
};

const ORDER_STAFF = ['pharmacist', 'technician', 'branch_manager', 'dispatcher'];

const loadOrder = async (req) => {
  const o = await Order.findOne({ _id: req.params.id, org: req.orgId }).populate('customer');
  if (!o) throw notFound('Order not found');
  if (!['owner', 'auditor'].includes(req.user.role) && !req.user.branches.map(String).includes(String(o.branch))) throw forbidden('Not your branch');
  return o;
};
const step = (o, status, req, note) => { o.status = status; o.history.push({ status, by: req.user.name, note }); };

router.get('/riders', roles(...ORDER_STAFF), wrap(async (req, res) => {
  const f = { org: req.orgId, role: 'dispatcher', active: true };
  if (req.user.role !== 'owner') f.branches = { $in: req.user.branches };
  res.json(await User.find(f, 'name phone'));
}));

router.get('/orders/alerts', branch(), wrap(async (req, res) => {
  const [review, received, ready, out] = await Promise.all(['pending_review', 'received', 'packed', 'out_for_delivery']
    .map((s) => Order.countDocuments({ org: req.orgId, branch: req.branchId, status: s })));
  res.json({ pendingReview: review, awaitingApproval: received, readyToDispatch: ready, outForDelivery: out });
}));

router.get('/orders', branch(false), roles(...ORDER_STAFF, 'accountant'), wrap(async (req, res) => {
  const f = { org: req.orgId };
  if (req.branchId) f.branch = req.branchId;
  else if (!['owner', 'auditor'].includes(req.user.role)) f.branch = { $in: req.user.branches };
  if (req.query.status) f.status = { $in: req.query.status.split(',') };
  res.json(await Order.find(f).populate('customer', 'name phone allergies').populate('branch', 'name').populate('prescription', 'rxNo status').sort('-createdAt').limit(200));
}));

router.get('/orders/:id', roles(...ORDER_STAFF), wrap(async (req, res) => {
  const o = await loadOrder(req);
  await o.populate([{ path: 'prescription' }, { path: 'branch', select: 'name' }]);
  if (o.prescription) await audit(req, 'rx.view', 'Prescription', o.prescription._id, `Viewed prescription ${o.prescription.rxNo} via order ${o.orderNo}`);
  res.json(o);
}));

// Approve: Rx items need a verified prescription; stock is reserved (taken FEFO) at this point.
router.post('/orders/:id/approve', roles('pharmacist', 'technician', 'branch_manager'), writable, wrap(async (req, res) => {
  const o = await loadOrder(req);
  if (!['received', 'pending_review'].includes(o.status)) throw conflict(`Order is ${o.status}`);
  if (o.payment.status === 'pending' && o.payment.method !== 'cod') throw conflict('Waiting for the customer to complete payment');
  const needsRx = o.items.some((i) => i.requiresRx);
  let rx = null;
  if (needsRx) {
    if (!req.user.isPharmacistInGoodStanding()) throw forbidden('Only a registered pharmacist can approve orders with prescription medicines');
    rx = await Prescription.findById(o.prescription);
    if (!rx || !['verified', 'partial'].includes(rx.status)) throw conflict('Verify the prescription first (Prescriptions tab)');
  }
  const claimed = []; const taken = [];
  try {
    for (const it of o.items) {
      if (it.requiresRx) { await claimRx(rx, it.product, it.qty); claimed.push(it); }
      if (o.stockReserved) continue; // already reserved when the order was placed (CP-ORD-06)
      const lots = await deductFefo({ org: req.orgId, branch: o.branch, product: it.product, qty: it.qty, label: it.name });
      taken.push(...lots);
      it.lots = lots.map(({ batch, batchNo, expiry, qty }) => ({ batch, batchNo, expiry, qty }));
    }
  } catch (e) {
    await restore(taken);
    for (const c of claimed) await unclaimRx(rx, c.product, c.qty);
    throw e;
  }
  if (rx) await refreshRxStatus(rx._id);
  if (rx) o.rxClaimed = true;
  o.stockReserved = true;
  step(o, 'approved', req);
  await o.save();
  await notify(o.customer, `Order ${o.orderNo} approved. We are preparing it now.`);
  await audit(req, 'order.approve', 'Order', o._id, `Approved order ${o.orderNo}`);
  res.json(o);
}));

router.post('/orders/:id/reject', roles('pharmacist', 'branch_manager'), writable, wrap(async (req, res) => {
  if (!(req.body.reason || '').trim()) throw bad('A reason is required');
  const o = await loadOrder(req);
  if (!['received', 'pending_review'].includes(o.status)) throw conflict(`Order is ${o.status}`);
  o.reviewNote = req.body.reason;
  await refundPayment(o); // CP-PAY-03
  step(o, 'rejected', req, req.body.reason);
  await o.save();
  if (o.prescription) await Prescription.updateOne({ _id: o.prescription, status: 'pending' }, { status: 'rejected', rejectedReason: req.body.reason });
  await notify(o.customer, `Order ${o.orderNo} could not be filled: ${req.body.reason}. Any payment will be refunded.`);
  await audit(req, 'order.reject', 'Order', o._id, `Rejected order ${o.orderNo}: ${req.body.reason}`);
  res.json(o);
}));

router.post('/orders/:id/message', roles('pharmacist'), writable, wrap(async (req, res) => {
  if (!req.body.text) throw bad('Message text is required');
  const o = await loadOrder(req);
  o.messages.push({ from: 'pharmacist', text: req.body.text });
  await o.save();
  await notify(o.customer, `Pharmacist on order ${o.orderNo}: ${req.body.text}`);
  await audit(req, 'order.message', 'Order', o._id, `Messaged customer about ${o.orderNo}`);
  res.json(o);
}));

// Pharmacist changes quantities, removes items or substitutes products before approval (CP-ORD-03).
// lines: the complete new item list [{ product, qty, substituteFor? }]. The customer is notified.
router.post('/orders/:id/edit', roles('pharmacist', 'branch_manager'), writable, wrap(async (req, res) => {
  const o = await loadOrder(req);
  if (!['received', 'pending_review'].includes(o.status)) throw conflict('Orders can only be changed before approval');
  if (o.stockReserved) throw conflict('Stock is already held for this order; cancel and ask the customer to re-order');
  const reason = (req.body.reason || '').trim();
  if (!reason) throw bad('Say why the order is being changed; the customer will see it');
  const lines = (req.body.lines || []).map((l) => ({ ...l, qty: Number(l.qty) })).filter((l) => l.qty > 0);
  if (!lines.length) throw bad('An order needs at least one item; reject it instead');
  const prods = await Product.find({ _id: { $in: lines.map((l) => l.product) }, org: req.orgId, active: true });
  const items = [];
  for (const l of lines) {
    const p = prods.find((x) => String(x._id) === String(l.product));
    if (!p || !Number.isInteger(l.qty)) throw bad('Invalid item');
    if (p.legalStatus === 'controlled') throw conflict(`${p.brand} cannot be supplied online`);
    const have = await available(req.orgId, o.branch, p._id);
    if (have < l.qty) throw conflict(`${p.brand}: only ${have} in stock at this branch`);
    items.push({ product: p._id, name: `${p.brand}${p.strength ? ' ' + p.strength : ''}`, qty: l.qty, unitPrice: priceFor(p, o.branch), taxRate: p.taxRate, requiresRx: p.legalStatus === 'prescription_only' });
  }
  const rxItems = items.filter((i) => i.requiresRx);
  let rx = o.prescription ? await Prescription.findById(o.prescription) : null;
  if (rxItems.length && !rx) throw conflict('A prescription is needed for prescription-only items; ask the customer to upload one');
  if (rx) {
    const same = (a, b) => a.length === b.length && a.every((x) => b.some((y) => String(y.product) === String(x.product) && y.qty === x.qty));
    if (!['pending'].includes(rx.status) && !same(rxItems, rx.items.map((i) => ({ product: i.product, qty: i.qty })))) {
      throw conflict('Prescription items can only be changed before the prescription is verified');
    }
    if (rx.status === 'pending') { rx.items = rxItems.map((i) => ({ product: i.product, name: i.name, qty: i.qty })); await rx.save(); }
  }
  const describe = (list) => list.map((i) => `${i.qty} x ${i.name}`).join(', ');
  const before = describe(o.items);
  const subtotal = round2(items.reduce((s, i) => s + i.unitPrice * i.qty, 0));
  const tax = round2(items.reduce((s, i) => s + i.unitPrice * i.qty * (i.taxRate || 0), 0));
  const total = round2(subtotal + tax + (o.deliveryFee || 0));
  if (o.payment.status === 'paid' && total > o.total + 0.001) throw conflict('The new total is higher than what the customer paid; message them to place an extra order instead');
  const refundDue = o.payment.status === 'paid' ? round2(o.total - total) : 0;
  if (refundDue > 0 && o.payment.provider === 'paystack') {
    try { await payments.refund(o.payment.reference, refundDue); } catch (e) { o.history.push({ status: o.status, by: 'system', note: `Partial refund of ${refundDue} failed (${e.message}); refund manually` }); }
  }
  o.items = items; o.subtotal = subtotal; o.tax = tax; o.total = total;
  if (refundDue > 0) o.payment.refundedAmount = round2((o.payment.refundedAmount || 0) + refundDue);
  if (o.status === 'pending_review' && !rxItems.length) o.status = 'received';
  o.history.push({ status: o.status, by: req.user.name, note: `Changed: ${reason}. Was ${before}; now ${describe(items)}${refundDue > 0 ? `. Refund ${refundDue}` : ''}` });
  await o.save();
  await notify(o.customer, `Your order ${o.orderNo} was changed by the pharmacist: ${reason}. New items: ${describe(items)}. New total GHS ${total.toFixed(2)}${refundDue > 0 ? `; GHS ${refundDue.toFixed(2)} will be refunded` : ''}. Reply or cancel in My orders if you do not agree.`);
  await audit(req, 'order.edit', 'Order', o._id, `Order ${o.orderNo} changed: ${reason}`, { before: { items: before }, after: { items: describe(items), total } });
  res.json(o);
}));

// Pass an unapproved order to another branch (MB-08).
router.post('/orders/:id/pass', roles('pharmacist', 'branch_manager'), writable, wrap(async (req, res) => {
  const o = await loadOrder(req);
  if (!['received', 'pending_review'].includes(o.status)) throw conflict('Only orders awaiting approval can be passed on');
  const target = await Branch.findOne({ _id: req.body.branch, org: req.orgId, active: true, onlineEnabled: true });
  if (!target) throw bad('Target branch not found or not online');
  o.passedFrom = o.branch; o.branch = target._id;
  o.history.push({ status: o.status, by: req.user.name, note: `Passed to ${target.name}` });
  await o.save();
  await audit(req, 'order.pass', 'Order', o._id, `Order ${o.orderNo} passed to ${target.name}`);
  res.json(o);
}));

router.post('/orders/:id/pack', roles('pharmacist', 'technician', 'branch_manager'), writable, wrap(async (req, res) => {
  const o = await loadOrder(req);
  if (o.status !== 'approved') throw conflict('Order must be approved before packing (CP-ORD-04)');
  step(o, 'packed', req);
  await o.save();
  await notify(o.customer, `Order ${o.orderNo} is packed${o.fulfilment === 'pickup' ? ' and ready for pickup' : ''}.`);
  res.json(o);
}));

// Dispatcher assigns an own rider or a third-party courier; delivery code is generated for the customer.
router.post('/orders/:id/dispatch', roles('dispatcher', 'branch_manager', 'pharmacist'), writable, wrap(async (req, res) => {
  const o = await loadOrder(req);
  if (o.status !== 'packed') throw conflict('Order must be packed first');
  if (o.fulfilment !== 'delivery') throw conflict('Pickup orders are handed over in store');
  const { riderId, courierName, courierPhone, trackingUrl } = req.body;
  if (riderId) {
    const r = await User.findOne({ _id: riderId, org: req.orgId, role: 'dispatcher', active: true });
    if (!r) throw bad('Rider not found');
    o.rider = { user: r._id, name: r.name, phone: r.phone, external: false };
  } else if (courierName) o.rider = { name: courierName, phone: courierPhone, external: true, trackingUrl };
  else throw bad('Choose a rider or enter a courier');
  o.deliveryCode = String(Math.floor(1000 + Math.random() * 9000));
  step(o, 'out_for_delivery', req, `Assigned to ${o.rider.name}`);
  await o.save();
  await notify(o.customer, `Order ${o.orderNo} is out for delivery with ${o.rider.name}. Give code ${o.deliveryCode} on arrival.`);
  await audit(req, 'order.dispatch', 'Order', o._id, `Order ${o.orderNo} dispatched with ${o.rider.name}`);
  res.json(o);
}));

// Live tracking (CP-DEL-05): the assigned rider's phone posts its position while out for delivery.
router.post('/orders/:id/location', roles('dispatcher'), wrap(async (req, res) => {
  const o = await Order.findOne({ _id: req.params.id, org: req.orgId, 'rider.user': req.user._id, status: 'out_for_delivery' });
  if (!o) throw notFound('No active delivery with that id assigned to you');
  const { lat, lng } = req.body;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw bad('Invalid position');
  o.rider.location = { lat, lng, at: new Date() };
  await o.save();
  res.json({ ok: true });
}));

// Riders see only their own tasks.
router.get('/rider/tasks', roles('dispatcher'), wrap(async (req, res) => {
  const f = { org: req.orgId, status: { $in: ['out_for_delivery'] } };
  if (req.user.role === 'dispatcher') f['rider.user'] = req.user._id;
  res.json(await Order.find(f, '-deliveryCode').populate('customer', 'name phone').populate('branch', 'name address phone').sort('createdAt'));
}));

// Proof of delivery: Rx orders require the customer's one-time code (CP-DEL-06).
router.post('/orders/:id/deliver', roles('dispatcher', 'branch_manager', 'pharmacist', 'technician', 'cashier'), writable, wrap(async (req, res) => {
  const o = await loadOrder(req);
  const handover = o.fulfilment === 'pickup' ? ['packed'] : ['out_for_delivery'];
  if (!handover.includes(o.status)) throw conflict(`Order is ${o.status}`);
  const { recipient, code, signature } = req.body;
  if (!recipient) throw bad('Recipient name is required');
  const needsCode = o.items.some((i) => i.requiresRx) || o.fulfilment === 'delivery';
  if (o.fulfilment === 'delivery' && needsCode && String(code) !== o.deliveryCode) throw conflict('Delivery code does not match the customer\'s code');
  o.proof = { recipient, signature, at: new Date() };
  if (o.payment.method === 'cod') o.payment.status = 'paid';
  step(o, 'delivered', req);
  await o.save();
  // Record revenue as an online sale; stock was already taken at approval.
  const subtotal = round2(o.items.reduce((s, i) => s + i.unitPrice * i.qty, 0));
  const tax = round2(o.items.reduce((s, i) => s + i.unitPrice * i.qty * (i.taxRate || 0), 0));
  await Sale.create({
    org: req.orgId, branch: o.branch, receiptNo: seq('W'), cashier: req.user._id, customer: o.customer._id, channel: 'online', prescription: o.prescription,
    items: o.items.map((i) => ({ product: i.product, name: i.name, qty: i.qty, unitPrice: i.unitPrice, taxRate: i.taxRate, tax: round2(i.unitPrice * i.qty * (i.taxRate || 0)), lineTotal: round2(i.unitPrice * i.qty), lots: i.lots })),
    subtotal, tax, total: round2(subtotal + tax + (o.deliveryFee || 0)), payments: [{ method: o.payment.method === 'cod' ? 'cash' : o.payment.method, amount: o.total, reference: o.payment.reference }],
  });
  await notify(o.customer, `Order ${o.orderNo} delivered. Thank you!`);
  await audit(req, 'order.deliver', 'Order', o._id, `Order ${o.orderNo} delivered to ${recipient}`);
  res.json(o);
}));

// Failed delivery: restock only when packaging and storage conditions are intact (CP-DEL-07).
router.post('/orders/:id/fail', roles('dispatcher', 'branch_manager', 'pharmacist'), writable, wrap(async (req, res) => {
  const o = await loadOrder(req);
  if (o.status !== 'out_for_delivery') throw conflict(`Order is ${o.status}`);
  if (!(req.body.reason || '').trim()) throw bad('A reason is required');
  if (req.body.restock) {
    await restore(o.items.flatMap((i) => i.lots.map((l) => ({ batch: l.batch, qty: l.qty }))));
    o.stockReserved = false;
  }
  step(o, 'failed', req, `${req.body.reason}${req.body.restock ? ' (returned to stock)' : ' (not restocked)'}`);
  await o.save();
  await notify(o.customer, `We could not deliver order ${o.orderNo}: ${req.body.reason}. We will contact you to reattempt.`);
  await audit(req, 'order.fail', 'Order', o._id, `Delivery failed for ${o.orderNo}: ${req.body.reason}`);
  res.json(o);
}));

router.post('/orders/:id/cancel', roles('pharmacist', 'branch_manager'), writable, wrap(async (req, res) => {
  const o = await loadOrder(req);
  const r = await cancelOrder(o, req.user.name, req.body.reason || 'Cancelled by pharmacy');
  await audit(req, 'order.cancel', 'Order', o._id, `Cancelled order ${o.orderNo}`);
  res.json(r);
}));

// Shared with the customer portal. Orders can be cancelled until they are packed (CP-ORD-08).
async function cancelOrder(o, by, reason) {
  if (!['received', 'pending_review', 'approved'].includes(o.status)) throw conflict('Order can no longer be cancelled');
  if (o.stockReserved) {
    await restore(o.items.flatMap((i) => i.lots.map((l) => ({ batch: l.batch, qty: l.qty }))));
    o.stockReserved = false;
    if (o.rxClaimed) {
      for (const i of o.items.filter((x) => x.requiresRx)) await unclaimRx({ _id: o.prescription }, i.product, i.qty);
      o.rxClaimed = false;
      await refreshRxStatus(o.prescription);
    }
  }
  await refundPayment(o);
  o.status = 'cancelled';
  o.history.push({ status: 'cancelled', by, note: reason });
  await o.save();
  return o;
}
router.cancelOrder = cancelOrder;

// Releases stock held for online orders whose payment never arrived (CP-ORD-06).
const releaseExpiredReservations = async () => {
  const stale = await Order.find({ stockReserved: true, status: { $in: ['received', 'pending_review'] }, 'payment.status': 'pending', 'payment.method': { $ne: 'cod' }, reservedUntil: { $lt: new Date() } }).populate('customer');
  for (const o of stale) {
    try { await cancelOrder(o, 'system', 'Payment not completed in time'); await notify(o.customer, `Order ${o.orderNo} was cancelled because payment was not completed in time.`); } catch (e) { console.error('reservation release failed', o.orderNo, e.message); }
  }
  return stale.length;
};
router.releaseExpiredReservations = releaseExpiredReservations;

module.exports = router;

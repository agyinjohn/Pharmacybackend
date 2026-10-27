const router = require('express').Router();
const { Sale, Shift, Customer, Product } = require('../models');
const { wrap, bad, notFound, conflict, escapeRegex, round2, seq } = require('../utils/http');
const { staff, roles, branch, writable } = require('../middleware/auth');
const { audit } = require('../services/audit');
const { completeSale, refundSale } = require('../services/sales');
const { priceFor } = require('../services/stock');

const POS = ['cashier', 'pharmacist', 'branch_manager', 'technician'];

// Product lookup for the sales screen: barcode scan or text search, price at this branch, stock on hand.
router.get('/pos/lookup', branch(), wrap(async (req, res) => {
  const { q, barcode } = req.query;
  const filter = { org: req.orgId, active: true };
  if (barcode) filter.barcode = barcode;
  else if (q) { const rx = new RegExp(escapeRegex(q), 'i'); filter.$or = [{ brand: rx }, { generic: rx }, { barcode: rx }]; } else return res.json([]);
  const products = await Product.find(filter).limit(20);
  const { Batch } = require('../models');
  const { oid } = require('../services/stock');
  const rows = await Batch.aggregate([
    { $match: { org: oid(req.orgId), branch: oid(req.branchId), status: 'active', qty: { $gt: 0 }, expiry: { $gt: new Date() }, product: { $in: products.map((p) => p._id) } } },
    { $group: { _id: '$product', qty: { $sum: '$qty' }, nextExpiry: { $min: '$expiry' } } },
  ]);
  const m = new Map(rows.map((r) => [String(r._id), r]));
  res.json(products.map((p) => ({ ...p.toObject(), price: priceFor(p, req.branchId), stock: m.get(String(p._id))?.qty || 0, nextExpiry: m.get(String(p._id))?.nextExpiry })));
}));

router.post('/sales', branch(), roles(...POS), writable, wrap(async (req, res) => {
  const { items, customer, discount, payments, prescription } = req.body;
  const sale = await completeSale({ user: req.user, org: req.orgId, branch: req.branchId, items, customerId: customer, discount, payments, prescriptionId: prescription });
  await audit(req, 'sale.create', 'Sale', sale._id, `Sale ${sale.receiptNo} total ${sale.total}`, { after: { total: sale.total, items: sale.items.length } });
  res.status(201).json(await sale.populate('branch cashier', 'name'));
}));

router.get('/sales', branch(false), wrap(async (req, res) => {
  const filter = { org: req.orgId, status: { $ne: 'held' } };
  if (req.branchId) filter.branch = req.branchId;
  else if (!['owner', 'auditor', 'accountant'].includes(req.user.role)) filter.branch = { $in: req.user.branches };
  if (req.user.role === 'cashier') filter.cashier = req.user._id;
  if (req.query.from || req.query.to) filter.createdAt = { ...(req.query.from && { $gte: new Date(req.query.from) }), ...(req.query.to && { $lte: new Date(req.query.to) }) };
  res.json(await Sale.find(filter).populate('cashier branch', 'name').populate('customer', 'name').sort('-createdAt').limit(Math.min(Number(req.query.limit) || 50, 300)));
}));

router.get('/sales/held', branch(), wrap(async (req, res) => res.json(await Sale.find({ org: req.orgId, branch: req.branchId, cashier: req.user._id, status: 'held' }).sort('-createdAt'))));

router.get('/sales/:id', wrap(async (req, res) => {
  const s = await Sale.findOne({ _id: req.params.id, org: req.orgId }).populate('cashier branch', 'name address phone receiptHeader taxId').populate('customer', 'name phone');
  if (!s) throw notFound();
  res.json(s);
}));

// Hold and recall (FR-POS-07): no stock is taken until the sale completes.
router.post('/sales/hold', branch(), roles(...POS), writable, wrap(async (req, res) => {
  const { items, customer } = req.body;
  if (!items?.length) throw bad('Nothing to hold');
  const prods = await Product.find({ _id: { $in: items.map((i) => i.product) }, org: req.orgId });
  const held = await Sale.create({
    org: req.orgId, branch: req.branchId, receiptNo: seq('HOLD'), cashier: req.user._id, customer, status: 'held',
    items: items.map((i) => { const p = prods.find((x) => String(x._id) === String(i.product)); return { product: p._id, name: p.brand, qty: Number(i.qty), unitPrice: priceFor(p, req.branchId) }; }),
  });
  res.status(201).json(held);
}));
router.delete('/sales/held/:id', branch(), roles(...POS), wrap(async (req, res) => {
  await Sale.deleteOne({ _id: req.params.id, org: req.orgId, branch: req.branchId, status: 'held', cashier: req.user._id });
  res.json({ ok: true });
}));

router.post('/sales/:id/refund', roles(...POS), writable, wrap(async (req, res) => {
  const sale = await Sale.findOne({ _id: req.params.id, org: req.orgId });
  if (!sale) throw notFound();
  if (req.user.role !== 'owner' && !req.user.branches.map(String).includes(String(sale.branch))) throw conflict('Not your branch');
  const days = (Date.now() - sale.createdAt) / 86400000;
  if (days > 14 && !['owner', 'branch_manager'].includes(req.user.role)) throw conflict('Refunds after 14 days need a manager');
  const updated = await refundSale({ user: req.user, sale, lines: req.body.lines, reason: req.body.reason });
  await audit(req, 'sale.refund', 'Sale', sale._id, `Refund on ${sale.receiptNo}: ${req.body.reason}`);
  res.json(updated);
}));

/* ---------- Shifts (FR-POS-06) ---------- */
router.get('/shifts/current', branch(), wrap(async (req, res) => res.json(await Shift.findOne({ org: req.orgId, branch: req.branchId, cashier: req.user._id, status: 'open' }))));
router.post('/shifts/open', branch(), roles('cashier', 'pharmacist', 'branch_manager'), writable, wrap(async (req, res) => {
  if (await Shift.exists({ org: req.orgId, branch: req.branchId, cashier: req.user._id, status: 'open' })) throw conflict('You already have an open shift');
  const s = await Shift.create({ org: req.orgId, branch: req.branchId, cashier: req.user._id, openingCash: Number(req.body.openingCash) || 0 });
  await audit(req, 'shift.open', 'Shift', s._id, `Shift opened with float ${s.openingCash}`);
  res.status(201).json(s);
}));
router.post('/shifts/close', branch(), roles('cashier', 'pharmacist', 'branch_manager'), writable, wrap(async (req, res) => {
  const s = await Shift.findOne({ org: req.orgId, branch: req.branchId, cashier: req.user._id, status: 'open' });
  if (!s) throw notFound('No open shift');
  const counted = Number(req.body.countedCash);
  if (!Number.isFinite(counted) || counted < 0) throw bad('Enter the counted cash');
  s.countedCash = counted; s.expectedCash = round2(s.openingCash + s.cashSales); s.variance = round2(counted - s.expectedCash);
  s.status = 'closed'; s.closedAt = new Date();
  await s.save();
  await audit(req, 'shift.close', 'Shift', s._id, `Shift closed, variance ${s.variance}`);
  res.json(s);
}));
router.get('/shifts', branch(false), roles('branch_manager', 'accountant', 'auditor'), wrap(async (req, res) => {
  const filter = { org: req.orgId };
  if (req.branchId) filter.branch = req.branchId;
  res.json(await Shift.find(filter).populate('cashier branch', 'name').sort('-openedAt').limit(100));
}));

/* ---------- Customers ---------- */
router.get('/customers', wrap(async (req, res) => {
  const filter = { org: req.orgId };
  if (req.query.q) { const rx = new RegExp(escapeRegex(req.query.q), 'i'); filter.$or = [{ name: rx }, { phone: rx }, { email: rx }]; }
  res.json(await Customer.find(filter, '-otp').sort('name').limit(100));
}));
router.get('/customers/:id', wrap(async (req, res) => {
  const c = await Customer.findOne({ _id: req.params.id, org: req.orgId }, '-otp');
  if (!c) throw notFound();
  await audit(req, 'customer.view', 'Customer', c._id, `Viewed customer record ${c.name}`);
  const { Prescription } = require('../models');
  res.json({ customer: c, prescriptions: await Prescription.find({ org: req.orgId, customer: c._id }).sort('-createdAt').limit(20) });
}));
router.post('/customers', writable, wrap(async (req, res) => {
  const { name, phone, email, allergies, conditions, addresses, consent, creditLimit } = req.body;
  if (!name || !phone) throw bad('Name and phone are required');
  const c = await Customer.create({
    org: req.orgId, name, phone, email, allergies, conditions, addresses,
    consent: consent ? { ...consent, at: new Date() } : undefined,
    creditLimit: ['owner', 'accountant', 'branch_manager'].includes(req.user.role) ? Number(creditLimit) || 0 : 0,
  });
  await audit(req, 'customer.create', 'Customer', c._id, `Customer ${c.name} created`);
  res.status(201).json(c);
}));
router.patch('/customers/:id', writable, wrap(async (req, res) => {
  const c = await Customer.findOne({ _id: req.params.id, org: req.orgId });
  if (!c) throw notFound();
  const before = c.toObject();
  ['name', 'phone', 'email', 'allergies', 'conditions', 'addresses'].forEach((k) => { if (req.body[k] !== undefined) c[k] = req.body[k]; });
  if (req.body.consent) c.consent = { ...req.body.consent, at: new Date() };
  if (req.body.creditLimit !== undefined && ['owner', 'accountant', 'branch_manager'].includes(req.user.role)) c.creditLimit = Number(req.body.creditLimit) || 0;
  await c.save();
  await audit(req, 'customer.update', 'Customer', c._id, `Customer ${c.name} updated`, { before, after: c.toObject() });
  res.json(c);
}));
router.post('/customers/:id/payments', roles('accountant', 'cashier', 'branch_manager'), writable, wrap(async (req, res) => {
  const amount = Number(req.body.amount);
  if (!(amount > 0)) throw bad('Enter an amount');
  const c = await Customer.findOneAndUpdate({ _id: req.params.id, org: req.orgId }, { $inc: { balance: -amount } }, { new: true });
  if (!c) throw notFound();
  await audit(req, 'customer.payment', 'Customer', c._id, `Received ${amount} on account from ${c.name}`);
  res.json(c);
}));

module.exports = router;

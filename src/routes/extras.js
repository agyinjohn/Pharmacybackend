const router = require('express').Router();
const {
  Prescription, Customer, Notification, Product, Batch, Sale, Supplier, PurchaseOrder, SupplierReturn,
} = require('../models');
const { wrap, bad, notFound, conflict, seq, round2 } = require('../utils/http');
const { roles, branch, writable } = require('../middleware/auth');
const { audit } = require('../services/audit');
const { notify } = require('../services/notify');
const { oid, reorderFor, registerEntry } = require('../services/stock');

/* ---------- Refill reminders (FR-RX-10, CP-NOT-02) ---------- */
router.post('/refill-reminders/send', roles('pharmacist', 'branch_manager'), writable, wrap(async (req, res) => {
  const weekAgo = new Date(Date.now() - 7 * 86400000);
  const list = await Prescription.find({ org: req.orgId, status: 'partial', customer: { $ne: null }, $or: [{ lastReminderAt: null }, { lastReminderAt: { $lt: weekAgo } }] }, '-image');
  let sent = 0; let skipped = 0;
  for (const rx of list) {
    const due = rx.items.filter((i) => i.dispensedQty < i.qty * (1 + rx.refillsAllowed));
    if (!due.length) continue;
    const c = await Customer.findById(rx.customer);
    const n = await notify(c, `Hello ${c.name}, your prescription ${rx.rxNo} (${due.map((i) => i.name).join(', ')}) has a refill available. Reply STOP to opt out.`, { event: 'refill', reminder: true });
    if (n?.status === 'sent') sent += 1; else skipped += 1;
    rx.lastReminderAt = new Date(); await rx.save();
  }
  await audit(req, 'rx.reminders', 'Prescription', null, `Refill reminders: ${sent} sent, ${skipped} skipped (no consent)`);
  res.json({ sent, skipped });
}));

router.get('/notifications', roles('branch_manager', 'accountant', 'pharmacist'), wrap(async (req, res) => {
  res.json(await Notification.find({ org: req.orgId }).populate('customer', 'name').sort('-createdAt').limit(200));
}));

/* ---------- Reorder suggestions from past sales (FR-INV-09) ---------- */
const suggestions = async (org, branchId, days = 30, coverDays = 14) => {
  const since = new Date(Date.now() - days * 86400000);
  const sold = await Sale.aggregate([
    { $match: { org: oid(org), branch: oid(branchId), status: { $in: ['completed', 'partially_refunded'] }, createdAt: { $gte: since } } },
    { $unwind: '$items' }, { $group: { _id: '$items.product', qty: { $sum: '$items.qty' } } },
  ]);
  const onHand = await Batch.aggregate([
    { $match: { org: oid(org), branch: oid(branchId), status: 'active', expiry: { $gt: new Date() }, qty: { $gt: 0 } } },
    { $group: { _id: '$product', qty: { $sum: '$qty' }, supplier: { $last: '$supplier' } } },
  ]);
  const lastSupplier = await Batch.aggregate([{ $match: { org: oid(org), branch: oid(branchId), supplier: { $ne: null } } }, { $sort: { createdAt: -1 } }, { $group: { _id: '$product', supplier: { $first: '$supplier' } } }]);
  const soldMap = new Map(sold.map((r) => [String(r._id), r.qty]));
  const qtyMap = new Map(onHand.map((r) => [String(r._id), r.qty]));
  const supMap = new Map(lastSupplier.map((r) => [String(r._id), r.supplier]));
  const products = await Product.find({ org, active: true });
  const out = [];
  for (const p of products) {
    const have = qtyMap.get(String(p._id)) || 0;
    const level = reorderFor(p, branchId);
    const daily = (soldMap.get(String(p._id)) || 0) / days;
    const target = Math.ceil(daily * coverDays) + level;
    if (have <= level || have < daily * 7) {
      const qty = Math.max(0, Math.ceil(target - have));
      if (qty > 0) out.push({ product: p._id, name: `${p.brand} ${p.strength || ''}`.trim(), onHand: have, reorderLevel: level, soldLast30: soldMap.get(String(p._id)) || 0, suggestedQty: qty, cost: p.cost, supplier: supMap.get(String(p._id)) || null });
    }
  }
  return out;
};

router.get('/inventory/reorder-suggestions', branch(), roles('store_officer', 'branch_manager', 'pharmacist'), wrap(async (req, res) => {
  const rows = await suggestions(req.orgId, req.branchId);
  const sups = await Supplier.find({ _id: { $in: rows.map((r) => r.supplier).filter(Boolean) } }, 'name');
  res.json(rows.map((r) => ({ ...r, supplierName: sups.find((s) => String(s._id) === String(r.supplier))?.name })));
}));

// One draft purchase order per supplier from the chosen suggestions.
router.post('/purchase-orders/from-suggestions', branch(), roles('store_officer', 'branch_manager'), writable, wrap(async (req, res) => {
  const { items, fallbackSupplier } = req.body;
  if (!items?.length) throw bad('Choose at least one item');
  const groups = new Map();
  for (const i of items) {
    const sup = i.supplier || fallbackSupplier;
    if (!sup) throw bad(`${i.name}: no supplier, pick a default supplier`);
    if (!groups.has(String(sup))) groups.set(String(sup), []);
    groups.get(String(sup)).push(i);
  }
  const made = [];
  for (const [sup, lines] of groups) {
    if (!(await Supplier.exists({ _id: sup, org: req.orgId }))) throw bad('Unknown supplier');
    const clean = lines.map((l) => ({ product: l.product, name: l.name, qty: Number(l.suggestedQty), cost: Number(l.cost) || 0 }));
    made.push(await PurchaseOrder.create({ org: req.orgId, branch: req.branchId, poNo: seq('PO'), supplier: sup, items: clean, total: round2(clean.reduce((s, l) => s + l.qty * l.cost, 0)), createdBy: req.user._id }));
  }
  await audit(req, 'po.from_suggestions', 'PurchaseOrder', null, `Created ${made.length} draft purchase order(s) from reorder suggestions`);
  res.status(201).json(made);
}));

/* ---------- Returns to supplier and credit notes (FR-PUR-05) ---------- */
router.get('/supplier-returns', roles('store_officer', 'branch_manager', 'accountant'), wrap(async (req, res) => {
  res.json(await SupplierReturn.find({ org: req.orgId }).populate('supplier', 'name').sort('-createdAt').limit(100));
}));

router.post('/supplier-returns', branch(), roles('store_officer', 'branch_manager'), writable, wrap(async (req, res) => {
  const { supplier, items, reason } = req.body;
  if (!supplier || !items?.length || !(reason || '').trim()) throw bad('Supplier, items and a reason are required');
  const s = await Supplier.findOne({ _id: supplier, org: req.orgId });
  if (!s) throw notFound('Supplier not found');
  const lines = []; const taken = [];
  try {
    for (const i of items) {
      const qty = Number(i.qty);
      if (!(qty > 0)) throw bad('Invalid quantity');
      const b = await Batch.findOne({ _id: i.batch, org: req.orgId, branch: req.branchId });
      if (!b) throw notFound('Batch not found at this branch');
      const r = await Batch.updateOne({ _id: b._id, qty: { $gte: qty } }, { $inc: { qty: -qty } });
      if (r.modifiedCount !== 1) throw conflict(`Only ${b.qty} available in batch ${b.batchNo}`);
      taken.push({ id: b._id, qty });
      const p = await Product.findById(b.product);
      if (p.legalStatus === 'controlled') await registerEntry({ org: req.orgId, branch: req.branchId, product: p._id, productName: p.brand, type: 'supply', qty, counterparty: `Return to ${s.name}`, batchNo: b.batchNo, pharmacist: req.user._id, pharmacistName: req.user.name, note: reason });
      lines.push({ product: p._id, name: p.brand, batchNo: b.batchNo, qty, cost: b.cost });
    }
  } catch (e) { for (const t of taken) await Batch.updateOne({ _id: t.id }, { $inc: { qty: t.qty } }); throw e; }
  const total = round2(lines.reduce((x, l) => x + l.qty * l.cost, 0));
  const ret = await SupplierReturn.create({ org: req.orgId, branch: req.branchId, supplier, creditNoteNo: seq('CN'), items: lines, reason, total, createdBy: req.user._id });
  await Supplier.updateOne({ _id: supplier }, { $inc: { balance: -total } });
  await audit(req, 'supplier.return', 'SupplierReturn', ret._id, `Returned goods worth ${total} to ${s.name} (${ret.creditNoteNo}): ${reason}`);
  res.status(201).json(ret);
}));

/* ---------- Privacy: erasure requests (REG-17) ---------- */
router.get('/privacy/erasure-requests', roles('branch_manager'), wrap(async (req, res) => {
  res.json(await Customer.find({ org: req.orgId, erasureRequestedAt: { $ne: null }, anonymizedAt: null }, 'name phone email erasureRequestedAt'));
}));

// Anonymises personal data but never removes records the pharmacy must keep: prescriptions and
// controlled-drug register entries stay for the retention period.
router.post('/privacy/erasure/:customerId', roles('branch_manager'), writable, wrap(async (req, res) => {
  const c = await Customer.findOne({ _id: req.params.customerId, org: req.orgId });
  if (!c) throw notFound();
  const { Organization } = require('../models');
  const { anonymizeCustomer } = require('../services/privacy');
  const before = { name: c.name };
  await anonymizeCustomer(c, (await Organization.findById(req.orgId)).settings.retentionYears);
  await audit(req, 'privacy.erase', 'Customer', c._id, 'Customer personal data anonymised on request', { before });
  res.json({ ok: true });
}));

module.exports = router;

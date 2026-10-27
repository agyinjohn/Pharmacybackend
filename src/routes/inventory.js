const router = require('express').Router();
const { Product, Batch, PurchaseOrder, Supplier, StockTransfer } = require('../models');
const { wrap, bad, notFound, conflict, seq, round2 } = require('../utils/http');
const { staff, roles, branch, writable } = require('../middleware/auth');
const { audit } = require('../services/audit');
const { addBatch, registerEntry, reorderFor, oid, deductFefo, restore } = require('../services/stock');

const daysFromNow = (d) => new Date(Date.now() + d * 86400000);
const INV_ROLES = ['store_officer', 'branch_manager', 'pharmacist', 'technician'];

// Stock on hand per product for the selected branch, with low-stock and expiry flags.
router.get('/inventory', branch(), wrap(async (req, res) => {
  const now = new Date();
  const near = daysFromNow(90);
  const rows = await Batch.aggregate([
    { $match: { org: oid(req.orgId), branch: oid(req.branchId), qty: { $gt: 0 } } },
    {
      $group: {
        _id: '$product',
        qty: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'active'] }, { $gt: ['$expiry', now] }] }, '$qty', 0] } },
        expired: { $sum: { $cond: [{ $lte: ['$expiry', now] }, '$qty', 0] } },
        quarantined: { $sum: { $cond: [{ $eq: ['$status', 'quarantined'] }, '$qty', 0] } },
        nearExpiry: { $sum: { $cond: [{ $and: [{ $gt: ['$expiry', now] }, { $lte: ['$expiry', near] }] }, '$qty', 0] } },
        nextExpiry: { $min: '$expiry' },
        value: { $sum: { $multiply: ['$qty', '$cost'] } },
        batches: { $sum: 1 },
      },
    },
  ]);
  const products = await Product.find({ org: req.orgId, active: true }).sort('brand');
  const map = new Map(rows.map((r) => [String(r._id), r]));
  let list = products.map((p) => {
    const r = map.get(String(p._id)) || { qty: 0, expired: 0, quarantined: 0, nearExpiry: 0, value: 0, batches: 0 };
    const reorder = reorderFor(p, req.branchId);
    return { product: p, ...r, _id: undefined, reorderLevel: reorder, low: r.qty <= reorder };
  });
  if (req.query.filter === 'low') list = list.filter((r) => r.low);
  if (req.query.filter === 'expiring') list = list.filter((r) => r.nearExpiry > 0 || r.expired > 0);
  if (req.query.q) { const q = req.query.q.toLowerCase(); list = list.filter((r) => `${r.product.brand} ${r.product.generic || ''}`.toLowerCase().includes(q)); }
  res.json(list);
}));

router.get('/inventory/batches', branch(), wrap(async (req, res) => {
  const filter = { org: req.orgId, branch: req.branchId, qty: { $gt: 0 } };
  if (req.query.product) filter.product = req.query.product;
  if (req.query.within) filter.expiry = { $lte: daysFromNow(Number(req.query.within)) };
  res.json(await Batch.find(filter).populate('product', 'brand generic strength legalStatus').sort('expiry').limit(500));
}));

// Alerts: low stock and expiry tiers (90/60/30 by default), expired stock and licence warnings.
router.get('/inventory/alerts', branch(), wrap(async (req, res) => {
  const now = new Date();
  const tiers = {};
  for (const d of [90, 60, 30]) {
    tiers[d] = await Batch.countDocuments({ org: req.orgId, branch: req.branchId, qty: { $gt: 0 }, status: 'active', expiry: { $gt: now, $lte: daysFromNow(d) } });
  }
  const expired = await Batch.countDocuments({ org: req.orgId, branch: req.branchId, qty: { $gt: 0 }, expiry: { $lte: now } });
  const quarantined = await Batch.countDocuments({ org: req.orgId, branch: req.branchId, qty: { $gt: 0 }, status: 'quarantined' });
  const licenceDays = req.branch.licenseExpiry ? Math.ceil((req.branch.licenseExpiry - now) / 86400000) : null;
  res.json({ expiring: tiers, expired, quarantined, licenceDays });
}));

// Where else is this product in stock? (MB-03, read-only view of other branches)
router.get('/inventory/network/:productId', wrap(async (req, res) => {
  const rows = await Batch.aggregate([
    { $match: { org: oid(req.orgId), product: oid(req.params.productId), status: 'active', qty: { $gt: 0 }, expiry: { $gt: new Date() } } },
    { $group: { _id: '$branch', qty: { $sum: '$qty' } } },
  ]);
  const { Branch } = require('../models');
  const branches = await Branch.find({ _id: { $in: rows.map((r) => r._id) } }, 'name code');
  res.json(rows.map((r) => ({ branch: branches.find((b) => String(b._id) === String(r._id)), qty: r.qty })));
}));

// Goods receipt (without a PO) - FR-INV-05.
router.post('/inventory/receive', branch(), roles(...INV_ROLES), writable, wrap(async (req, res) => {
  const { supplier, invoiceNo, items } = req.body;
  if (!items?.length) throw bad('Add at least one line');
  const received = [];
  for (const i of items) {
    const p = await Product.findOne({ _id: i.product, org: req.orgId });
    if (!p) throw bad('Unknown product');
    if (!i.batchNo || !i.expiry || !(Number(i.qty) > 0)) throw bad(`Batch number, expiry and quantity are required for ${p.brand}`);
    if (new Date(i.expiry) <= new Date()) throw bad(`${p.brand}: cannot receive stock that has already expired`);
    const b = await addBatch({ org: req.orgId, branch: req.branchId, product: p._id, batchNo: i.batchNo, expiry: i.expiry, qty: Number(i.qty), cost: Number(i.cost || 0), supplier });
    if (p.legalStatus === 'controlled') {
      let sname;
      if (supplier) sname = (await Supplier.findById(supplier))?.name;
      await registerEntry({ org: req.orgId, branch: req.branchId, product: p._id, productName: p.brand, type: 'receipt', qty: Number(i.qty), counterparty: sname, batchNo: i.batchNo, pharmacist: req.user._id, pharmacistName: req.user.name, note: invoiceNo });
    }
    received.push(b);
  }
  await audit(req, 'stock.receive', 'Batch', null, `Received ${items.length} line(s)${invoiceNo ? ` on invoice ${invoiceNo}` : ''}`);
  res.status(201).json(received);
}));

// Stock adjustment: mandatory reason; large write-offs need manager approval (FR-INV-06).
router.post('/inventory/adjust', branch(), roles(...INV_ROLES), writable, wrap(async (req, res) => {
  const { batch, newQty, reason, witness } = req.body;
  if (!reason || !reason.trim()) throw bad('A reason is required');
  const b = await Batch.findOne({ _id: batch, org: req.orgId, branch: req.branchId });
  if (!b) throw notFound('Batch not found');
  const target = Number(newQty);
  if (!Number.isFinite(target) || target < 0) throw bad('Invalid quantity');
  const delta = target - b.qty;
  const p = await Product.findById(b.product);
  const writeOffValue = Math.abs(delta) * b.cost;
  const approver = ['owner', 'branch_manager'].includes(req.user.role);
  if (delta < 0 && !approver && (writeOffValue > 200 || p.legalStatus === 'controlled')) {
    throw conflict('This write-off needs approval from a branch manager or owner');
  }
  const before = b.qty;
  b.qty = target;
  await b.save();
  if (p.legalStatus === 'controlled' && delta !== 0) {
    await registerEntry({ org: req.orgId, branch: req.branchId, product: p._id, productName: p.brand, type: delta < 0 ? 'disposal' : 'correction', qty: Math.abs(delta), batchNo: b.batchNo, pharmacist: req.user._id, pharmacistName: req.user.name, witness, note: reason });
  }
  await audit(req, 'stock.adjust', 'Batch', b._id, `${p.brand} batch ${b.batchNo}: ${before} -> ${target} (${reason})`, { before: { qty: before }, after: { qty: target } });
  res.json(b);
}));

// Recall / quarantine and trace (FR-INV-07).
router.post('/inventory/quarantine', branch(false), roles('pharmacist', 'branch_manager', 'store_officer'), writable, wrap(async (req, res) => {
  const { product, batchNo, reason, release } = req.body;
  if (!product || !batchNo) throw bad('Product and batch number are required');
  if (!release && !reason) throw bad('A reason is required');
  const filter = { org: req.orgId, product, batchNo };
  if (req.user.role !== 'owner') filter.branch = { $in: req.user.branches };
  const r = await Batch.updateMany(filter, release ? { status: 'active', quarantineReason: null } : { status: 'quarantined', quarantineReason: reason });
  await audit(req, release ? 'stock.release' : 'stock.quarantine', 'Batch', null, `Batch ${batchNo} ${release ? 'released' : 'quarantined'}: ${reason || ''}`);
  res.json({ matched: r.matchedCount });
}));

router.get('/inventory/trace', wrap(async (req, res) => {
  const { product, batchNo } = req.query;
  if (!product || !batchNo) throw bad('Product and batch number are required');
  const { Sale, Branch } = require('../models');
  const sales = await Sale.find({ org: req.orgId, 'items.product': product, 'items.lots.batchNo': batchNo }).populate('customer', 'name phone').populate('branch', 'name').sort('-createdAt').limit(200);
  const holders = await Batch.find({ org: req.orgId, product, batchNo }).populate('branch', 'name');
  const transfers = await StockTransfer.find({ org: req.orgId, 'items.product': product, 'items.lots.batchNo': batchNo }).populate('from to', 'name');
  void Branch;
  res.json({
    branchesHolding: holders.map((h) => ({ branch: h.branch, qty: h.qty, status: h.status })),
    customers: sales.map((s) => ({ receiptNo: s.receiptNo, at: s.createdAt, branch: s.branch, customer: s.customer })),
    transfers: transfers.map((t) => ({ ref: t.ref, from: t.from, to: t.to, status: t.status })),
  });
}));

/* ---------- Suppliers ---------- */
router.get('/suppliers', roles('store_officer', 'branch_manager', 'accountant', 'pharmacist'), wrap(async (req, res) => {
  const list = await Supplier.find({ org: req.orgId }).sort('name');
  res.json(list.map((s) => ({ ...s.toObject(), licenceExpiringSoon: !!s.licenseExpiry && s.licenseExpiry < daysFromNow(60) })));
}));
router.post('/suppliers', roles('store_officer', 'branch_manager', 'accountant'), writable, wrap(async (req, res) => {
  const s = await Supplier.create({ ...req.body, org: req.orgId, balance: 0 });
  await audit(req, 'supplier.create', 'Supplier', s._id, `Supplier ${s.name} created`);
  res.status(201).json(s);
}));
router.patch('/suppliers/:id', roles('store_officer', 'branch_manager', 'accountant'), writable, wrap(async (req, res) => {
  const { balance, org, ...rest } = req.body;
  const s = await Supplier.findOneAndUpdate({ _id: req.params.id, org: req.orgId }, rest, { new: true });
  if (!s) throw notFound();
  res.json(s);
}));
router.post('/suppliers/:id/payments', roles('accountant', 'branch_manager'), writable, wrap(async (req, res) => {
  const amount = Number(req.body.amount);
  if (!(amount > 0)) throw bad('Enter a payment amount');
  const s = await Supplier.findOneAndUpdate({ _id: req.params.id, org: req.orgId }, { $inc: { balance: -amount } }, { new: true });
  if (!s) throw notFound();
  await audit(req, 'supplier.payment', 'Supplier', s._id, `Paid ${amount} to ${s.name}`);
  res.json(s);
}));

/* ---------- Purchase orders ---------- */
router.get('/purchase-orders', branch(false), roles('store_officer', 'branch_manager', 'accountant', 'pharmacist'), wrap(async (req, res) => {
  const filter = { org: req.orgId };
  if (req.branchId) filter.branch = req.branchId;
  else if (req.user.role !== 'owner') filter.branch = { $in: req.user.branches };
  res.json(await PurchaseOrder.find(filter).populate('supplier', 'name').populate('branch', 'name').sort('-createdAt').limit(200));
}));

router.post('/purchase-orders', branch(), roles('store_officer', 'branch_manager'), writable, wrap(async (req, res) => {
  const { supplier, items } = req.body;
  if (!supplier || !items?.length) throw bad('Supplier and at least one line are required');
  if (!(await Supplier.exists({ _id: supplier, org: req.orgId }))) throw bad('Unknown supplier');
  const prods = await Product.find({ _id: { $in: items.map((i) => i.product) }, org: req.orgId });
  const lines = items.map((i) => {
    const p = prods.find((x) => String(x._id) === String(i.product));
    if (!p || !(Number(i.qty) > 0)) throw bad('Invalid purchase order line');
    return { product: p._id, name: p.brand, qty: Number(i.qty), cost: Number(i.cost ?? p.cost) };
  });
  const po = await PurchaseOrder.create({
    org: req.orgId, branch: req.branchId, poNo: seq('PO'), supplier, items: lines,
    total: round2(lines.reduce((s, l) => s + l.qty * l.cost, 0)), createdBy: req.user._id,
  });
  await audit(req, 'po.create', 'PurchaseOrder', po._id, `Purchase order ${po.poNo} created`);
  res.status(201).json(po);
}));

// Approval limits by role (FR-PUR-02).
const PO_LIMIT = { store_officer: 0, branch_manager: 5000, accountant: 20000, owner: Infinity };
router.post('/purchase-orders/:id/approve', roles('branch_manager', 'accountant'), writable, wrap(async (req, res) => {
  const po = await PurchaseOrder.findOne({ _id: req.params.id, org: req.orgId });
  if (!po) throw notFound();
  if (po.status !== 'draft') throw conflict('Only draft orders can be approved');
  if (po.total > (PO_LIMIT[req.user.role] ?? 0)) throw conflict(`Orders above ${PO_LIMIT[req.user.role]} need a higher approver`);
  po.status = 'approved'; po.approvedBy = req.user._id;
  await po.save();
  await audit(req, 'po.approve', 'PurchaseOrder', po._id, `Purchase order ${po.poNo} approved`);
  res.json(po);
}));
router.post('/purchase-orders/:id/send', roles('store_officer', 'branch_manager'), writable, wrap(async (req, res) => {
  const po = await PurchaseOrder.findOne({ _id: req.params.id, org: req.orgId });
  if (!po) throw notFound();
  if (po.status !== 'approved') throw conflict('Approve the order first');
  po.status = 'sent'; await po.save();
  await audit(req, 'po.send', 'PurchaseOrder', po._id, `Purchase order ${po.poNo} sent`);
  res.json(po);
}));

// Receive against the PO with batch/expiry/cost; raises the supplier balance by the invoice value.
router.post('/purchase-orders/:id/receive', roles(...INV_ROLES), writable, wrap(async (req, res) => {
  const po = await PurchaseOrder.findOne({ _id: req.params.id, org: req.orgId });
  if (!po) throw notFound();
  if (!['sent', 'approved', 'partial'].includes(po.status)) throw conflict('This order is not open for receiving');
  if (req.user.role !== 'owner' && !req.user.branches.map(String).includes(String(po.branch))) throw conflict('Not your branch');
  const { lines, invoiceNo, invoiceTotal } = req.body;
  if (!lines?.length) throw bad('Nothing to receive');
  let invoiceValue = 0;
  for (const l of lines) {
    const item = po.items.id(l.item);
    const qty = Number(l.qty);
    if (!item || !(qty > 0)) throw bad('Invalid receipt line');
    if (item.receivedQty + qty > item.qty * 1.1) throw bad(`${item.name}: receiving more than ordered`);
    if (!l.batchNo || !l.expiry) throw bad(`${item.name}: batch number and expiry are required`);
    if (new Date(l.expiry) <= new Date()) throw bad(`${item.name}: expired stock cannot be received`);
    const p = await Product.findById(item.product);
    await addBatch({ org: req.orgId, branch: po.branch, product: item.product, batchNo: l.batchNo, expiry: l.expiry, qty, cost: item.cost, supplier: po.supplier });
    if (p.legalStatus === 'controlled') {
      const sup = await Supplier.findById(po.supplier);
      await registerEntry({ org: req.orgId, branch: po.branch, product: p._id, productName: p.brand, type: 'receipt', qty, counterparty: sup?.name, batchNo: l.batchNo, pharmacist: req.user._id, pharmacistName: req.user.name, note: `PO ${po.poNo}` });
    }
    item.receivedQty += qty;
    invoiceValue += qty * item.cost;
  }
  // Three-way match: supplier invoice total vs what was actually received at PO cost (FR-PUR-03).
  const mismatch = invoiceTotal !== undefined && invoiceTotal !== '' && Math.abs(Number(invoiceTotal) - invoiceValue) > Math.max(1, invoiceValue * 0.01);
  po.receipts.push({ at: new Date(), by: req.user._id, invoiceNo, invoiceTotal: invoiceTotal === '' ? undefined : Number(invoiceTotal), receivedValue: round2(invoiceValue), mismatch });
  po.status = po.items.every((i) => i.receivedQty >= i.qty) ? 'received' : 'partial';
  await po.save();
  await Supplier.updateOne({ _id: po.supplier }, { $inc: { balance: round2(invoiceValue) } });
  await audit(req, 'po.receive', 'PurchaseOrder', po._id, `Received against ${po.poNo}${invoiceNo ? ` (invoice ${invoiceNo})` : ''}${mismatch ? ' - INVOICE MISMATCH' : ''}`);
  res.json(po);
}));

/* ---------- Inter-branch transfers (MB-04) ---------- */
router.get('/transfers', roles(...INV_ROLES, 'accountant'), wrap(async (req, res) => {
  const filter = { org: req.orgId };
  if (req.user.role !== 'owner') filter.$or = [{ from: { $in: req.user.branches } }, { to: { $in: req.user.branches } }];
  res.json(await StockTransfer.find(filter).populate('from to', 'name code').sort('-createdAt').limit(200));
}));

// The receiving branch requests; the sending branch approves and dispatches.
router.post('/transfers', roles(...INV_ROLES), writable, wrap(async (req, res) => {
  const { from, to, items, note } = req.body;
  if (!from || !to || String(from) === String(to)) throw bad('Choose two different branches');
  if (!items?.length) throw bad('Add at least one item');
  if (req.user.role !== 'owner' && !req.user.branches.map(String).includes(String(to)) && !req.user.branches.map(String).includes(String(from))) throw conflict('You must belong to one of the branches');
  const { Branch } = require('../models');
  if ((await Branch.countDocuments({ _id: { $in: [from, to] }, org: req.orgId })) !== 2) throw bad('Unknown branch');
  const prods = await Product.find({ _id: { $in: items.map((i) => i.product) }, org: req.orgId });
  const t = await StockTransfer.create({
    org: req.orgId, ref: seq('TR'), from, to, note, requestedBy: req.user._id,
    items: items.map((i) => {
      const p = prods.find((x) => String(x._id) === String(i.product));
      if (!p || !(Number(i.qty) > 0)) throw bad('Invalid transfer line');
      return { product: p._id, name: p.brand, qty: Number(i.qty) };
    }),
  });
  await audit(req, 'transfer.request', 'StockTransfer', t._id, `Transfer ${t.ref} requested`);
  res.status(201).json(t);
}));

const canActFor = (req, branchId) => req.user.role === 'owner' || req.user.branches.map(String).includes(String(branchId));

// Sending branch approves and dispatches in one step: stock leaves with batch and expiry captured.
router.post('/transfers/:id/dispatch', roles(...INV_ROLES), writable, wrap(async (req, res) => {
  const t = await StockTransfer.findOne({ _id: req.params.id, org: req.orgId });
  if (!t) throw notFound();
  if (!canActFor(req, t.from)) throw conflict('Only the sending branch can dispatch');
  if (!['requested', 'approved'].includes(t.status)) throw conflict('Transfer is not awaiting dispatch');
  const taken = [];
  try {
    for (const item of t.items) {
      const lots = await deductFefo({ org: req.orgId, branch: t.from, product: item.product, qty: item.qty, label: item.name });
      taken.push(...lots);
      item.lots = lots.map((l) => ({ batchNo: l.batchNo, expiry: l.expiry, qty: l.qty, cost: l.cost }));
      const p = await Product.findById(item.product);
      if (p.legalStatus === 'controlled') {
        for (const l of lots) {
          await registerEntry({ org: req.orgId, branch: t.from, product: p._id, productName: p.brand, type: 'supply', qty: l.qty, counterparty: `Transfer ${t.ref}`, batchNo: l.batchNo, pharmacist: req.user._id, pharmacistName: req.user.name });
        }
      }
    }
  } catch (e) { await restore(taken); throw e; }
  t.status = 'in_transit'; t.approvedBy = req.user._id;
  await t.save();
  await audit(req, 'transfer.dispatch', 'StockTransfer', t._id, `Transfer ${t.ref} dispatched`);
  res.json(t);
}));

router.post('/transfers/:id/reject', roles(...INV_ROLES), writable, wrap(async (req, res) => {
  const t = await StockTransfer.findOne({ _id: req.params.id, org: req.orgId });
  if (!t) throw notFound();
  if (!canActFor(req, t.from)) throw conflict('Only the sending branch can reject');
  if (t.status !== 'requested') throw conflict('Only requested transfers can be rejected');
  t.status = 'rejected'; t.note = req.body.reason || t.note; await t.save();
  await audit(req, 'transfer.reject', 'StockTransfer', t._id, `Transfer ${t.ref} rejected`);
  res.json(t);
}));

// Receiving branch confirms counts; any difference from what was sent is flagged (variance).
router.post('/transfers/:id/receive', roles(...INV_ROLES), writable, wrap(async (req, res) => {
  const t = await StockTransfer.findOne({ _id: req.params.id, org: req.orgId });
  if (!t) throw notFound();
  if (!canActFor(req, t.to)) throw conflict('Only the receiving branch can receive');
  if (t.status !== 'in_transit') throw conflict('Transfer is not in transit');
  const counts = new Map((req.body.items || []).map((i) => [String(i.product), Number(i.receivedQty)]));
  for (const item of t.items) {
    const got = counts.has(String(item.product)) ? counts.get(String(item.product)) : item.qty;
    if (!(got >= 0) || got > item.qty) throw bad(`${item.name}: received quantity must be between 0 and ${item.qty}`);
    item.receivedQty = got;
    if (got !== item.qty) t.hasVariance = true;
    let left = got;
    const p = await Product.findById(item.product);
    for (const l of item.lots) {
      const put = Math.min(l.qty, left);
      if (put <= 0) continue;
      await addBatch({ org: req.orgId, branch: t.to, product: item.product, batchNo: l.batchNo, expiry: l.expiry, qty: put, cost: l.cost });
      if (p.legalStatus === 'controlled') {
        await registerEntry({ org: req.orgId, branch: t.to, product: p._id, productName: p.brand, type: 'receipt', qty: put, counterparty: `Transfer ${t.ref}`, batchNo: l.batchNo, pharmacist: req.user._id, pharmacistName: req.user.name });
      }
      left -= put;
    }
  }
  t.status = 'received'; t.receivedBy = req.user._id;
  await t.save();
  await audit(req, 'transfer.receive', 'StockTransfer', t._id, `Transfer ${t.ref} received${t.hasVariance ? ' WITH VARIANCE' : ''}`);
  res.json(t);
}));

module.exports = router;

const router = require('express').Router();
const { Sale, Batch, Order, Supplier, PurchaseOrder, Prescription, Branch, AuditLog } = require('../models');
const { wrap, bad, sendRows, round2 } = require('../utils/http');
const { staff, roles, userBranchIds } = require('../middleware/auth');
const { oid } = require('../services/stock');
const { audit } = require('../services/audit');

const REPORT_ROLES = ['branch_manager', 'accountant', 'auditor', 'pharmacist', 'store_officer'];

// Branches this request covers: a chosen one (if permitted) or all the user may see (MB-07).
const branchScope = async (req) => {
  const allowed = userBranchIds(req.user);
  let ids = (await Branch.find({ org: req.orgId }, '_id')).map((b) => String(b._id));
  if (allowed) ids = ids.filter((i) => allowed.includes(i));
  const want = req.query.branch;
  if (want && want !== 'all') {
    if (!ids.includes(String(want))) throw bad('You cannot report on that branch');
    ids = [String(want)];
  }
  return ids.map(oid);
};
const range = (req) => {
  const to = req.query.to ? new Date(req.query.to) : new Date();
  const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 30 * 86400000);
  if (req.query.to && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to)) to.setHours(23, 59, 59, 999);
  return { from, to };
};
const startOfDay = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const done = ['completed', 'partially_refunded'];

// Owner dashboard: today's sales, low stock, expiring stock and pending orders for all branches (FR-REP-08).
router.get('/reports/dashboard', roles(...REPORT_ROLES), wrap(async (req, res) => {
  const ids = await branchScope(req);
  const today = startOfDay();
  const since = new Date(Date.now() - 13 * 86400000); since.setHours(0, 0, 0, 0);
  const branches = await Branch.find({ _id: { $in: ids } }, 'name code licenseExpiry');
  const match = { org: oid(req.orgId), branch: { $in: ids }, status: { $in: done } };

  const [todayRows, series, top, stockRows, orderRows] = await Promise.all([
    Sale.aggregate([{ $match: { ...match, createdAt: { $gte: today } } }, { $group: { _id: '$branch', total: { $sum: '$total' }, count: { $sum: 1 } } }]),
    Sale.aggregate([{ $match: { ...match, createdAt: { $gte: since } } }, { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, total: { $sum: '$total' }, count: { $sum: 1 } } }, { $sort: { _id: 1 } }]),
    Sale.aggregate([{ $match: { ...match, createdAt: { $gte: since } } }, { $unwind: '$items' }, { $group: { _id: '$items.name', qty: { $sum: '$items.qty' }, revenue: { $sum: '$items.lineTotal' } } }, { $sort: { revenue: -1 } }, { $limit: 6 }]),
    Batch.aggregate([
      { $match: { org: oid(req.orgId), branch: { $in: ids }, qty: { $gt: 0 } } },
      { $group: { _id: '$branch', near: { $sum: { $cond: [{ $and: [{ $gt: ['$expiry', new Date()] }, { $lte: ['$expiry', new Date(Date.now() + 90 * 86400000)] }] }, 1, 0] } }, expired: { $sum: { $cond: [{ $lte: ['$expiry', new Date()] }, 1, 0] } }, value: { $sum: { $multiply: ['$qty', '$cost'] } } } },
    ]),
    Order.aggregate([{ $match: { org: oid(req.orgId), branch: { $in: ids }, status: { $in: ['pending_review', 'received', 'approved', 'packed', 'out_for_delivery'] } } }, { $group: { _id: '$branch', count: { $sum: 1 } } }]),
  ]);

  // Low-stock per branch: products at or under reorder level.
  const { Product } = require('../models');
  const products = await Product.find({ org: req.orgId, active: true }, 'reorderLevel branchReorder');
  const onHand = await Batch.aggregate([
    { $match: { org: oid(req.orgId), branch: { $in: ids }, status: 'active', expiry: { $gt: new Date() } } },
    { $group: { _id: { b: '$branch', p: '$product' }, qty: { $sum: '$qty' } } },
  ]);
  const qtyMap = new Map(onHand.map((r) => [`${r._id.b}:${r._id.p}`, r.qty]));
  const lowBy = new Map();
  for (const b of branches) {
    let n = 0;
    for (const p of products) {
      const lvl = (p.branchReorder || []).find((x) => String(x.branch) === String(b._id))?.level ?? p.reorderLevel;
      if ((qtyMap.get(`${b._id}:${p._id}`) || 0) <= lvl) n += 1;
    }
    lowBy.set(String(b._id), n);
  }

  const find = (rows, id, k) => rows.find((r) => String(r._id) === String(id))?.[k] || 0;
  const perBranch = branches.map((b) => ({
    branch: { _id: b._id, name: b.name, code: b.code }, todaySales: round2(find(todayRows, b._id, 'total')), todayCount: find(todayRows, b._id, 'count'),
    lowStock: lowBy.get(String(b._id)), nearExpiryBatches: find(stockRows, b._id, 'near'), expiredBatches: find(stockRows, b._id, 'expired'),
    stockValue: round2(find(stockRows, b._id, 'value')), openOrders: find(orderRows, b._id, 'count'),
    licenceDays: b.licenseExpiry ? Math.ceil((b.licenseExpiry - Date.now()) / 86400000) : null,
  }));
  const pendingRx = await Prescription.countDocuments({ org: req.orgId, status: 'pending' });
  res.json({
    totals: {
      todaySales: round2(perBranch.reduce((s, b) => s + b.todaySales, 0)), todayCount: perBranch.reduce((s, b) => s + b.todayCount, 0),
      lowStock: perBranch.reduce((s, b) => s + b.lowStock, 0), nearExpiry: perBranch.reduce((s, b) => s + b.nearExpiryBatches, 0),
      openOrders: perBranch.reduce((s, b) => s + b.openOrders, 0), stockValue: round2(perBranch.reduce((s, b) => s + b.stockValue, 0)), pendingRx,
    },
    perBranch,
    series: series.map((r) => ({ date: r._id, total: round2(r.total), count: r.count })),
    topProducts: top.map((t) => ({ name: t._id, qty: t.qty, revenue: round2(t.revenue) })),
  });
}));

const GROUPS = {
  day: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
  branch: '$branch', cashier: '$cashier',
};

// Sales by day / product / category / cashier / branch (FR-REP-01).
router.get('/reports/sales', roles(...REPORT_ROLES), wrap(async (req, res) => {
  const ids = await branchScope(req);
  const { from, to } = range(req);
  const by = req.query.by || 'day';
  const match = { org: oid(req.orgId), branch: { $in: ids }, status: { $in: done }, createdAt: { $gte: from, $lte: to } };
  let rows;
  if (['day', 'branch', 'cashier'].includes(by)) {
    rows = await Sale.aggregate([{ $match: match }, { $group: { _id: GROUPS[by], sales: { $sum: 1 }, subtotal: { $sum: '$subtotal' }, discount: { $sum: '$discount' }, tax: { $sum: '$tax' }, total: { $sum: '$total' } } }, { $sort: { _id: 1 } }]);
    if (by === 'branch') { const bs = await Branch.find({ _id: { $in: rows.map((r) => r._id) } }, 'name'); rows.forEach((r) => { r.label = bs.find((b) => String(b._id) === String(r._id))?.name; }); }
    if (by === 'cashier') { const { User } = require('../models'); const us = await User.find({ _id: { $in: rows.map((r) => r._id) } }, 'name'); rows.forEach((r) => { r.label = us.find((u) => String(u._id) === String(r._id))?.name; }); }
    rows = rows.map((r) => ({ [by]: r.label || r._id, sales: r.sales, subtotal: round2(r.subtotal), discount: round2(r.discount), tax: round2(r.tax), total: round2(r.total) }));
  } else if (['product', 'category'].includes(by)) {
    const pipeline = [{ $match: match }, { $unwind: '$items' }];
    if (by === 'category') pipeline.push({ $lookup: { from: 'products', localField: 'items.product', foreignField: '_id', as: 'p' } }, { $unwind: '$p' });
    pipeline.push({ $group: { _id: by === 'product' ? '$items.name' : '$p.category', qty: { $sum: '$items.qty' }, revenue: { $sum: '$items.lineTotal' } } }, { $sort: { revenue: -1 } });
    rows = (await Sale.aggregate(pipeline)).map((r) => ({ [by]: r._id, qty: r.qty, revenue: round2(r.revenue) }));
  } else throw bad('Unknown grouping');
  sendRows(req, res, `sales-by-${by}`, rows);
}));

router.get('/reports/stock', roles(...REPORT_ROLES), wrap(async (req, res) => {
  const ids = await branchScope(req);
  const rows = await Batch.aggregate([
    { $match: { org: oid(req.orgId), branch: { $in: ids }, qty: { $gt: 0 } } },
    { $lookup: { from: 'products', localField: 'product', foreignField: '_id', as: 'p' } }, { $unwind: '$p' },
    { $lookup: { from: 'branches', localField: 'branch', foreignField: '_id', as: 'b' } }, { $unwind: '$b' },
    { $project: { branch: '$b.name', product: '$p.brand', generic: '$p.generic', batchNo: 1, expiry: 1, qty: 1, cost: 1, status: 1, value: { $multiply: ['$qty', '$cost'] }, ageDays: { $floor: { $divide: [{ $subtract: [new Date(), '$createdAt'] }, 86400000] } } } },
    { $sort: { branch: 1, product: 1, expiry: 1 } },
  ]);
  sendRows(req, res, 'stock-on-hand', rows.map((r) => ({ branch: r.branch, product: r.product, generic: r.generic, batch: r.batchNo, expiry: r.expiry.toISOString().slice(0, 10), qty: r.qty, cost: r.cost, value: round2(r.value), status: r.status, age_days: r.ageDays })));
}));

router.get('/reports/expiry', roles(...REPORT_ROLES), wrap(async (req, res) => {
  const ids = await branchScope(req);
  const days = Number(req.query.days) || 90;
  const rows = await Batch.aggregate([
    { $match: { org: oid(req.orgId), branch: { $in: ids }, qty: { $gt: 0 }, expiry: { $lte: new Date(Date.now() + days * 86400000) } } },
    { $lookup: { from: 'products', localField: 'product', foreignField: '_id', as: 'p' } }, { $unwind: '$p' },
    { $lookup: { from: 'branches', localField: 'branch', foreignField: '_id', as: 'b' } }, { $unwind: '$b' },
    { $sort: { expiry: 1 } },
    { $project: { branch: '$b.name', product: '$p.brand', batchNo: 1, expiry: 1, qty: 1, atRisk: { $multiply: ['$qty', '$cost'] } } },
  ]);
  sendRows(req, res, 'expiry', rows.map((r) => ({ branch: r.branch, product: r.product, batch: r.batchNo, expiry: r.expiry.toISOString().slice(0, 10), qty: r.qty, value_at_risk: round2(r.atRisk), state: r.expiry < new Date() ? 'EXPIRED' : 'near expiry' })));
}));

// Profit margin by product (FR-REP-04), from cost captured on each sale line.
router.get('/reports/margin', roles('branch_manager', 'accountant', 'auditor'), wrap(async (req, res) => {
  const ids = await branchScope(req);
  const { from, to } = range(req);
  const rows = await Sale.aggregate([
    { $match: { org: oid(req.orgId), branch: { $in: ids }, status: { $in: done }, createdAt: { $gte: from, $lte: to } } }, { $unwind: '$items' },
    { $group: { _id: '$items.name', qty: { $sum: '$items.qty' }, revenue: { $sum: '$items.lineTotal' }, cost: { $sum: { $multiply: ['$items.qty', { $ifNull: ['$items.cost', 0] }] } } } },
    { $sort: { revenue: -1 } },
  ]);
  sendRows(req, res, 'margin', rows.map((r) => ({ product: r._id, qty: r.qty, revenue: round2(r.revenue), cost: round2(r.cost), margin: round2(r.revenue - r.cost), margin_pct: r.revenue ? round2(((r.revenue - r.cost) / r.revenue) * 100) : 0 })));
}));

router.get('/reports/tax', roles('branch_manager', 'accountant', 'auditor'), wrap(async (req, res) => {
  const ids = await branchScope(req);
  const { from, to } = range(req);
  const rows = await Sale.aggregate([{ $match: { org: oid(req.orgId), branch: { $in: ids }, status: { $in: done }, createdAt: { $gte: from, $lte: to } } }, { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$createdAt' } }, sales: { $sum: '$subtotal' }, discounts: { $sum: '$discount' }, tax: { $sum: '$tax' }, total: { $sum: '$total' } } }, { $sort: { _id: 1 } }]);
  sendRows(req, res, 'tax-summary', rows.map((r) => ({ month: r._id, net_sales: round2(r.sales), discounts: round2(r.discounts), tax: round2(r.tax), gross: round2(r.total) })));
}));

router.get('/reports/purchases', roles('branch_manager', 'accountant', 'auditor', 'store_officer'), wrap(async (req, res) => {
  const ids = await branchScope(req);
  const pos = await PurchaseOrder.find({ org: req.orgId, branch: { $in: ids } }).populate('supplier', 'name').populate('branch', 'name').sort('-createdAt').limit(500);
  sendRows(req, res, 'purchases', pos.map((p) => ({ po: p.poNo, date: p.createdAt, branch: p.branch?.name, supplier: p.supplier?.name, status: p.status, total: p.total })));
}));

router.get('/reports/supplier-balances', roles('branch_manager', 'accountant', 'auditor'), wrap(async (req, res) => {
  const s = await Supplier.find({ org: req.orgId }).sort('name');
  sendRows(req, res, 'supplier-balances', s.map((x) => ({ supplier: x.name, terms: x.paymentTerms, credit_limit: x.creditLimit, balance_due: x.balance })));
}));

router.get('/reports/orders', roles('branch_manager', 'accountant', 'auditor', 'dispatcher'), wrap(async (req, res) => {
  const ids = await branchScope(req);
  const { from, to } = range(req);
  const orders = await Order.find({ org: req.orgId, branch: { $in: ids }, createdAt: { $gte: from, $lte: to } }).populate('branch', 'name');
  const at = (o, s) => o.history.find((h) => h.status === s)?.at;
  const mins = (a, b) => (a && b ? Math.round((new Date(b) - new Date(a)) / 60000) : '');
  sendRows(req, res, 'order-performance', orders.map((o) => ({
    order: o.orderNo, branch: o.branch?.name, status: o.status, total: o.total, placed: o.createdAt,
    mins_to_dispatch: mins(o.createdAt, at(o, 'out_for_delivery')), mins_to_deliver: mins(o.createdAt, at(o, 'delivered')), failed: o.status === 'failed' ? 'yes' : '',
  })));
}));

router.get('/reports/dispensing', roles('pharmacist', 'branch_manager', 'auditor'), wrap(async (req, res) => {
  const { from, to } = range(req);
  const list = await Prescription.find({ org: req.orgId, createdAt: { $gte: from, $lte: to } }, '-image').populate('verifiedBy', 'name');
  sendRows(req, res, 'dispensing', list.map((r) => ({ rx: r.rxNo, date: r.createdAt, patient: r.patientName, prescriber: r.prescriber.name, status: r.status, controlled: r.hasControlled ? 'yes' : '', verified_by: r.verifiedBy?.name, items: r.items.map((i) => `${i.name} x${i.qty}`).join('; ') })));
}));

// Health-scheme claims for reconciliation (FR-RX-11): dispensed prescriptions with a scheme and member number.
router.get('/reports/insurance-claims', roles('pharmacist', 'branch_manager', 'accountant', 'auditor'), wrap(async (req, res) => {
  const { from, to } = range(req);
  const list = await Prescription.find({ org: req.orgId, 'insurance.scheme': { $exists: true, $ne: '' }, createdAt: { $gte: from, $lte: to } }, '-image');
  const sales = await Sale.find({ org: req.orgId, prescription: { $in: list.map((r) => r._id) }, status: { $in: done } }, 'prescription total');
  const totals = new Map();
  sales.forEach((x) => totals.set(String(x.prescription), (totals.get(String(x.prescription)) || 0) + x.total));
  sendRows(req, res, 'insurance-claims', list.map((r) => {
    const value = round2(totals.get(String(r._id)) || 0);
    return { rx: r.rxNo, date: r.createdAt, patient: r.patientName, scheme: r.insurance.scheme, member_no: r.insurance.memberNo, dispensed_value: value, copay: r.insurance.copay || 0, claim_amount: round2(Math.max(0, value - (r.insurance.copay || 0))), status: r.status };
  }));
}));

// Daily reconciliation of online payments against what the provider should report (CP-PAY-04).
router.get('/reports/payment-reconciliation', roles('accountant', 'branch_manager', 'auditor'), wrap(async (req, res) => {
  const ids = await branchScope(req);
  const { from, to } = range(req);
  const rows = await Order.aggregate([
    { $match: { org: oid(req.orgId), branch: { $in: ids }, createdAt: { $gte: from, $lte: to } } },
    { $group: { _id: { d: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, m: '$payment.method' }, orders: { $sum: 1 },
      paid: { $sum: { $cond: [{ $eq: ['$payment.status', 'paid'] }, '$total', 0] } },
      refunded: { $sum: { $cond: [{ $eq: ['$payment.status', 'refunded'] }, '$total', 0] } },
      pending: { $sum: { $cond: [{ $eq: ['$payment.status', 'pending'] }, '$total', 0] } } } },
    { $sort: { '_id.d': 1, '_id.m': 1 } },
  ]);
  sendRows(req, res, 'payment-reconciliation', rows.map((r) => ({ date: r._id.d, method: r._id.m, orders: r.orders, collected: round2(r.paid), refunded: round2(r.refunded), awaiting_cod: round2(r.pending), net_expected_from_provider: r._id.m === 'cod' ? 0 : round2(r.paid) })));
}));

/* ---------- Audit log (NFR-02, MB-12) ---------- */
router.get('/audit', roles('branch_manager', 'auditor'), wrap(async (req, res) => {
  const f = { org: req.orgId };
  if (req.user.role === 'branch_manager') f.branch = { $in: req.user.branches };
  else if (req.query.branch && req.query.branch !== 'all') f.branch = req.query.branch;
  if (req.query.action) f.action = new RegExp(`^${req.query.action.replace(/[^\w.]/g, '')}`);
  if (req.query.user) f.user = req.query.user;
  const rows = await AuditLog.find(f).populate('branch', 'name').sort('-createdAt').limit(Math.min(Number(req.query.limit) || 100, 500));
  await audit(req, 'audit.view', 'AuditLog', null, 'Viewed audit log');
  sendRows(req, res, 'audit-log', ['csv', 'xlsx'].includes(req.query.format) ? rows.map((r) => ({ at: r.createdAt, user: r.userName, branch: r.branch?.name, action: r.action, summary: r.summary })) : rows);
}));

module.exports = router;

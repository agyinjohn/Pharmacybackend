const router = require('express').Router();
const { Product, Batch } = require('../models');
const { wrap, bad, notFound, escapeRegex, sendRows } = require('../utils/http');
const { staff, roles, branch, writable } = require('../middleware/auth');
const { audit } = require('../services/audit');
const { oid } = require('../services/stock');


const FIELDS = ['brand', 'generic', 'strength', 'form', 'packSize', 'manufacturer', 'barcode', 'category', 'isDrug', 'legalStatus', 'controlClass', 'fdaRegNo', 'price', 'cost', 'taxRate', 'branchPrices', 'reorderLevel', 'branchReorder', 'storage', 'symptoms', 'active'];
const pick = (src) => FIELDS.reduce((o, k) => (src[k] !== undefined ? { ...o, [k]: src[k] } : o), {});

const stockByProduct = async (org, branchId) => {
  const match = { org: oid(org), status: 'active', qty: { $gt: 0 }, expiry: { $gt: new Date() } };
  if (branchId) match.branch = oid(branchId);
  const rows = await Batch.aggregate([{ $match: match }, { $group: { _id: '$product', qty: { $sum: '$qty' } } }]);
  return new Map(rows.map((r) => [String(r._id), r.qty]));
};

router.get('/products', wrap(async (req, res) => {
  const { q, category, legalStatus, barcode } = req.query;
  const filter = { org: req.orgId };
  if (req.query.active !== 'all') filter.active = true;
  if (category) filter.category = category;
  if (legalStatus) filter.legalStatus = legalStatus;
  if (barcode) filter.barcode = barcode;
  if (q) {
    const rx = new RegExp(escapeRegex(q), 'i');
    filter.$or = [{ brand: rx }, { generic: rx }, { barcode: rx }, { category: rx }];
  }
  const products = await Product.find(filter).sort('brand').limit(Math.min(Number(req.query.limit) || 100, 500));
  const stock = await stockByProduct(req.orgId, req.query.branch && req.query.branch !== 'all' ? req.query.branch : null);
  res.json(products.map((p) => ({ ...p.toObject(), stock: stock.get(String(p._id)) || 0 })));
}));

router.get('/products/categories', wrap(async (req, res) => res.json(await Product.distinct('category', { org: req.orgId }))));

router.get('/products/:id', wrap(async (req, res) => {
  const p = await Product.findOne({ _id: req.params.id, org: req.orgId });
  if (!p) throw notFound();
  res.json(p);
}));

// Generic substitutes and where stock is available across branches.
router.get('/products/:id/alternatives', branch(false), wrap(async (req, res) => {
  const p = await Product.findOne({ _id: req.params.id, org: req.orgId });
  if (!p) throw notFound();
  const subs = p.generic
    ? await Product.find({ org: req.orgId, _id: { $ne: p._id }, active: true, generic: new RegExp(`^${escapeRegex(p.generic)}$`, 'i') })
    : [];
  const stock = await stockByProduct(req.orgId, req.branchId);
  res.json(subs.map((s) => ({ ...s.toObject(), stock: stock.get(String(s._id)) || 0 })));
}));

router.post('/products', roles('store_officer', 'branch_manager', 'pharmacist'), writable, wrap(async (req, res) => {
  const p = await Product.create({ ...pick(req.body), org: req.orgId });
  await audit(req, 'product.create', 'Product', p._id, `Product ${p.brand} created`, { after: p.toObject() });
  res.status(201).json(p);
}));

router.patch('/products/:id', roles('store_officer', 'branch_manager', 'pharmacist'), writable, wrap(async (req, res) => {
  const p = await Product.findOne({ _id: req.params.id, org: req.orgId });
  if (!p) throw notFound();
  const before = p.toObject();
  Object.assign(p, pick(req.body));
  await p.save();
  await audit(req, 'product.update', 'Product', p._id, `Product ${p.brand} updated`, { before, after: p.toObject() });
  res.json(p);
}));

// Bulk import from rows the browser parsed out of a spreadsheet/CSV (FR-CAT-06, NFR-12).
// Returns a validation report; bad rows are skipped, not fatal.
router.post('/products/import', roles('store_officer', 'branch_manager'), writable, wrap(async (req, res) => {
  const rows = req.body.rows;
  if (!Array.isArray(rows) || !rows.length) throw bad('No rows to import');
  if (rows.length > 5000) throw bad('Import at most 5000 rows at a time');
  const report = { created: 0, updated: 0, errors: [] };
  for (const [idx, r] of rows.entries()) {
    try {
      const data = pick({ ...r, price: Number(r.price), cost: Number(r.cost || 0), taxRate: Number(r.taxRate || 0) });
      if (!data.brand || Number.isNaN(data.price)) throw new Error('brand and numeric price are required');
      const existing = data.barcode ? await Product.findOne({ org: req.orgId, barcode: data.barcode }) : null;
      if (existing) { Object.assign(existing, data); await existing.save(); report.updated += 1; } else { await Product.create({ ...data, org: req.orgId }); report.created += 1; }
    } catch (e) {
      report.errors.push({ row: idx + 2, error: e.message });
    }
  }
  await audit(req, 'product.import', 'Product', null, `Imported products: ${report.created} created, ${report.updated} updated, ${report.errors.length} errors`);
  res.json(report);
}));

router.get('/export/products', roles('store_officer', 'branch_manager', 'accountant'), wrap(async (req, res) => {
  const ps = await Product.find({ org: req.orgId }).sort('brand');
  sendRows(req, res, 'products', ps.map((p) => ({ brand: p.brand, generic: p.generic, strength: p.strength, form: p.form, barcode: p.barcode, category: p.category, legalStatus: p.legalStatus, price: p.price })));
}));

module.exports = router;

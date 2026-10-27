const {
  Product, Branch, Customer, Supplier, Ledger,
} = require('../models');
const { addBatch, registerEntry } = require('./stock');
const { round2 } = require('../utils/http');

// Data migration (NFR-12). Each importer validates one spreadsheet row and returns an apply()
// function, so a dry run can report every problem before anything is written.
const LEGAL = ['otc', 'pharmacy_only', 'prescription_only', 'controlled'];
const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
const num = (v, field, { min = 0, required = false } = {}) => {
  const s = str(v);
  if (!s) { if (required) throw new Error(`${field} is required`); return undefined; }
  const n = Number(s.replace(/,/g, ''));
  if (!Number.isFinite(n) || n < min) throw new Error(`${field} must be a number${min === 0 ? ' of 0 or more' : ''}`);
  return n;
};
const date = (v, field, required = false) => {
  const s = str(v);
  if (!s) { if (required) throw new Error(`${field} is required`); return undefined; }
  // Accept YYYY-MM-DD, DD/MM/YYYY and Excel serial numbers.
  let d;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) d = new Date(s);
  else if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) { const [dd, mm, yy] = s.split('/').map(Number); d = new Date(Date.UTC(yy, mm - 1, dd)); }
  else if (/^\d{5}$/.test(s)) d = new Date(Date.UTC(1899, 11, 30) + Number(s) * 86400000);
  else d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`${field} is not a valid date (use YYYY-MM-DD)`);
  return d;
};
const list = (v) => str(v).split(/[;|]/).map((x) => x.trim()).filter(Boolean);
const phoneOf = (v) => str(v).replace(/\s+/g, '');

const findProduct = async (org, r) => {
  const barcode = str(r.barcode);
  if (barcode) { const p = await Product.findOne({ org, barcode }); if (p) return p; }
  const brand = str(r.brand || r.product);
  if (brand) {
    const q = { org, brand: new RegExp(`^${brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') };
    if (str(r.strength)) q.strength = str(r.strength);
    const p = await Product.findOne(q); if (p) return p;
  }
  throw new Error(`Product not found (barcode "${barcode}", brand "${brand}"); import products first`);
};

const IMPORTERS = {
  products: {
    columns: ['brand', 'generic', 'strength', 'form', 'packSize', 'manufacturer', 'barcode', 'category', 'legalStatus', 'price', 'cost', 'taxRate', 'reorderLevel', 'fdaRegNo'],
    example: { brand: 'Panadol Extra', generic: 'Paracetamol', strength: '500mg', form: 'Tablet', packSize: '24s', manufacturer: 'GSK', barcode: '6291000000017', category: 'Pain & Fever', legalStatus: 'otc', price: '18', cost: '11', taxRate: '0', reorderLevel: '15', fdaRegNo: 'FDA/10001' },
    async row(r, { org }) {
      const brand = str(r.brand); if (!brand) throw new Error('brand is required');
      const legalStatus = str(r.legalStatus || 'otc').toLowerCase().replace(/[\s-]/g, '_');
      if (!LEGAL.includes(legalStatus)) throw new Error(`legalStatus must be one of ${LEGAL.join(', ')}`);
      const taxRate = num(r.taxRate, 'taxRate') ?? 0;
      const data = {
        brand, generic: str(r.generic), strength: str(r.strength), form: str(r.form), packSize: str(r.packSize), manufacturer: str(r.manufacturer),
        barcode: str(r.barcode) || undefined, category: str(r.category) || 'General', legalStatus, fdaRegNo: str(r.fdaRegNo),
        price: num(r.price, 'price', { required: true }), cost: num(r.cost, 'cost') ?? 0, taxRate: taxRate > 1 ? taxRate / 100 : taxRate,
        reorderLevel: num(r.reorderLevel, 'reorderLevel') ?? 10,
      };
      const existing = data.barcode ? await Product.findOne({ org, barcode: data.barcode }) : null;
      return { op: existing ? 'update' : 'create', apply: async () => (existing ? Object.assign(existing, data).save() : Product.create({ ...data, org })) };
    },
  },
  stock: {
    columns: ['branchCode', 'barcode', 'brand', 'strength', 'batchNo', 'expiry', 'qty', 'cost'],
    example: { branchCode: 'ACC', barcode: '6291000000017', brand: 'Panadol Extra', strength: '500mg', batchNo: 'B1234', expiry: '2027-06-30', qty: '120', cost: '11' },
    async row(r, { org, branchId, user }) {
      let branch = branchId;
      if (str(r.branchCode)) { const b = await Branch.findOne({ org, code: str(r.branchCode).toUpperCase() }); if (!b) throw new Error(`Unknown branch code ${r.branchCode}`); branch = b._id; }
      if (!branch) throw new Error('branchCode is required');
      const p = await findProduct(org, r);
      const batchNo = str(r.batchNo); if (!batchNo) throw new Error('batchNo is required');
      const expiry = date(r.expiry, 'expiry', true);
      const qty = num(r.qty, 'qty', { required: true });
      if (!Number.isInteger(qty) || qty < 1) throw new Error('qty must be a whole number of at least 1');
      const cost = num(r.cost, 'cost') ?? p.cost;
      const expired = expiry <= new Date();
      return {
        op: 'create', warning: expired ? 'batch is already expired; it will be blocked from sale' : undefined,
        apply: async () => {
          await addBatch({ org, branch, product: p._id, batchNo, expiry, qty, cost });
          if (p.legalStatus === 'controlled') await registerEntry({ org, branch, product: p._id, productName: p.brand, type: 'receipt', qty, counterparty: 'Opening stock (data migration)', batchNo, pharmacist: user._id, pharmacistName: user.name });
        },
      };
    },
  },
  customers: {
    columns: ['name', 'phone', 'email', 'allergies', 'conditions', 'creditLimit', 'openingBalance', 'consentCommunications', 'consentHealthData'],
    example: { name: 'Ama Owusu', phone: '+233241234567', email: 'ama@example.com', allergies: 'Penicillin;Sulfa', conditions: 'Hypertension', creditLimit: '0', openingBalance: '0', consentCommunications: 'yes', consentHealthData: 'yes' },
    async row(r, { org, user }) {
      const name = str(r.name); if (!name) throw new Error('name is required');
      const phone = phoneOf(r.phone); if (!/^\+?\d{9,15}$/.test(phone)) throw new Error('phone must be 9-15 digits');
      const yes = (v) => /^(y|yes|true|1)$/i.test(str(v));
      const opening = num(r.openingBalance, 'openingBalance') ?? 0;
      const data = { name, phone, email: str(r.email) || undefined, allergies: list(r.allergies), conditions: list(r.conditions), creditLimit: num(r.creditLimit, 'creditLimit') ?? 0 };
      if (str(r.consentCommunications) || str(r.consentHealthData)) data.consent = { communications: yes(r.consentCommunications), healthData: yes(r.consentHealthData), at: new Date() };
      const existing = await Customer.findOne({ org, phone });
      return {
        op: existing ? 'update' : 'create',
        apply: async () => {
          const c = existing ? await Object.assign(existing, data).save() : await Customer.create({ ...data, org });
          if (opening > 0 && !existing) {
            await Customer.updateOne({ _id: c._id }, { $inc: { balance: opening } });
            await Ledger.create({ org, customer: c._id, type: 'charge', amount: round2(opening), ref: 'Opening balance (data migration)', by: user._id });
          }
        },
      };
    },
  },
  suppliers: {
    columns: ['name', 'contact', 'phone', 'email', 'licenseNumber', 'licenseExpiry', 'paymentTerms', 'creditLimit', 'openingBalance'],
    example: { name: 'Kinapharma Distribution', contact: 'Sales desk', phone: '+233302770000', email: 'sales@example.com', licenseNumber: 'PC/WS/0102', licenseExpiry: '2027-12-31', paymentTerms: 'Net 30', creditLimit: '80000', openingBalance: '12400' },
    async row(r, { org }) {
      const name = str(r.name); if (!name) throw new Error('name is required');
      const data = { name, contact: str(r.contact), phone: str(r.phone), email: str(r.email), licenseNumber: str(r.licenseNumber), licenseExpiry: date(r.licenseExpiry, 'licenseExpiry'), paymentTerms: str(r.paymentTerms), creditLimit: num(r.creditLimit, 'creditLimit') ?? 0 };
      const opening = num(r.openingBalance, 'openingBalance');
      const existing = await Supplier.findOne({ org, name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') });
      return { op: existing ? 'update' : 'create', apply: async () => (existing ? Object.assign(existing, data, opening !== undefined ? { balance: opening } : {}).save() : Supplier.create({ ...data, org, balance: opening ?? 0 })) };
    },
  },
};

// Validates every row; when commit is true, applies the valid ones. Returns the report.
const runImport = async (type, rows, ctx, commit) => {
  const imp = IMPORTERS[type];
  const report = { type, total: rows.length, created: 0, updated: 0, skipped: 0, errors: [], warnings: [] };
  const plans = [];
  for (const [i, r] of rows.entries()) {
    const rowNo = i + 2; // spreadsheet row, after the header
    try {
      const plan = await imp.row(r, ctx);
      if (plan.warning) report.warnings.push({ row: rowNo, warning: plan.warning });
      plans.push({ rowNo, plan });
    } catch (e) { report.errors.push({ row: rowNo, error: e.message }); }
  }
  report.skipped = report.errors.length;
  for (const { rowNo, plan } of plans) {
    if (!commit) { report[plan.op === 'update' ? 'updated' : 'created'] += 1; continue; }
    try { await plan.apply(); report[plan.op === 'update' ? 'updated' : 'created'] += 1; } catch (e) { report.errors.push({ row: rowNo, error: e.message }); report.skipped += 1; }
  }
  return report;
};

module.exports = { IMPORTERS, runImport };

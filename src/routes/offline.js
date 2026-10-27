const router = require('express').Router();
const { Prescription, Product, Supplier, OfflineOp, Customer } = require('../models');
const { wrap, bad, forbidden } = require('../utils/http');
const { roles, branch, writable } = require('../middleware/auth');
const { audit } = require('../services/audit');
const { completeSale } = require('../services/sales');
const { addBatch, registerEntry } = require('../services/stock');

// Offline working (NFR-05): the branch keeps selling, receiving stock and dispensing without
// internet; queued operations arrive here when the connection returns. Each one is applied once
// (by clientId), and anything the system would normally have blocked is flagged for review.
const POS = ['cashier', 'pharmacist', 'branch_manager', 'technician'];
const INV = ['store_officer', 'branch_manager', 'pharmacist', 'technician'];

// Verified prescriptions a pharmacist may dispense while offline. Controlled drugs are excluded.
router.get('/offline/rx-snapshot', roles('pharmacist'), wrap(async (req, res) => {
  const list = await Prescription.find({ org: req.orgId, status: { $in: ['verified', 'partial'] }, hasControlled: { $ne: true } }, '-image').sort('-updatedAt').limit(500);
  const custs = await Customer.find({ _id: { $in: list.map((r) => r.customer).filter(Boolean) } }, 'allergies');
  res.json({
    at: new Date(),
    prescriptions: list.map((r) => ({
      _id: r._id, rxNo: r.rxNo, patientName: r.patientName, prescriber: r.prescriber?.name, refillsAllowed: r.refillsAllowed,
      allergies: custs.find((c) => String(c._id) === String(r.customer))?.allergies || [],
      items: r.items.map((i) => ({ product: i.product, name: i.name, dose: i.dose, frequency: i.frequency, duration: i.duration, qty: i.qty, dispensedQty: i.dispensedQty, max: i.qty * (1 + (r.refillsAllowed || 0)) })),
    })),
  });
}));

const applyReceipt = async (req, p) => {
  if (!req.user.role || !(req.user.role === 'owner' || INV.includes(req.user.role))) throw forbidden('Your role cannot receive stock');
  const flags = [];
  for (const i of p.items || []) {
    const prod = await Product.findOne({ _id: i.product, org: req.orgId });
    if (!prod) throw bad('Unknown product');
    const qty = Number(i.qty);
    if (!i.batchNo || !i.expiry || !(qty > 0)) throw bad(`${prod.brand}: batch, expiry and quantity are required`);
    if (new Date(i.expiry) <= new Date()) flags.push(`${prod.brand} batch ${i.batchNo} received already expired; it is blocked from sale`);
    await addBatch({ org: req.orgId, branch: req.branchId, product: prod._id, batchNo: i.batchNo, expiry: i.expiry, qty, cost: Number(i.cost || 0), supplier: p.supplier || undefined });
    if (prod.legalStatus === 'controlled') {
      const sname = p.supplier ? (await Supplier.findById(p.supplier))?.name : undefined;
      await registerEntry({ org: req.orgId, branch: req.branchId, product: prod._id, productName: prod.brand, type: 'receipt', qty, counterparty: sname, batchNo: i.batchNo, pharmacist: req.user._id, pharmacistName: req.user.name, date: new Date(p.receivedAt || Date.now()), note: `Received offline${p.invoiceNo ? `, invoice ${p.invoiceNo}` : ''}` });
    }
  }
  return { flags };
};

router.post('/offline/sync', branch(), writable, wrap(async (req, res) => {
  const ops = Array.isArray(req.body.ops) ? req.body.ops : [];
  if (ops.length > 200) throw bad('Sync at most 200 operations at a time');
  const results = [];
  for (const op of ops) {
    try {
      if (!op.clientId) throw bad('Missing clientId');
      const seen = await OfflineOp.findOne({ org: req.orgId, clientId: op.clientId });
      if (seen) { results.push({ clientId: op.clientId, ok: true, duplicate: true, ...seen.result }); continue; }
      let result;
      const p = op.payload || {};
      if (op.kind === 'sale' || op.kind === 'dispense') {
        if (!(req.user.role === 'owner' || POS.includes(req.user.role))) throw forbidden('Your role cannot sell');
        if (op.kind === 'dispense' && !req.user.isPharmacistInGoodStanding()) throw forbidden('Only a registered pharmacist can dispense');
        const sale = await completeSale({
          user: req.user, org: req.orgId, branch: req.branchId, items: p.items, customerId: p.customer, discount: p.discount || 0,
          payments: p.payments || 'auto', prescriptionId: op.kind === 'dispense' ? p.prescription : undefined,
          clientId: op.clientId, offlineAt: op.createdAt, allowShortfall: true, allowNoShift: true, offlineRx: op.kind === 'dispense',
        });
        result = { receiptNo: sale.receiptNo, flags: sale.flags };
      } else if (op.kind === 'receipt') {
        result = await applyReceipt(req, p);
      } else throw bad(`Unknown operation ${op.kind}`);
      await OfflineOp.create({ org: req.orgId, clientId: op.clientId, kind: op.kind, result });
      results.push({ clientId: op.clientId, ok: true, ...result });
    } catch (e) {
      if (e.code === 11000) { results.push({ clientId: op.clientId, ok: true, duplicate: true }); continue; }
      results.push({ clientId: op.clientId, ok: false, error: e.message });
    }
  }
  const ok = results.filter((r) => r.ok).length;
  const flagged = results.filter((r) => r.flags?.length).length;
  await audit(req, 'offline.sync', 'OfflineOp', null, `Synced ${ok}/${ops.length} offline operation(s), ${flagged} flagged`);
  res.json({ results });
}));

module.exports = router;

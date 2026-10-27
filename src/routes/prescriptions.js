const router = require('express').Router();
const { Prescription, Product, Customer, ControlledRegister, Order } = require('../models');
const { wrap, bad, notFound, conflict, forbidden, seq, sendRows, escapeRegex } = require('../utils/http');
const { staff, roles, branch, writable } = require('../middleware/auth');
const { audit } = require('../services/audit');
const { checkPrescription } = require('../services/clinical');
const { completeSale } = require('../services/sales');
const { plansFromDispensing } = require('../services/reminders');

const RX_STAFF = ['pharmacist', 'technician', 'branch_manager', 'cashier'];

const scope = (req) => {
  const f = { org: req.orgId };
  if (req.query.status) f.status = req.query.status;
  return f;
};

router.get('/prescriptions', roles(...RX_STAFF), wrap(async (req, res) => {
  const f = scope(req);
  // Prescriptions are shared across branches (MB-09); staff see the ones relevant to their branches.
  if (req.query.q) { const rx = new RegExp(escapeRegex(req.query.q), 'i'); f.$or = [{ rxNo: rx }, { patientName: rx }]; }
  const list = await Prescription.find(f, '-image').sort('-createdAt').limit(100).populate('branch', 'name');
  res.json(list);
}));

router.get('/prescriptions/:id', roles(...RX_STAFF), wrap(async (req, res) => {
  const rx = await Prescription.findOne({ _id: req.params.id, org: req.orgId }).populate('branch', 'name').populate('customer').populate('notes.by verifiedBy', 'name');
  if (!rx) throw notFound();
  await audit(req, 'rx.view', 'Prescription', rx._id, `Viewed prescription ${rx.rxNo} (${rx.patientName})`);
  res.json(rx);
}));

// Capture at the counter (FR-RX-01).
router.post('/prescriptions', branch(), roles(...RX_STAFF), writable, wrap(async (req, res) => {
  const { customer, patientName, prescriber, writtenOn, items, refillsAllowed = 0, image, paperOriginalSeen, insurance } = req.body;
  if (!patientName || !prescriber?.name || !items?.length) throw bad('Patient, prescriber and at least one drug are required');
  const prods = await Product.find({ _id: { $in: items.map((i) => i.product) }, org: req.orgId });
  if (prods.length !== new Set(items.map((i) => String(i.product))).size) throw bad('Unknown product on prescription');
  const hasControlled = prods.some((p) => p.legalStatus === 'controlled');
  const strict = prods.some((p) => p.controlClass === 'strict');
  if (hasControlled && !prescriber.regNo) throw bad('Prescriber registration number is required for controlled drugs');
  if (hasControlled && !paperOriginalSeen) throw bad('Controlled drugs need the signed paper original: tick that it has been sighted and attach a scan');
  const rx = await Prescription.create({
    org: req.orgId, branch: req.branchId, rxNo: seq('RX'), customer, patientName, prescriber, writtenOn, image, paperOriginalSeen: !!paperOriginalSeen,
    refillsAllowed: strict ? 0 : Math.max(0, Number(refillsAllowed) || 0), // REG-05: no refills for the strictest class
    hasControlled, insurance, source: 'walk_in',
    items: items.map((i) => { const p = prods.find((x) => String(x._id) === String(i.product)); return { product: p._id, name: p.brand, dose: i.dose, frequency: i.frequency, duration: i.duration, qty: Number(i.qty) }; }),
  });
  await audit(req, 'rx.create', 'Prescription', rx._id, `Prescription ${rx.rxNo} captured for ${patientName}`);
  res.status(201).json(rx);
}));

// Pharmacist verification (FR-RX-03, REG-09): checks allergies, duplicates and interactions.
router.post('/prescriptions/:id/verify', roles('pharmacist'), writable, wrap(async (req, res) => {
  if (!req.user.isPharmacistInGoodStanding()) throw forbidden('Your pharmacist registration or annual licence is not in good standing');
  const rx = await Prescription.findOne({ _id: req.params.id, org: req.orgId });
  if (!rx) throw notFound();
  if (rx.status !== 'pending') throw conflict('Prescription has already been processed');
  if (rx.hasControlled && !rx.paperOriginalSeen) throw conflict('Sight the signed paper original before verifying a controlled-drug prescription');
  const prods = await Product.find({ _id: { $in: rx.items.map((i) => i.product) } });
  const customer = rx.customer ? await Customer.findById(rx.customer) : null;
  const warnings = checkPrescription(prods, customer?.allergies);
  if (warnings.length && !req.body.override) {
    return res.status(409).json({ error: 'Clinical warnings need your attention before verifying', warnings, needsOverride: true });
  }
  if (warnings.length && !(req.body.overrideReason || '').trim()) throw bad('Give a reason for overriding the warnings');
  rx.allergyWarnings = warnings;
  rx.status = 'verified'; rx.verifiedBy = req.user._id; rx.verifiedAt = new Date();
  if (warnings.length) rx.notes.push({ by: req.user._id, type: 'intervention', text: `Warnings overridden: ${req.body.overrideReason}` });
  await rx.save();
  // If this came from an online order, move the order into the approval flow.
  await Order.updateMany({ prescription: rx._id, status: 'pending_review' }, { $set: { reviewNote: 'Prescription verified' } });
  await audit(req, 'rx.verify', 'Prescription', rx._id, `Verified prescription ${rx.rxNo}`);
  res.json(rx);
}));

router.post('/prescriptions/:id/reject', roles('pharmacist'), writable, wrap(async (req, res) => {
  if (!(req.body.reason || '').trim()) throw bad('A reason is required');
  const rx = await Prescription.findOne({ _id: req.params.id, org: req.orgId });
  if (!rx) throw notFound();
  if (rx.status !== 'pending') throw conflict('Prescription has already been processed');
  rx.status = 'rejected'; rx.rejectedReason = req.body.reason; rx.verifiedBy = req.user._id; rx.verifiedAt = new Date();
  rx.notes.push({ by: req.user._id, type: 'decline', text: req.body.reason });
  await rx.save();
  await audit(req, 'rx.reject', 'Prescription', rx._id, `Rejected prescription ${rx.rxNo}: ${req.body.reason}`);
  res.json(rx);
}));

router.post('/prescriptions/:id/notes', roles('pharmacist'), writable, wrap(async (req, res) => {
  const { type = 'counselling', text } = req.body;
  if (!text) throw bad('Note text is required');
  const rx = await Prescription.findOneAndUpdate({ _id: req.params.id, org: req.orgId }, { $push: { notes: { by: req.user._id, type, text } } }, { returnDocument: 'after' });
  if (!rx) throw notFound();
  await audit(req, 'rx.note', 'Prescription', rx._id, `Pharmacist note (${type}) on ${rx.rxNo}`);
  res.json(rx);
}));

router.post('/prescriptions/:id/paper-sighted', roles('pharmacist'), writable, wrap(async (req, res) => {
  const rx = await Prescription.findOneAndUpdate({ _id: req.params.id, org: req.orgId }, { paperOriginalSeen: true }, { returnDocument: 'after' });
  if (!rx) throw notFound();
  await audit(req, 'rx.paper', 'Prescription', rx._id, `Signed paper original sighted for ${rx.rxNo}`);
  res.json(rx);
}));

// Dispense (full or partial) from the selected branch: FEFO stock, label data, register entry.
router.post('/prescriptions/:id/dispense', branch(), roles('pharmacist'), writable, wrap(async (req, res) => {
  const rx = await Prescription.findOne({ _id: req.params.id, org: req.orgId });
  if (!rx) throw notFound();
  if (!['verified', 'partial'].includes(rx.status)) throw conflict('Prescription must be verified before dispensing');
  const lines = (req.body.lines || rx.items.map((i) => ({ product: i.product, qty: i.qty - (i.dispensedQty % i.qty || 0) }))).filter((l) => l.qty > 0);
  const sale = await completeSale({
    user: req.user, org: req.orgId, branch: req.branchId, items: lines, customerId: rx.customer, prescriptionId: rx._id,
    discount: 0, payments: req.body.payments || 'auto', allowNoShift: true,
  });
  await audit(req, 'rx.dispense', 'Prescription', rx._id, `Dispensed ${rx.rxNo} (sale ${sale.receiptNo})`);
  // Dose reminders from the directions, unless the pharmacist unticked them.
  const reminders = req.body.reminders === false ? [] : await plansFromDispensing({ rx, lines: sale.items.map((i) => ({ product: i.product, qty: i.qty })), branch: req.branchId, by: req.user.name });
  const labels = sale.items.map((it) => {
    const line = rx.items.find((i) => String(i.product) === String(it.product));
    return { patient: rx.patientName, drug: it.name, directions: [line?.dose, line?.frequency, line?.duration].filter(Boolean).join(', '), qty: it.qty, batch: it.lots.map((l) => l.batchNo).join(', '), expiry: it.lots[0]?.expiry, date: new Date(), rxNo: rx.rxNo };
  });
  res.json({ sale, labels, reminders, prescription: await Prescription.findById(rx._id, '-image') });
}));

// Prescriptions due for refund reminders (FR-RX-10).
router.get('/refill-reminders', roles('pharmacist', 'branch_manager'), wrap(async (req, res) => {
  const list = await Prescription.find({ org: req.orgId, status: 'partial' }, '-image').populate('customer', 'name phone').limit(100);
  res.json(list.filter((r) => r.items.some((i) => i.dispensedQty < i.qty * (1 + r.refillsAllowed))));
}));

/* ---------- Controlled-drug register ---------- */
router.get('/controlled-register', branch(), roles('pharmacist', 'branch_manager', 'auditor'), wrap(async (req, res) => {
  const f = { org: req.orgId, branch: req.branchId };
  if (req.query.product) f.product = req.query.product;
  const rows = await ControlledRegister.find(f).sort({ createdAt: 1, _id: 1 }).limit(2000);
  if (['csv', 'xlsx'].includes(req.query.format)) {
    return sendRows(req, res, 'controlled-register', rows.map((r) => ({ date: r.date, drug: r.productName, type: r.type, qty: r.qty, balance: r.balance, counterparty: r.counterparty, patient: r.patient, prescriber: r.prescriber, rx: r.rxNo, batch: r.batchNo, pharmacist: r.pharmacistName, witness: r.witness, note: r.note })));
  }
  await audit(req, 'register.view', 'ControlledRegister', null, 'Viewed controlled-drug register');
  res.json(rows);
}));

// Disposal needs a witness (REG-06). Corrections are new entries, never edits (REG-02).
router.post('/controlled-register/disposal', branch(), roles('pharmacist'), writable, wrap(async (req, res) => {
  const { product, batch, qty, witness, note } = req.body;
  if (!witness) throw bad('A witness name is required for disposal');
  const { Batch } = require('../models');
  const { registerEntry } = require('../services/stock');
  const p = await Product.findOne({ _id: product, org: req.orgId, legalStatus: 'controlled' });
  const b = await Batch.findOne({ _id: batch, org: req.orgId, branch: req.branchId, product });
  if (!p || !b) throw notFound('Controlled product or batch not found');
  const n = Number(qty);
  if (!(n > 0) || n > b.qty) throw bad('Invalid quantity');
  const res2 = await Batch.updateOne({ _id: b._id, qty: { $gte: n } }, { $inc: { qty: -n } });
  if (res2.modifiedCount !== 1) throw conflict('Stock changed, retry');
  const e = await registerEntry({ org: req.orgId, branch: req.branchId, product, productName: p.brand, type: 'disposal', qty: n, batchNo: b.batchNo, pharmacist: req.user._id, pharmacistName: req.user.name, witness, note });
  await audit(req, 'register.disposal', 'ControlledRegister', e._id, `Disposed ${n} x ${p.brand}, witness ${witness}`);
  res.status(201).json(e);
}));

// Physical count check: compares register balance with batches on the shelf.
router.get('/controlled-register/reconcile', branch(), roles('pharmacist', 'branch_manager', 'auditor'), wrap(async (req, res) => {
  const { Batch } = require('../models');
  const prods = await Product.find({ org: req.orgId, legalStatus: 'controlled' });
  const out = [];
  for (const p of prods) {
    const last = await ControlledRegister.findOne({ branch: req.branchId, product: p._id }).sort({ createdAt: -1, _id: -1 });
    const onShelf = (await Batch.find({ branch: req.branchId, product: p._id })).reduce((s, b) => s + b.qty, 0);
    out.push({ product: p.brand, register: last ? last.balance : 0, onShelf, matches: (last ? last.balance : 0) === onShelf });
  }
  res.json(out);
}));

module.exports = router;

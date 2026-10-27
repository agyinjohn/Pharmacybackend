const router = require('express').Router();
const { ProcessingActivity, SecurityIncident, Organization } = require('../models');
const { wrap, bad, notFound, sendRows } = require('../utils/http');
const { roles, writable } = require('../middleware/auth');
const { audit } = require('../services/audit');
const { retentionRun, DEFAULT_ACTIVITIES } = require('../services/privacy');

const DP = ['branch_manager', 'auditor'];
const ACT_FIELDS = ['name', 'purpose', 'dataSubjects', 'dataCategories', 'lawfulBasis', 'recipients', 'processorAgreement', 'retention', 'transfersOutsideGhana', 'safeguards'];
const pick = (src, fields) => fields.reduce((o, k) => (src[k] !== undefined ? { ...o, [k]: src[k] } : o), {});

/* ---- Record of processing activities (REG-15) ---- */
router.get('/dp/processing', roles(...DP), wrap(async (req, res) => {
  let list = await ProcessingActivity.find({ org: req.orgId }).sort('name');
  if (!list.length) {
    // Start the register from the platform's own processing, so the pharmacy only edits.
    const org = await Organization.findById(req.orgId);
    const outside = org.settings.hosting?.country && !/ghana/i.test(org.settings.hosting.country) ? `Hosted in ${org.settings.hosting.country}` : '';
    list = await ProcessingActivity.insertMany(DEFAULT_ACTIVITIES.map((a) => ({ ...a, org: req.orgId, transfersOutsideGhana: outside, safeguards: org.settings.hosting?.safeguards || '' })));
  }
  if (req.query.format) return sendRows(req, res, 'record-of-processing', list.map((a) => Object.fromEntries(ACT_FIELDS.map((k) => [k, a[k] || '']))));
  res.json(list);
}));
router.post('/dp/processing', roles('branch_manager'), writable, wrap(async (req, res) => {
  const a = await ProcessingActivity.create({ ...pick(req.body, ACT_FIELDS), org: req.orgId });
  await audit(req, 'dp.processing.create', 'ProcessingActivity', a._id, `Processing activity "${a.name}" added`);
  res.status(201).json(a);
}));
router.patch('/dp/processing/:id', roles('branch_manager'), writable, wrap(async (req, res) => {
  const a = await ProcessingActivity.findOneAndUpdate({ _id: req.params.id, org: req.orgId }, pick(req.body, ACT_FIELDS), { returnDocument: 'after' });
  if (!a) throw notFound();
  await audit(req, 'dp.processing.update', 'ProcessingActivity', a._id, `Processing activity "${a.name}" updated`);
  res.json(a);
}));
router.delete('/dp/processing/:id', roles('branch_manager'), writable, wrap(async (req, res) => {
  const a = await ProcessingActivity.findOneAndDelete({ _id: req.params.id, org: req.orgId });
  if (!a) throw notFound();
  await audit(req, 'dp.processing.delete', 'ProcessingActivity', a._id, `Processing activity "${a.name}" removed`);
  res.json({ ok: true });
}));

/* ---- Security incidents (REG-18) ---- */
const INC_FIELDS = ['title', 'discoveredAt', 'description', 'dataAffected', 'peopleAffected', 'severity', 'status', 'commissionNotifiedAt', 'subjectsNotifiedAt'];
router.get('/dp/incidents', roles(...DP), wrap(async (req, res) => {
  const list = await SecurityIncident.find({ org: req.orgId }).sort('-discoveredAt');
  if (req.query.format) return sendRows(req, res, 'security-incidents', list.map((i) => ({ title: i.title, discovered: i.discoveredAt, severity: i.severity, status: i.status, people_affected: i.peopleAffected ?? '', data_affected: i.dataAffected, commission_notified: i.commissionNotifiedAt || '', subjects_notified: i.subjectsNotifiedAt || '' })));
  res.json(list);
}));
router.post('/dp/incidents', roles('branch_manager'), writable, wrap(async (req, res) => {
  if (!req.body.title) throw bad('A title is required');
  const i = await SecurityIncident.create({ ...pick(req.body, INC_FIELDS), org: req.orgId, reportedBy: req.user._id, actions: [{ by: req.user.name, text: 'Incident logged' }] });
  await audit(req, 'dp.incident.create', 'SecurityIncident', i._id, `Security incident logged: ${i.title}`);
  res.status(201).json(i);
}));
router.patch('/dp/incidents/:id', roles('branch_manager'), writable, wrap(async (req, res) => {
  const i = await SecurityIncident.findOne({ _id: req.params.id, org: req.orgId });
  if (!i) throw notFound();
  const before = { status: i.status };
  Object.assign(i, pick(req.body, INC_FIELDS));
  if (req.body.action) i.actions.push({ by: req.user.name, text: req.body.action });
  if (before.status !== i.status) i.actions.push({ by: req.user.name, text: `Status changed to ${i.status}` });
  await i.save();
  await audit(req, 'dp.incident.update', 'SecurityIncident', i._id, `Security incident updated: ${i.title} (${i.status})`);
  res.json(i);
}));

/* ---- Retention (REG-16) ---- */
router.get('/dp/retention/preview', roles('branch_manager'), wrap(async (req, res) => res.json(await retentionRun(req.orgId, false))));
router.post('/dp/retention/run', roles(), writable, wrap(async (req, res) => {
  const r = await retentionRun(req.orgId, true);
  await audit(req, 'dp.retention.run', 'Organization', req.orgId, `Retention run: ${r.notificationsDeleted} notifications deleted, ${r.prescriptionImagesRemoved} prescription images removed, ${r.customersAnonymised} customers anonymised`);
  res.json(r);
}));

module.exports = router;

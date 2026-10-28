const router = require('express').Router();
const { ReminderPlan, ReminderLog, Customer, Prescription, Organization } = require('../models');
const { wrap, bad, notFound } = require('../utils/http');
const { roles, writable } = require('../middleware/auth');
const { audit } = require('../services/audit');
const { notify } = require('../services/notify');
const { runReminders, doseText, validTime } = require('../services/reminders');

const RX_STAFF = ['pharmacist', 'technician', 'branch_manager', 'cashier'];
const cleanTimes = (times) => {
  if (!Array.isArray(times) || !times.length) throw bad('Add at least one reminder time');
  const t = [...new Set(times.map((x) => String(x).trim()))].sort();
  if (!t.every(validTime)) throw bad('Times must be HH:MM, e.g. 08:00');
  if (t.length > 8) throw bad('At most 8 reminders a day');
  return t;
};

router.get('/customers/:id/reminders', roles(...RX_STAFF), wrap(async (req, res) => {
  res.json(await ReminderPlan.find({ org: req.orgId, customer: req.params.id }).sort('-createdAt').limit(50));
}));

// Every patient's reminders in one list. status=active (default): running or paused;
// status=ended: stopped, or the supply end date has passed.
router.get('/reminders', roles('pharmacist', 'branch_manager'), wrap(async (req, res) => {
  const now = new Date();
  const f = req.query.status === 'ended'
    ? { org: req.orgId, $or: [{ active: false }, { endDate: { $lt: now } }] }
    : { org: req.orgId, active: true, $or: [{ endDate: null }, { endDate: { $gte: now } }] };
  const plans = await ReminderPlan.find(f).populate('customer', 'name phone consent anonymizedAt').populate('branch', 'name').populate('prescription', 'rxNo')
    .sort(req.query.status === 'ended' ? '-updatedAt' : '-createdAt').limit(300).lean();
  // When each plan last texted the patient, and how many doses it has sent.
  const sent = await ReminderLog.aggregate([
    { $match: { plan: { $in: plans.map((p) => p._id) }, status: 'sent' } },
    { $group: { _id: '$plan', count: { $sum: 1 }, last: { $max: '$createdAt' } } },
  ]);
  const byPlan = new Map(sent.map((x) => [String(x._id), x]));
  res.json(plans.filter((p) => p.customer && !p.customer.anonymizedAt).map((p) => {
    const s = byPlan.get(String(p._id));
    return { ...p, sentCount: s?.count || 0, lastSentAt: s?.last, canSend: !!p.customer.consent?.communications };
  }));
}));

// Pharmacist sets up a reminder by hand (e.g. directions the system could not read).
router.post('/reminders', roles('pharmacist', 'branch_manager'), writable, wrap(async (req, res) => {
  const { customer, medicine, dose, times, days, prescription, product } = req.body;
  const c = await Customer.findOne({ _id: customer, org: req.orgId });
  if (!c) throw notFound('Customer not found');
  if (!medicine) throw bad('Medicine name is required');
  if (prescription && !(await Prescription.exists({ _id: prescription, org: req.orgId }))) throw bad('Unknown prescription');
  const start = new Date();
  const plan = await ReminderPlan.create({
    org: req.orgId, customer: c._id, prescription, product, medicine, dose, times: cleanTimes(times), startDate: start,
    endDate: Number(days) > 0 ? new Date(start.getTime() + Number(days) * 86400000) : undefined, refill: !!prescription, createdBy: req.user.name,
  });
  await audit(req, 'reminder.create', 'ReminderPlan', plan._id, `Medication reminder set for ${c.name}: ${medicine} at ${plan.times.join(', ')}`);
  res.status(201).json(plan);
}));

router.patch('/reminders/:id', roles('pharmacist', 'branch_manager'), writable, wrap(async (req, res) => {
  const plan = await ReminderPlan.findOne({ _id: req.params.id, org: req.orgId });
  if (!plan) throw notFound();
  if (req.body.times) plan.times = cleanTimes(req.body.times);
  if (req.body.paused !== undefined) plan.paused = !!req.body.paused;
  if (req.body.days !== undefined) plan.endDate = Number(req.body.days) > 0 ? new Date(plan.startDate.getTime() + Number(req.body.days) * 86400000) : undefined;
  if (req.body.stop) { plan.active = false; plan.stoppedBy = req.user.name; }
  await plan.save();
  await audit(req, 'reminder.update', 'ReminderPlan', plan._id, `Medication reminder for ${plan.medicine} ${plan.active ? (plan.paused ? 'paused' : 'updated') : 'stopped'}`);
  res.json(plan);
}));

// Send one reminder now, to check the patient receives it.
router.post('/reminders/:id/test', roles('pharmacist', 'branch_manager'), writable, wrap(async (req, res) => {
  const plan = await ReminderPlan.findOne({ _id: req.params.id, org: req.orgId });
  if (!plan) throw notFound();
  const c = await Customer.findById(plan.customer);
  const org = await Organization.findById(req.orgId, 'name');
  const n = await notify(c, doseText(plan, c, org.name, plan.times[0] || 'next'), { event: 'dose_reminder', reminder: true });
  res.json({ status: n.status, reason: n.skippedReason, message: n.message });
}));

// Run the reminder sweep now (it also runs every minute on the server).
router.post('/reminders/run', roles('branch_manager'), writable, wrap(async (req, res) => res.json(await runReminders(new Date()))));

module.exports = router;

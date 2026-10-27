// Medication reminders: dose-time SMS from the prescription's directions, and a refill-due
// reminder before the supply runs out (FR-RX-10, CP-NOT-02). Schedule logic here is pure so it
// can be unit-tested; sending lives in runReminders().

// Map common directions (English and Latin abbreviations) to local clock times.
const PATTERNS = [
  [/\b(q\.?d\.?s|qid|four times|4 ?x|4 times)\b/i, ['07:00', '12:00', '17:00', '22:00']],
  [/\b(t\.?d\.?s|tid|three times|3 ?x|3 times|thrice)\b/i, ['07:00', '14:00', '21:00']],
  [/\bevery 6 ?h(ou)?rs?\b/i, ['06:00', '12:00', '18:00', '00:00']],
  [/\bevery 8 ?h(ou)?rs?\b/i, ['06:00', '14:00', '22:00']],
  [/\b(b\.?d\.?|bid|twice|2 ?x|2 times|every 12 ?h(ou)?rs?)\b/i, ['08:00', '20:00']],
  [/\b(nocte|at night|bedtime|before bed|night)\b/i, ['21:00']],
  [/\b(mane|morning)\b/i, ['08:00']],
  [/\b(o\.?d\.?|once|daily|1 ?x|every day|each day|stat)\b/i, ['08:00']],
];

const timesFor = (frequency) => {
  const f = String(frequency || '');
  for (const [re, times] of PATTERNS) if (re.test(f)) return [...times];
  return null; // unknown: pharmacist picks times
};

// "7 days", "2 weeks", "1 month", "10/7" (7 = days), "x5d"
const daysFor = (duration) => {
  const d = String(duration || '').toLowerCase();
  let m = d.match(/(\d+)\s*\/\s*(7|52|12)/);
  if (m) return Number(m[1]) * ({ 7: 1, 52: 7, 12: 30 })[m[2]];
  m = d.match(/(\d+)\s*(d|day|days|w|wk|week|weeks|m|month|months)\b/);
  if (!m) return null;
  const n = Number(m[1]); const u = m[2];
  return u.startsWith('w') ? n * 7 : (u === 'm' || u.startsWith('month')) ? n * 30 : n;
};

// Plan from one prescription line. Supply length comes from the duration, else qty / doses a day.
const planFromDirections = ({ frequency, duration, qty }) => {
  const times = timesFor(frequency);
  const perDay = times ? times.length : null;
  let days = daysFor(duration);
  if (!days && perDay && qty) days = Math.max(1, Math.floor(qty / perDay));
  return { times, days };
};

const validTime = (t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t);

// Local date and HH:MM for an instant in a time zone (Ghana is UTC+0 all year).
const localParts = (date, tz = 'Africa/Accra') => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
};
const minutes = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

// Dose slots that are due now: their time has passed today, within the catch-up window, and the
// plan is running. Returns slot keys like "2026-10-27 08:00"; the caller sends each key once.
const dueSlots = (plan, now = new Date(), { tz = 'Africa/Accra', windowMin = 30 } = {}) => {
  if (!plan.active || plan.paused) return [];
  if (plan.startDate && now < new Date(plan.startDate)) return [];
  if (plan.endDate && now > new Date(plan.endDate)) return [];
  const { day, time } = localParts(now, tz);
  const nowMin = minutes(time);
  return (plan.times || []).filter((t) => validTime(t) && nowMin >= minutes(t) && nowMin - minutes(t) < windowMin).map((t) => `${day} ${t}`);
};

module.exports = { timesFor, daysFor, planFromDirections, dueSlots, localParts, validTime };

/* ---------- Database side ---------- */
const db = () => require('../models');

// Creates (or replaces) reminder plans for the lines just dispensed on a prescription.
const plansFromDispensing = async ({ rx, lines, branch, by }) => {
  const { ReminderPlan, Organization, Customer } = db();
  if (!rx.customer) return [];
  const org = await Organization.findById(rx.org, 'settings.reminders');
  if (org?.settings?.reminders?.enabled === false) return [];
  const customer = await Customer.findById(rx.customer, 'anonymizedAt');
  if (!customer || customer.anonymizedAt) return [];
  const made = [];
  for (const l of lines) {
    const item = rx.items.find((i) => String(i.product) === String(l.product));
    if (!item) continue;
    const { times, days } = planFromDirections({ frequency: item.frequency, duration: item.duration, qty: l.qty });
    if (!times) continue; // directions we cannot read: the pharmacist can add times by hand
    const start = new Date();
    const end = days ? new Date(start.getTime() + days * 86400000) : undefined;
    await ReminderPlan.updateMany({ customer: rx.customer, product: item.product, active: true }, { active: false, stoppedBy: 'replaced by new dispensing' });
    made.push(await ReminderPlan.create({ org: rx.org, customer: rx.customer, prescription: rx._id, branch, product: item.product, medicine: item.name, dose: item.dose, times, startDate: start, endDate: end, refill: rx.refillsAllowed > 0, createdBy: by }));
  }
  return made;
};

// Message text. The medicine name goes in the SMS only if the patient agreed to us holding health
// data; otherwise the text stays generic, since others may see the phone.
const doseText = (plan, customer, pharmacy, time) => (customer.consent?.healthData
  ? `${pharmacy}: time for your ${time} dose of ${plan.medicine}${plan.dose ? ` (${plan.dose})` : ''}. Manage reminders in My orders on our website.`
  : `${pharmacy}: reminder to take your ${time} medicine. Manage reminders in My orders on our website.`);

// Sends due dose reminders and refill-due reminders. Safe to run every minute from several
// servers: each slot is claimed with a unique insert before sending.
const runReminders = async (now = new Date()) => {
  const { ReminderPlan, ReminderLog, Customer, Organization, Prescription } = db();
  const { notify } = require('./notify');
  const out = { dose: 0, refill: 0, skipped: 0 };
  const plans = await ReminderPlan.find({ active: true, paused: false, startDate: { $lte: now }, $or: [{ endDate: null }, { endDate: { $gte: new Date(now.getTime() - 4 * 86400000) } }] });
  const orgs = new Map();
  for (const plan of plans) {
    if (!orgs.has(String(plan.org))) orgs.set(String(plan.org), await Organization.findById(plan.org, 'name settings.reminders'));
    const org = orgs.get(String(plan.org));
    const tz = org?.settings?.reminders?.timezone || 'Africa/Accra';
    const customer = await Customer.findById(plan.customer);
    if (!customer || customer.anonymizedAt) continue;

    for (const slot of dueSlots(plan, now, { tz })) {
      try { await ReminderLog.create({ plan: plan._id, slot, status: 'claimed' }); } catch (e) { if (e.code === 11000) continue; throw e; }
      const n = await notify(customer, doseText(plan, customer, org?.name || 'Your pharmacy', slot.slice(11)), { event: 'dose_reminder', reminder: true });
      await ReminderLog.updateOne({ plan: plan._id, slot }, { status: n?.status });
      if (n?.status === 'sent') out.dose += 1; else out.skipped += 1;
    }

    // Refill due: a few days before the supply ends, once, if refills remain on the prescription.
    const before = org?.settings?.reminders?.refillDaysBefore ?? 3;
    if (plan.refill && plan.endDate && !plan.refillRemindedAt && now >= new Date(plan.endDate.getTime() - before * 86400000)) {
      const rx = plan.prescription ? await Prescription.findById(plan.prescription, 'rxNo status items refillsAllowed') : null;
      const item = rx?.items.find((i) => String(i.product) === String(plan.product));
      const left = item ? item.qty * (1 + (rx.refillsAllowed || 0)) - item.dispensedQty : 0;
      plan.refillRemindedAt = now; await plan.save();
      if (rx && left > 0 && rx.status !== 'rejected') {
        const text = customer.consent?.healthData
          ? `${org?.name || 'Your pharmacy'}: your ${plan.medicine} runs out around ${plan.endDate.toISOString().slice(0, 10)}. A refill is available on prescription ${rx.rxNo}; order it online or visit us.`
          : `${org?.name || 'Your pharmacy'}: a refill of your medicine is due soon (prescription ${rx.rxNo}). Order online or visit us.`;
        const n = await notify(customer, text, { event: 'refill_due', reminder: true });
        if (n?.status === 'sent') out.refill += 1; else out.skipped += 1;
      }
    }
  }
  return out;
};

module.exports.plansFromDispensing = plansFromDispensing;
module.exports.runReminders = runReminders;
module.exports.doseText = doseText;

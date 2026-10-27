const { Customer, Prescription, Order, Sale, Notification, Organization } = require('../models');
const { conflict } = require('../utils/http');

const MIN_CONTROLLED_YEARS = 2; // REG-04: controlled-drug records kept at least two years
const yearsAgo = (y) => new Date(Date.now() - y * 365 * 86400000);

// Anonymise a customer's personal data, keeping the records the pharmacy must retain (REG-17).
const anonymizeCustomer = async (c, retentionYears) => {
  const years = Math.max(retentionYears || MIN_CONTROLLED_YEARS, MIN_CONTROLLED_YEARS);
  const retained = await Prescription.countDocuments({ customer: c._id, hasControlled: true, createdAt: { $gte: yearsAgo(years) } });
  if (retained) throw conflict(`${retained} controlled-drug prescription(s) must be kept for ${years} years. Personal details on them are retained; the customer account can be anonymised after that.`);
  const active = await Order.countDocuments({ customer: c._id, status: { $in: ['pending_review', 'received', 'approved', 'packed', 'out_for_delivery'] } });
  if (active) throw conflict('Customer has open orders');
  if (c.balance > 0) throw conflict('Customer has an unpaid account balance');
  c.name = 'Erased customer'; c.phone = `erased-${c._id}`; c.email = undefined; c.addresses = []; c.allergies = []; c.conditions = [];
  c.consent = { communications: false, healthData: false, at: new Date() }; c.anonymizedAt = new Date(); c.otp = undefined;
  await c.save();
};

// Retention rules (REG-16). Returns counts; with apply=false it only previews.
const retentionRun = async (orgId, apply) => {
  const org = await Organization.findById(orgId);
  const r = org.settings.retention || {};
  const notifYears = Math.max(r.notificationsYears ?? 1, 0.25);
  const imageYears = Math.max(r.prescriptionImagesYears ?? 2, MIN_CONTROLLED_YEARS);
  const custYears = Math.max(r.inactiveCustomerYears ?? 6, 1);
  const out = { notificationsDeleted: 0, prescriptionImagesRemoved: 0, customersAnonymised: 0, customersKept: 0 };

  const nf = { org: orgId, createdAt: { $lt: yearsAgo(notifYears) } };
  out.notificationsDeleted = apply ? (await Notification.deleteMany(nf)).deletedCount : await Notification.countDocuments(nf);

  const rf = { org: orgId, image: { $exists: true, $ne: null }, createdAt: { $lt: yearsAgo(imageYears) } };
  out.prescriptionImagesRemoved = apply ? (await Prescription.updateMany(rf, { $unset: { image: 1 } })).modifiedCount : await Prescription.countDocuments(rf);

  const cutoff = yearsAgo(custYears);
  const candidates = await Customer.find({ org: orgId, anonymizedAt: null, updatedAt: { $lt: cutoff } });
  for (const c of candidates) {
    const recent = await Sale.exists({ customer: c._id, createdAt: { $gte: cutoff } })
      || await Order.exists({ customer: c._id, createdAt: { $gte: cutoff } })
      || await Prescription.exists({ customer: c._id, createdAt: { $gte: cutoff } });
    if (recent) continue;
    if (!apply) { out.customersAnonymised += 1; continue; }
    try { await anonymizeCustomer(c, org.settings.retentionYears); out.customersAnonymised += 1; } catch { out.customersKept += 1; }
  }
  return { ...out, rules: { notifYears, imageYears, custYears } };
};

const DEFAULT_ACTIVITIES = [
  { name: 'Customer accounts and online orders', purpose: 'Sell and deliver medicines and products; order updates', dataSubjects: 'Customers', dataCategories: 'Name, phone, email, delivery addresses, order history', lawfulBasis: 'Contract with the customer', recipients: 'SMS gateway; payment provider; couriers', retention: 'Until account erasure or inactivity period' },
  { name: 'Prescriptions and dispensing', purpose: 'Verify and dispense prescriptions safely; pharmacist counselling', dataSubjects: 'Patients, prescribers', dataCategories: 'Health data: prescriptions, allergies, conditions; prescriber name and registration', lawfulBasis: 'Provision of health care; legal obligation (pharmacy records)', recipients: 'Health-scheme insurers when claiming', retention: 'At least 2 years; controlled drugs 2 years after last register entry' },
  { name: 'Controlled-drug register', purpose: 'Legal record of receipt, supply and disposal of controlled drugs', dataSubjects: 'Patients, prescribers, staff', dataCategories: 'Names, addresses, quantities', lawfulBasis: 'Legal obligation (FDA guideline)', recipients: 'FDA / Pharmacy Council inspectors', retention: 'At least 2 years after the last entry' },
  { name: 'Sales and accounts', purpose: 'Receipts, tax, credit accounts', dataSubjects: 'Customers', dataCategories: 'Purchases, payments, account balances', lawfulBasis: 'Legal obligation (tax); contract', recipients: 'Accountants; tax authority', retention: 'As required by tax law' },
  { name: 'Staff accounts and audit log', purpose: 'Access control and accountability', dataSubjects: 'Staff', dataCategories: 'Name, email, role, pharmacist registration, activity log', lawfulBasis: 'Legitimate interest; legal obligation', recipients: 'Hosting provider', retention: 'Employment plus audit period' },
];

module.exports = { anonymizeCustomer, retentionRun, DEFAULT_ACTIVITIES, MIN_CONTROLLED_YEARS };

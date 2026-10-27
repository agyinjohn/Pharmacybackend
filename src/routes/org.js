const router = require('express').Router();
const { Organization, Branch, User, ROLES } = require('../models');
const { wrap, bad, notFound, forbidden } = require('../utils/http');
const { staff, roles, writable } = require('../middleware/auth');
const { audit } = require('../services/audit');


/* ---- Organisation settings ---- */
router.get('/org', wrap(async (req, res) => res.json(await Organization.findById(req.orgId))));
router.patch('/org', roles(), writable, wrap(async (req, res) => {
  const org = await Organization.findById(req.orgId);
  const before = org.toObject();
  ['name', 'dpcRegistration'].forEach((k) => { if (req.body[k] !== undefined) org[k] = req.body[k]; });
  if (req.body.settings) Object.assign(org.settings, req.body.settings);
  await org.save();
  await audit(req, 'org.update', 'Organization', org._id, 'Organisation settings updated', { before, after: org.toObject() });
  res.json(org);
}));

/* ---- Branches ---- */
router.get('/branches', wrap(async (req, res) => {
  const filter = { org: req.orgId };
  if (!['owner', 'auditor'].includes(req.user.role) && !req.query.all) filter._id = { $in: req.user.branches };
  res.json(await Branch.find(filter).sort('name'));
}));

router.post('/branches', roles(), writable, wrap(async (req, res) => {
  const { copyFrom, ...data } = req.body;
  if (!data.name || !data.code) throw bad('Branch name and code are required');
  if (copyFrom) {
    const src = await Branch.findOne({ _id: copyFrom, org: req.orgId });
    if (!src) throw notFound('Branch to copy not found');
    const { name, _id, id, createdAt, updatedAt, licenseNumber, licenseExpiry, superintendent, ...rest } = src.toObject();
    Object.assign(data, { ...rest, ...data }); // new branch inherits settings; licence details must be its own
  }
  const b = await Branch.create({ ...data, org: req.orgId });
  await audit(req, 'branch.create', 'Branch', b._id, `Branch ${b.name} created`, { after: b.toObject() });
  res.status(201).json(b);
}));

router.patch('/branches/:id', roles('branch_manager'), writable, wrap(async (req, res) => {
  if (req.user.role !== 'owner' && !req.user.branches.map(String).includes(req.params.id)) throw forbidden();
  const b = await Branch.findOne({ _id: req.params.id, org: req.orgId });
  if (!b) throw notFound();
  const before = b.toObject();
  const fields = ['name', 'address', 'phone', 'email', 'licenseNumber', 'licenseExpiry', 'superintendent', 'openingHours', 'taxId', 'receiptHeader', 'onlineEnabled', 'deliveryZones', 'location', 'active'];
  fields.forEach((k) => { if (req.body[k] !== undefined) b[k] = req.body[k]; });
  await b.save();
  await audit(req, 'branch.update', 'Branch', b._id, `Branch ${b.name} updated`, { before, after: b.toObject() });
  res.json(b);
}));

/* ---- Team ---- */
router.get('/users', roles('branch_manager', 'accountant'), wrap(async (req, res) => {
  const filter = { org: req.orgId };
  if (req.user.role !== 'owner') filter.branches = { $in: req.user.branches };
  res.json(await User.find(filter).sort('name'));
}));

router.post('/users', roles('branch_manager'), writable, wrap(async (req, res) => {
  const { name, email, password, role, branches = [], phone, pharmacistRegNo, pharmacistLicenseExpiry } = req.body;
  if (!name || !email || !password || !role) throw bad('Name, email, password and role are required');
  if (!ROLES.includes(role)) throw bad('Unknown role');
  if (password.length < 8) throw bad('Password must be at least 8 characters');
  if (req.user.role !== 'owner') {
    if (role === 'owner') throw forbidden('Only an owner can create owners');
    if (!branches.every((b) => req.user.branches.map(String).includes(String(b)))) throw forbidden('You can only assign your own branches');
  }
  if (role === 'pharmacist' && !pharmacistRegNo) throw bad('Pharmacist registration number is required');
  const valid = await Branch.countDocuments({ _id: { $in: branches }, org: req.orgId });
  if (valid !== branches.length) throw bad('Unknown branch');
  const u = new User({ org: req.orgId, name, email, role, branches, phone, pharmacistRegNo, pharmacistLicenseExpiry });
  await u.setPassword(password);
  await u.save();
  await audit(req, 'user.create', 'User', u._id, `User ${u.name} (${u.role}) created`);
  res.status(201).json(u);
}));

router.patch('/users/:id', roles('branch_manager'), writable, wrap(async (req, res) => {
  const u = await User.findOne({ _id: req.params.id, org: req.orgId });
  if (!u) throw notFound();
  if (req.user.role !== 'owner') {
    if (u.role === 'owner' || req.body.role === 'owner') throw forbidden('Only an owner can change owners');
    if (!u.branches.some((b) => req.user.branches.map(String).includes(String(b)))) throw forbidden();
  }
  const before = u.toObject();
  ['name', 'phone', 'role', 'branches', 'active', 'pharmacistRegNo', 'pharmacistLicenseExpiry'].forEach((k) => { if (req.body[k] !== undefined) u[k] = req.body[k]; });
  if (req.body.role && !ROLES.includes(req.body.role)) throw bad('Unknown role');
  if (req.body.password) { if (req.body.password.length < 8) throw bad('Password must be at least 8 characters'); await u.setPassword(req.body.password); }
  await u.save();
  await audit(req, 'user.update', 'User', u._id, `User ${u.name} updated`, { before, after: u.toObject() });
  res.json(u);
}));

module.exports = router;

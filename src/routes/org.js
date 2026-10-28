const router = require('express').Router();
const { Organization, Branch, User, SiteImage, ROLES } = require('../models');
const { parseImage } = require('../services/images');
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

/* ---- Website ---- */
// Images must be ones uploaded here, or https links; text is trimmed and capped so a page can't be flooded.
const SITE_IMG = /^\/images\/site\/[a-f0-9]{24}$/;
const imageUrl = (v) => {
  const s = String(v || '').trim();
  if (!s) return undefined;
  if (!SITE_IMG.test(s) && !/^https:\/\/\S+$/i.test(s)) throw bad('Images must be uploaded, or links starting with https://');
  return s;
};
const text = (v, max) => { const s = String(v ?? '').trim(); if (s.length > max) throw bad(`Keep text under ${max} characters`); return s || undefined; };
const link = (v) => { const s = text(v, 200); if (s && !/^https:\/\/\S+$/i.test(s)) throw bad('Social links must start with https://'); return s; };

router.get('/org/website', wrap(async (req, res) => res.json((await Organization.findById(req.orgId, 'website').lean()).website || {})));

router.patch('/org/website', roles('branch_manager'), writable, wrap(async (req, res) => {
  const b = req.body || {};
  const org = await Organization.findById(req.orgId);
  const color = String(b.brandColor || '').trim();
  if (color && !/^#[0-9a-f]{6}$/i.test(color)) throw bad('Brand colour must look like #1f5c4d');
  const services = (Array.isArray(b.services) ? b.services : []).map((x) => ({ title: text(x?.title, 60), text: text(x?.text, 240) })).filter((x) => x.title);
  if (services.length > 8) throw bad('At most 8 services');
  const gallery = (Array.isArray(b.gallery) ? b.gallery : []).map(imageUrl).filter(Boolean);
  if (gallery.length > 8) throw bad('At most 8 gallery photos');
  org.website = {
    published: b.published !== false,
    brandColor: color || undefined,
    logoUrl: imageUrl(b.logoUrl), heroImageUrl: imageUrl(b.heroImageUrl), aboutImageUrl: imageUrl(b.aboutImageUrl),
    headline: text(b.headline, 90), intro: text(b.intro, 300), about: text(b.about, 2000),
    services, gallery,
    contact: { phone: text(b.contact?.phone, 30), whatsapp: text(b.contact?.whatsapp, 30), email: text(b.contact?.email, 120) },
    social: { facebook: link(b.social?.facebook), instagram: link(b.social?.instagram), tiktok: link(b.social?.tiktok), x: link(b.social?.x) },
    showProducts: b.showProducts !== false,
  };
  await org.save();
  // Remove uploads the site no longer uses (older than a day, so an upload waiting to be saved is kept).
  const used = [org.website.logoUrl, org.website.heroImageUrl, org.website.aboutImageUrl, ...gallery].filter((u) => u && SITE_IMG.test(u)).map((u) => u.split('/').pop());
  await SiteImage.deleteMany({ org: req.orgId, _id: { $nin: used }, createdAt: { $lt: new Date(Date.now() - 86400000) } });
  await audit(req, 'website.update', 'Organization', org._id, `Website ${org.website.published ? 'updated' : 'updated and hidden'}`);
  res.json(org.toObject().website);
}));

router.post('/org/website/images', roles('branch_manager'), writable, wrap(async (req, res) => {
  if ((await SiteImage.countDocuments({ org: req.orgId })) >= 40) throw bad('Too many website photos. Save the website to clear unused ones, then try again.');
  const img = await SiteImage.create({ org: req.orgId, ...parseImage(req.body.image) });
  res.status(201).json({ url: `/images/site/${img._id}` });
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

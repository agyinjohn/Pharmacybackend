const router = require('express').Router();
const { Organization, Branch, User, Lead } = require('../models');
const { wrap, bad, HttpError } = require('../utils/http');
const { signStaff, staff } = require('../middleware/auth');
const { audit } = require('../services/audit');

const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'pharmacy';

const session = async (user) => {
  const branches = user.role === 'owner' || user.role === 'auditor'
    ? await Branch.find({ org: user.org, active: true }).sort('name')
    : await Branch.find({ _id: { $in: user.branches }, active: true }).sort('name');
  const org = await Organization.findById(user.org);
  return { token: signStaff(user), user, org, branches };
};

// Self-service sign-up for a new pharmacy business (the SaaS tenant) and its first branch.
router.post('/register', wrap(async (req, res) => {
  const { orgName, name, email, password, branchName, address, phone, licenseNumber } = req.body;
  if (!orgName || !name || !email || !password) throw bad('Pharmacy name, your name, email and password are required');
  if (password.length < 8) throw bad('Password must be at least 8 characters');
  if (await User.exists({ email: email.toLowerCase() })) throw new HttpError(409, 'An account with that email already exists');

  let slug = slugify(orgName);
  if (await Organization.exists({ slug })) slug = `${slug}-${Math.random().toString(36).slice(2, 6)}`;
  const org = await Organization.create({ name: orgName, slug });
  const branch = await Branch.create({
    org: org._id, name: branchName || 'Main branch', code: 'MAIN', address, phone, licenseNumber,
    deliveryZones: [{ name: 'Within 5 km', fee: 10, etaMins: 60 }],
  });
  const user = new User({ org: org._id, name, email, role: 'owner', branches: [branch._id] });
  await user.setPassword(password);
  await user.save();
  req.user = user; req.orgId = org._id;
  await audit(req, 'org.register', 'Organization', org._id, `Organisation ${orgName} registered`);
  res.status(201).json(await session(user));
}));

router.post('/login', wrap(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) throw bad('Email and password are required');
  const user = await User.findOne({ email: String(email).toLowerCase() }).select('+passwordHash');
  if (!user || !user.active || !(await user.checkPassword(password))) throw new HttpError(401, 'Incorrect email or password');
  user.lastLoginAt = new Date();
  await user.save();
  req.user = user; req.orgId = user.org;
  await audit(req, 'auth.login', 'User', user._id, `${user.name} signed in`);
  res.json(await session(user));
}));

router.get('/me', staff, wrap(async (req, res) => res.json(await session(req.user))));

// Demo-request form on the marketing site.
router.post('/leads', wrap(async (req, res) => {
  const { name, email, phone, pharmacy, branches, message } = req.body;
  if (!name || !email) throw bad('Name and email are required');
  await Lead.create({ name, email, phone, pharmacy, branches, message });
  res.status(201).json({ ok: true });
}));

module.exports = router;

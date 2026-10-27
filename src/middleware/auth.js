const jwt = require('jsonwebtoken');
const { jwtSecret } = require('../config');
const { HttpError, forbidden } = require('../utils/http');
const { User, Customer } = require('../models');

const signStaff = (user) => jwt.sign({ sub: user.id, kind: 'staff' }, jwtSecret, { expiresIn: '12h' });
const signCustomer = (c) => jwt.sign({ sub: c.id, kind: 'customer' }, jwtSecret, { expiresIn: '30d' });

const readToken = (req) => {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
};

const verify = (req, kind) => {
  const token = readToken(req);
  if (!token) throw new HttpError(401, 'Authentication required');
  let payload;
  try {
    payload = jwt.verify(token, jwtSecret);
  } catch {
    throw new HttpError(401, 'Session expired, please sign in again');
  }
  if (payload.kind !== kind) throw new HttpError(401, 'Wrong account type');
  return payload;
};

// Staff authentication. Resolves req.user and req.orgId.
const staff = async (req, res, next) => {
  try {
    const payload = verify(req, 'staff');
    const user = await User.findById(payload.sub);
    if (!user || !user.active) throw new HttpError(401, 'Account disabled');
    req.user = user;
    req.orgId = user.org;
    next();
  } catch (e) {
    next(e);
  }
};

const customer = async (req, res, next) => {
  try {
    const payload = verify(req, 'customer');
    const c = await Customer.findById(payload.sub);
    if (!c) throw new HttpError(401, 'Account not found');
    req.customer = c;
    req.orgId = c.org;
    next();
  } catch (e) {
    next(e);
  }
};

// Role gate. Owners always pass.
const roles = (...allowed) => (req, res, next) => {
  if (req.user.role === 'owner' || allowed.includes(req.user.role)) return next();
  return next(forbidden());
};

const userBranchIds = (user) => (user.role === 'owner' || user.role === 'auditor' ? null : user.branches.map(String));

// Resolves the branch the request works on (x-branch-id header or ?branch=) and checks the
// user may use it. Owners and auditors may use any branch within their organisation.
const branch = (required = true) => async (req, res, next) => {
  try {
    const id = req.headers['x-branch-id'] || req.query.branch || req.body?.branch;
    if (!id || id === 'all') {
      if (required) throw new HttpError(400, 'Select a branch first');
      req.branchId = null;
      return next();
    }
    const allowed = userBranchIds(req.user);
    if (allowed && !allowed.includes(String(id))) throw forbidden('You are not assigned to that branch');
    const { Branch } = require('../models');
    const b = await Branch.findOne({ _id: id, org: req.orgId });
    if (!b) throw new HttpError(404, 'Branch not found');
    req.branch = b;
    req.branchId = b._id;
    next();
  } catch (e) {
    next(e);
  }
};

// Auditors are read-only everywhere.
const writable = (req, res, next) => (req.user.role === 'auditor' ? next(forbidden('Read-only account')) : next());

module.exports = { signStaff, signCustomer, staff, customer, roles, branch, writable, userBranchIds };

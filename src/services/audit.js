const { AuditLog } = require('../models');

// Fire-and-forget would risk losing entries, so callers await it. A failed audit write must not
// silently pass, so errors propagate.
const audit = (req, action, entity, entityId, summary, extra = {}) => AuditLog.create({
  org: req.orgId || req.user?.org,
  branch: req.branchId || undefined,
  user: req.user?._id,
  userName: req.user?.name || (req.customer ? `Customer ${req.customer.name}` : undefined),
  action,
  entity,
  entityId: entityId ? String(entityId) : undefined,
  summary,
  before: extra.before,
  after: extra.after,
  ip: req.ip,
});

module.exports = { audit };

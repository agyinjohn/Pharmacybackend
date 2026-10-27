const { Notification } = require('../models');

// Notification service. Records every message; delivery is a stub until an SMS gateway / email
// provider is connected (requirements section 9). Reminders and other marketing-style messages
// respect the customer's consent; transactional messages (order status, OTP) always go out.
const notify = async (customer, message, { event = 'order', reminder = false } = {}) => {
  if (!customer) return null;
  let status = 'sent'; let skippedReason;
  if (reminder && customer.consent?.communications === false) { status = 'skipped'; skippedReason = 'customer opted out'; }
  if (reminder && !customer.consent?.communications) { status = 'skipped'; skippedReason = 'no communication consent recorded'; }
  const n = await Notification.create({ org: customer.org, customer: customer._id, phone: customer.phone, event, message, status, skippedReason });
  if (status === 'sent' && process.env.NODE_ENV !== 'test') console.log(`[notify] SMS to ${customer.phone}: ${message}`);
  return n;
};
module.exports = { notify };

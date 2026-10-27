const { Notification } = require('../models');
const sms = require('./sms');

// Notification service. Records every message; delivery is a stub until an SMS gateway / email
// provider is connected (requirements section 9). Reminders and other marketing-style messages
// respect the customer's consent; transactional messages (order status, OTP) always go out.
const notify = async (customer, message, { event = 'order', reminder = false } = {}) => {
  if (!customer) return null;
  let status = 'sent'; let skippedReason;
  if (reminder && customer.consent?.communications === false) { status = 'skipped'; skippedReason = 'customer opted out'; }
  if (reminder && !customer.consent?.communications) { status = 'skipped'; skippedReason = 'no communication consent recorded'; }
  if (status === 'sent') {
    // A failing gateway must never break the business action that triggered the message.
    try { await sms.send(customer.phone, message); } catch (e) { status = 'failed'; skippedReason = e.message; }
  }
  return Notification.create({ org: customer.org, customer: customer._id, phone: customer.phone, event, message, status, skippedReason });
};
module.exports = { notify };

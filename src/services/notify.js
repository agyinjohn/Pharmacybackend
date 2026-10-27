// Notification stub. In production this calls the SMS gateway / email provider (requirements
// section 9). For the demo it logs, and callers also record the event on the order history.
const notify = async (customer, message) => {
  if (process.env.NODE_ENV !== 'test') console.log(`[notify] SMS to ${customer?.phone || 'n/a'}: ${message}`);
};
module.exports = { notify };

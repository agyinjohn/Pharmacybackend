// SMS delivery adapter. Choose with SMS_PROVIDER:
//   log      (default) print to the server log
//   arkesel  Arkesel v1 HTTP API  (ARKESEL_API_KEY, SMS_SENDER_ID)
//   webhook  POST {to, message} as JSON to SMS_WEBHOOK_URL (optional SMS_WEBHOOK_TOKEN bearer), for any gateway
// UNVERIFIED against live gateways: check each provider's current API before relying on it.
const provider = () => (process.env.SMS_PROVIDER || 'log').toLowerCase();

const toMsisdn = (phone) => String(phone).replace(/[^\d]/g, '').replace(/^0/, '233');

const send = async (phone, message) => {
  const p = provider();
  if (p === 'arkesel') {
    const url = new URL('https://sms.arkesel.com/sms/api');
    url.search = new URLSearchParams({ action: 'send-sms', api_key: process.env.ARKESEL_API_KEY || '', to: toMsisdn(phone), from: process.env.SMS_SENDER_ID || 'PharmaOne', sms: message });
    const res = await fetch(url);
    if (!res.ok) throw new Error(`SMS gateway returned ${res.status}`);
    return;
  }
  if (p === 'webhook') {
    const res = await fetch(process.env.SMS_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(process.env.SMS_WEBHOOK_TOKEN && { Authorization: `Bearer ${process.env.SMS_WEBHOOK_TOKEN}` }) },
      body: JSON.stringify({ to: toMsisdn(phone), message }),
    });
    if (!res.ok) throw new Error(`SMS webhook returned ${res.status}`);
    return;
  }
  if (process.env.NODE_ENV !== 'test') console.log(`[sms] to ${phone}: ${message}`);
};

module.exports = { send, provider };

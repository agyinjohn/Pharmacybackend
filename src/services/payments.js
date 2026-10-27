const crypto = require('crypto');

// Online payment adapter. With PAYSTACK_SECRET_KEY set, card and mobile-money orders go through
// Paystack's hosted checkout (no card data touches this system). Without it, payments are
// simulated as instantly paid so demos work. UNVERIFIED against live Paystack: test with their
// sandbox keys before go-live.
const PAYSTACK = 'https://api.paystack.co';
const enabled = () => !!process.env.PAYSTACK_SECRET_KEY;
const headers = () => ({ Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' });

const initialize = async ({ email, amount, reference, callbackUrl, method }) => {
  const res = await fetch(`${PAYSTACK}/transaction/initialize`, {
    method: 'POST', headers: headers(),
    body: JSON.stringify({ email, amount: Math.round(amount * 100), currency: 'GHS', reference, callback_url: callbackUrl, channels: method === 'momo' ? ['mobile_money'] : ['card'] }),
  });
  const data = await res.json();
  if (!res.ok || !data.status) throw new Error(data.message || 'Payment provider error');
  return { authUrl: data.data.authorization_url };
};

const verify = async (reference) => {
  const res = await fetch(`${PAYSTACK}/transaction/verify/${encodeURIComponent(reference)}`, { headers: headers() });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || 'Payment provider error');
  return { paid: data.data?.status === 'success', amount: (data.data?.amount || 0) / 100 };
};

const refund = async (reference, amount) => {
  const res = await fetch(`${PAYSTACK}/refund`, { method: 'POST', headers: headers(), body: JSON.stringify({ transaction: reference, ...(amount && { amount: Math.round(amount * 100) }) }) });
  const data = await res.json();
  if (!res.ok || !data.status) throw new Error(data.message || 'Refund failed');
};

const validWebhook = (rawBody, signature) => {
  if (!enabled() || !signature) return false;
  const h = crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY).update(rawBody).digest('hex');
  return h.length === signature.length && crypto.timingSafeEqual(Buffer.from(h), Buffer.from(signature));
};

module.exports = { enabled, initialize, verify, refund, validWebhook };

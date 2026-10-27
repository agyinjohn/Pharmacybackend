const router = require('express').Router();
const { Organization, Branch, Product, Batch, Customer, Order, Prescription } = require('../models');
const { wrap, bad, notFound, conflict, HttpError, escapeRegex, round2, seq } = require('../utils/http');
const { customer, signCustomer } = require('../middleware/auth');
const { audit } = require('../services/audit');
const { priceFor, oid } = require('../services/stock');
const { otpDemoCode, isProd } = require('../config');
const { cancelOrder } = require('./orders');
const payments = require('../services/payments');
const { notify } = require('../services/notify');
const { deductFefo, restore } = require('../services/stock');
const { webUrl } = require('../config');
const { priceBasket, bestPromo } = require('../services/pricing');
const { Promotion } = require('../models');

// Public customer portal API. Everything is scoped by pharmacy slug; controlled drugs are never exposed (REG-14).
const loadOrg = wrap(async (req, res, next) => {
  const org = await Organization.findOne({ slug: req.params.slug });
  if (!org) throw notFound('Pharmacy not found');
  req.org = org; req.orgId = org._id;
  next();
});

const branchPublic = (b) => ({
  _id: b._id, name: b.name, address: b.address, phone: b.phone, email: b.email, openingHours: b.openingHours,
  licenseNumber: b.licenseNumber, licenseExpiry: b.licenseExpiry, superintendent: b.superintendent,
  deliveryZones: b.deliveryZones, location: b.location,
  online: !!(b.onlineEnabled && b.active && b.licenseExpiry && b.licenseExpiry > new Date()),
});

router.get('/directory', wrap(async (req, res) => {
  const orgs = await Organization.find({}, 'name slug').limit(50);
  res.json(orgs);
}));

router.get('/orders/mine', customer, wrap(async (req, res) => {
  res.json(await Order.find({ customer: req.customer._id }).populate('branch', 'name phone address').sort('-createdAt').limit(50));
}));

router.get('/me', customer, wrap(async (req, res) => {
  const { otp, ...c } = req.customer.toObject();
  res.json(c);
}));

router.patch('/me', customer, wrap(async (req, res) => {
  const c = req.customer;
  ['name', 'email', 'addresses', 'allergies', 'conditions'].forEach((k) => { if (req.body[k] !== undefined) c[k] = req.body[k]; });
  if (req.body.consent) c.consent = { ...req.body.consent, at: new Date() };
  await c.save();
  await audit(req, 'customer.self_update', 'Customer', c._id, 'Customer updated their profile');
  res.json(c);
}));

// Right of access (REG-17): a customer can download everything we hold about them.
router.get('/me/export', customer, wrap(async (req, res) => {
  const [orders, prescriptions] = await Promise.all([Order.find({ customer: req.customer._id }), Prescription.find({ customer: req.customer._id }, '-image')]);
  await audit(req, 'customer.export', 'Customer', req.customer._id, 'Customer exported their data');
  res.json({ profile: req.customer, orders, prescriptions });
}));

router.post('/me/erasure-request', customer, wrap(async (req, res) => {
  req.customer.erasureRequestedAt = new Date();
  await req.customer.save();
  await audit(req, 'privacy.request', 'Customer', req.customer._id, 'Customer asked for their data to be erased');
  res.json({ ok: true, message: 'Request received. The pharmacy will confirm what can be erased; records it must legally keep (such as controlled-drug prescriptions) stay for the required period.' });
}));

router.get('/me/prescriptions', customer, wrap(async (req, res) => {
  res.json(await Prescription.find({ customer: req.customer._id }, '-image').sort('-createdAt').limit(50));
}));

router.get('/orders/:id', customer, wrap(async (req, res) => {
  const o = await Order.findOne({ _id: req.params.id, customer: req.customer._id }).populate('branch', 'name phone address');
  if (!o) throw notFound();
  res.json(o);
}));

router.post('/orders/:id/cancel', customer, wrap(async (req, res) => {
  const o = await Order.findOne({ _id: req.params.id, customer: req.customer._id }).populate('customer');
  if (!o) throw notFound();
  const r = await cancelOrder(o, `Customer ${o.customer.name}`, req.body.reason || 'Cancelled by customer');
  await audit(req, 'order.cancel', 'Order', o._id, `Customer cancelled ${o.orderNo}`);
  res.json(r);
}));

router.post('/orders/:id/message', customer, wrap(async (req, res) => {
  if (!req.body.text) throw bad('Message text is required');
  const o = await Order.findOneAndUpdate({ _id: req.params.id, customer: req.customer._id }, { $push: { messages: { from: 'customer', text: req.body.text } } }, { returnDocument: 'after' });
  if (!o) throw notFound();
  res.json(o);
}));

/* ---- Slug-scoped ---- */
router.get('/:slug', loadOrg, wrap(async (req, res) => {
  const branches = await Branch.find({ org: req.orgId, active: true }).sort('name');
  res.json({ name: req.org.name, slug: req.org.slug, dpcRegistration: req.org.dpcRegistration, codEnabled: req.org.settings.codEnabled, branches: branches.map(branchPublic) });
}));

router.get('/:slug/products', loadOrg, wrap(async (req, res) => {
  const { q, category, branch } = req.query;
  const f = { org: req.orgId, active: true, legalStatus: { $ne: 'controlled' } };
  if (category && category !== 'all') f.$or = [{ category }, { symptoms: category }];
  if (q) {
    const rx = new RegExp(escapeRegex(q), 'i');
    f.$and = [{ $or: [{ brand: rx }, { generic: rx }, { category: rx }, { symptoms: rx }] }];
  }
  const products = await Product.find(f).sort('brand').limit(120);
  const promos = await Promotion.find({ org: req.orgId, active: true });
  let stock = new Map();
  if (branch) {
    const rows = await Batch.aggregate([
      { $match: { org: oid(req.orgId), branch: oid(branch), status: 'active', qty: { $gt: 0 }, expiry: { $gt: new Date() } } },
      { $group: { _id: '$product', qty: { $sum: '$qty' } } },
    ]);
    stock = new Map(rows.map((r) => [String(r._id), r.qty]));
  }
  res.json(products.map((p) => ({
    _id: p._id, brand: p.brand, generic: p.generic, strength: p.strength, form: p.form, packSize: p.packSize, category: p.category,
    price: branch ? priceFor(p, branch) : p.price, requiresRx: p.legalStatus === 'prescription_only', legalStatus: p.legalStatus,
    taxRate: p.taxRate, stock: stock.get(String(p._id)) || 0, inStock: (stock.get(String(p._id)) || 0) > 0,
    promo: bestPromo(promos, { p, qty: 1 }, branch ? priceFor(p, branch) : p.price, { channel: 'online', branch, now: new Date() })?.name
      || promos.find((pr) => pr.type === 'bogo' && pr.active && (!pr.products.length || pr.products.some((x) => String(x) === String(p._id))) && p.legalStatus !== 'prescription_only')?.name,
  })));
}));

router.get('/:slug/categories', loadOrg, wrap(async (req, res) => {
  const cats = await Product.distinct('category', { org: req.orgId, active: true, legalStatus: { $ne: 'controlled' } });
  const symptoms = await Product.distinct('symptoms', { org: req.orgId, active: true, legalStatus: { $ne: 'controlled' } });
  res.json({ categories: cats.sort(), symptoms: symptoms.sort() });
}));

router.get('/:slug/products/:id/alternatives', loadOrg, wrap(async (req, res) => {
  const p = await Product.findOne({ _id: req.params.id, org: req.orgId });
  if (!p || !p.generic) return res.json([]);
  const subs = await Product.find({ org: req.orgId, _id: { $ne: p._id }, active: true, legalStatus: { $ne: 'controlled' }, generic: new RegExp(`^${escapeRegex(p.generic)}$`, 'i') });
  const rows = req.query.branch ? await Batch.aggregate([{ $match: { branch: oid(req.query.branch), product: { $in: subs.map((s) => s._id) }, status: 'active', qty: { $gt: 0 }, expiry: { $gt: new Date() } } }, { $group: { _id: '$product', qty: { $sum: '$qty' } } }]) : [];
  const m = new Map(rows.map((r) => [String(r._id), r.qty]));
  res.json(subs.map((s) => ({ _id: s._id, brand: s.brand, strength: s.strength, price: s.price, requiresRx: s.legalStatus === 'prescription_only', stock: m.get(String(s._id)) || 0 })));
}));

/* ---- Sign-in with one-time code (CP-ACC-01) ---- */
router.post('/:slug/auth/request-otp', loadOrg, wrap(async (req, res) => {
  const phone = String(req.body.phone || '').replace(/\s+/g, '');
  if (!/^\+?\d{9,15}$/.test(phone)) throw bad('Enter a valid phone number');
  let c = await Customer.findOne({ org: req.orgId, phone });
  if (!c) {
    if (!req.body.name) return res.status(200).json({ newCustomer: true });
    c = new Customer({ org: req.orgId, name: req.body.name, phone, email: req.body.email });
  }
  c.otp = { code: isProd ? String(Math.floor(100000 + Math.random() * 900000)) : otpDemoCode, expiresAt: new Date(Date.now() + 10 * 60000), tries: 0 };
  await c.save();
  console.log(`[notify] OTP for ${phone}: ${c.otp.code}`);
  res.json({ sent: true, ...(isProd ? {} : { demoCode: c.otp.code }) });
}));

router.post('/:slug/auth/verify', loadOrg, wrap(async (req, res) => {
  const phone = String(req.body.phone || '').replace(/\s+/g, '');
  const c = await Customer.findOne({ org: req.orgId, phone });
  if (!c || !c.otp?.code) throw new HttpError(401, 'Request a code first');
  if (c.otp.tries >= 5 || c.otp.expiresAt < new Date()) throw new HttpError(401, 'Code expired, request a new one');
  if (String(req.body.code) !== c.otp.code) { c.otp.tries += 1; await c.save(); throw new HttpError(401, 'Incorrect code'); }
  c.otp = undefined;
  if (req.body.consent) c.consent = { ...req.body.consent, at: new Date() };
  await c.save();
  const { otp, ...safe } = c.toObject();
  res.json({ token: signCustomer(c), customer: safe });
}));

/* ---- Checkout ---- */
router.post('/:slug/orders', loadOrg, customer, wrap(async (req, res) => {
  if (String(req.customer.org) !== String(req.org._id)) throw new HttpError(403, 'Account belongs to another pharmacy');
  const { branch: branchId, items, fulfilment = 'delivery', address, payment, prescriptionImage, refillOf, note } = req.body;
  if (!items?.length) throw bad('Your cart is empty');
  const b = await Branch.findOne({ _id: branchId, org: req.orgId });
  if (!b) throw bad('Choose a branch');
  if (!branchPublic(b).online) throw conflict('This branch is not taking online orders right now'); // REG-11: licence lapse switches it off
  const prods = await Product.find({ _id: { $in: items.map((i) => i.product) }, org: req.orgId, active: true });
  const lines = items.map((i) => {
    const p = prods.find((x) => String(x._id) === String(i.product));
    const qty = Number(i.qty);
    if (!p || !Number.isInteger(qty) || qty < 1) throw bad('Invalid item in cart');
    if (p.legalStatus === 'controlled') throw conflict(`${p.brand} cannot be ordered online`);
    return { p, qty };
  });
  // Real availability per branch (CP-ACC-03).
  const rows = await Batch.aggregate([{ $match: { org: oid(req.orgId), branch: oid(b._id), status: 'active', qty: { $gt: 0 }, expiry: { $gt: new Date() }, product: { $in: lines.map((l) => l.p._id) } } }, { $group: { _id: '$product', qty: { $sum: '$qty' } } }]);
  for (const l of lines) {
    const have = rows.find((r) => String(r._id) === String(l.p._id))?.qty || 0;
    if (have < l.qty) throw conflict(`${l.p.brand} is out of stock at ${b.name} (${have} left)`);
  }

  const rxLines = lines.filter((l) => l.p.legalStatus === 'prescription_only');
  let prescription = null;
  if (rxLines.length) {
    if (refillOf) {
      prescription = await Prescription.findOne({ _id: refillOf, customer: req.customer._id });
      if (!prescription || !['verified', 'partial'].includes(prescription.status)) throw bad('That prescription cannot be refilled');
    } else if (prescriptionImage) {
      if (String(prescriptionImage).length > 6_000_000) throw bad('Prescription image is too large (max ~4 MB)');
      prescription = await Prescription.create({
        org: req.orgId, branch: b._id, rxNo: seq('RX'), customer: req.customer._id, patientName: req.customer.name,
        prescriber: { name: 'As on uploaded prescription' }, source: 'online', image: prescriptionImage,
        items: rxLines.map((l) => ({ product: l.p._id, name: l.p.brand, qty: l.qty })),
      });
    } else {
      throw bad('Upload a photo or PDF of your prescription for prescription-only medicines');
    }
  }

  let deliveryFee = 0; let etaMins; let addr;
  if (fulfilment === 'delivery') {
    const zone = b.deliveryZones.find((z) => z.name === address?.zone);
    if (!address?.line || !zone) throw bad('Choose a delivery address and zone');
    deliveryFee = zone.fee; etaMins = zone.etaMins; addr = { line: address.line, digitalAddress: address.digitalAddress, zone: zone.name };
  }
  const method = payment?.method;
  if (!['momo', 'card', 'cod'].includes(method)) throw bad('Choose a payment method');
  if (method === 'cod' && (!req.org.settings.codEnabled || fulfilment !== 'delivery')) throw conflict('Pay on delivery is not available');

  const priced = priceBasket(lines.map((l) => ({ p: l.p, qty: l.qty, unitPrice: priceFor(l.p, b._id) })), { promos: await Promotion.find({ org: req.orgId, active: true }), channel: 'online', branch: b._id });
  const { subtotal, tax } = priced;
  const discount = priced.promoDiscount;
  const total = round2(priced.total + deliveryFee);
  const live = method !== 'cod' && payments.enabled(); // real provider: hold stock until paid
  const reference = seq('PAY');
  const status = rxLines.length ? 'pending_review' : 'received';
  const order = new Order({
    org: req.orgId, branch: b._id, orderNo: seq('ON'), customer: req.customer._id, prescription: prescription?._id, fulfilment, address: addr,
    deliveryFee, etaMins, subtotal, discount, tax, total,
    // Without a provider key payment is simulated as paid; production never stores card data (CP-PAY-01).
    payment: method === 'cod' ? { method, status: 'pending' } : live ? { method, status: 'pending', reference, provider: 'paystack' } : { method, status: 'paid', reference },
    status,
    items: priced.lines.map((l) => ({ product: l.p._id, name: `${l.p.brand}${l.p.strength ? ' ' + l.p.strength : ''}`, qty: l.qty, unitPrice: l.unitPrice, taxRate: l.p.taxRate, requiresRx: l.p.legalStatus === 'prescription_only', promoDiscount: l.promoDiscount, promoName: l.promoName })),
    history: [{ status, by: 'customer', note }],
  });
  let paymentUrl;
  if (live) {
    const held = [];
    try {
      for (const it of order.items) {
        const lots = await deductFefo({ org: req.orgId, branch: b._id, product: it.product, qty: it.qty, label: it.name });
        held.push(...lots);
        it.lots = lots.map(({ batch, batchNo, expiry, qty }) => ({ batch, batchNo, expiry, qty }));
      }
      order.stockReserved = true;
      order.reservedUntil = new Date(Date.now() + (req.org.settings.reservationMinutes || 60) * 60000);
      const init = await payments.initialize({ email: req.customer.email || `${req.customer.phone.replace(/\D/g, '')}@customers.pharmaone.app`, amount: total, reference, method, callbackUrl: `${webUrl}/shop/${req.org.slug}/orders?ref=${reference}` });
      order.payment.authUrl = init.authUrl; paymentUrl = init.authUrl;
    } catch (e) {
      await restore(held);
      throw e.status ? e : new HttpError(502, `Could not start payment: ${e.message}`);
    }
  }
  await order.save();
  await audit(req, 'order.create', 'Order', order._id, `Online order ${order.orderNo} placed (${order.total})`);
  res.status(201).json({ ...order.toObject(), paymentUrl });
}));

// Customer returns from the payment page; confirm with the provider (the webhook may also have done it).
router.post('/orders/:id/verify-payment', customer, wrap(async (req, res) => {
  const o = await Order.findOne({ _id: req.params.id, customer: req.customer._id });
  if (!o) throw notFound();
  if (o.payment.status === 'pending' && o.payment.provider === 'paystack') {
    const r = await payments.verify(o.payment.reference);
    if (r.paid) await markPaid(o);
  }
  res.json(await Order.findById(o._id).populate('branch', 'name phone address'));
}));

async function markPaid(o) {
  if (o.payment.status !== 'pending') return;
  o.payment.status = 'paid'; o.reservedUntil = undefined;
  o.history.push({ status: o.status, by: 'system', note: 'Payment received' });
  await o.save();
  const c = await Customer.findById(o.customer);
  await notify(c, `Payment received for order ${o.orderNo}. Thank you!`);
}

// Provider webhook: signature-checked, no login.
router.post('/webhooks/paystack', wrap(async (req, res) => {
  if (!payments.validWebhook(req.rawBody || '', req.headers['x-paystack-signature'])) throw new HttpError(401, 'Bad signature');
  if (req.body.event === 'charge.success') {
    const o = await Order.findOne({ 'payment.reference': req.body.data?.reference });
    if (o) await markPaid(o);
  }
  res.json({ ok: true });
}));

module.exports = router;

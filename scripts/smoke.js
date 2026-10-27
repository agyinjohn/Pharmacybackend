// End-to-end smoke test against a running API seeded with `npm run seed`.
//   API=http://localhost:4000/api node scripts/smoke.js
// Exercises the main flows and prints PASS/FAIL per step. Exits non-zero on any failure.
const API = process.env.API || 'http://localhost:4000/api';
let failed = 0;

const call = async (path, { method, body, token, branch } = {}) => {
  const res = await fetch(`${API}${path}`, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }), ...(branch && { 'x-branch-id': branch }) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
};
const step = async (name, fn) => {
  try { const out = await fn(); console.log(`PASS  ${name}`); return out; } catch (e) { failed += 1; console.log(`FAIL  ${name}: ${e.message}`); return null; }
};
const ok = (r, want = 200) => { if (r.status !== want) throw new Error(`expected ${want}, got ${r.status}: ${r.data.error || JSON.stringify(r.data).slice(0, 160)}`); return r.data; };
const login = async (email) => { const d = ok(await call('/auth/login', { body: { email, password: 'Demo@1234' } })); return d; };

(async () => {
  const owner = await step('owner login', () => login('owner@demo.com'));
  const pharm = await step('pharmacist login', () => login('pharmacist@demo.com'));
  const cashier = await step('cashier login', () => login('cashier@demo.com'));
  const rider = await step('rider login', () => login('rider@demo.com'));
  if (!owner || !pharm || !cashier) return process.exit(1);
  const acc = owner.branches.find((b) => b.code === 'ACC')._id;
  const ksi = owner.branches.find((b) => b.code === 'KSI')._id;

  await step('wrong password rejected', async () => { const r = await call('/auth/login', { body: { email: 'owner@demo.com', password: 'nope' } }); ok(r, 401); });
  await step('dashboard (all branches)', async () => { const d = ok(await call('/reports/dashboard?branch=all', { token: owner.token })); if (d.perBranch.length !== 3) throw new Error('expected 3 branches'); });
  await step('cashier cannot see another branch', async () => { ok(await call('/inventory', { token: cashier.token, branch: ksi }), 403); });
  await step('cashier cannot open dashboard reports', async () => { ok(await call('/reports/dashboard', { token: cashier.token }), 403); });

  const inv = await step('inventory list', async () => { const d = ok(await call('/inventory', { token: owner.token, branch: acc })); if (!d.length) throw new Error('empty'); return d; });
  const alerts = await step('inventory alerts', async () => ok(await call('/inventory/alerts', { token: owner.token, branch: acc })));
  if (alerts && !alerts.expired) console.log('WARN  expected an expired batch from the seed');

  const lookup = async (q) => ok(await call(`/pos/lookup?q=${encodeURIComponent(q)}`, { token: cashier.token, branch: acc }));
  const panadol = (await step('pos lookup', () => lookup('Panadol')))?.[0];
  const amoxil = (await lookup('Amoxil'))[0];

  await step('sale blocked without open shift', async () => { ok(await call('/sales', { token: cashier.token, branch: acc, body: { items: [{ product: panadol._id, qty: 1 }], payments: [{ method: 'cash', amount: 100 }] } }), 409); });
  await step('open shift', async () => ok(await call('/shifts/open', { token: cashier.token, branch: acc, body: { openingCash: 100 } }), 201));
  const before = panadol.stock;
  const sale = await step('cash sale with change', async () => ok(await call('/sales', { token: cashier.token, branch: acc, body: { items: [{ product: panadol._id, qty: 2 }], payments: [{ method: 'cash', amount: 100 }] } }), 201));
  await step('stock reduced by sale (FEFO)', async () => { const after = (await lookup('Panadol'))[0].stock; if (after !== before - 2) throw new Error(`stock ${before} -> ${after}`); });
  await step('underpayment rejected', async () => { ok(await call('/sales', { token: cashier.token, branch: acc, body: { items: [{ product: panadol._id, qty: 1 }], payments: [{ method: 'cash', amount: 1 }] } }), 400); });
  await step('Rx item refused for cashier', async () => { ok(await call('/sales', { token: cashier.token, branch: acc, body: { items: [{ product: amoxil._id, qty: 1 }], payments: [{ method: 'cash', amount: 100 }] } }), 403); });
  await step('discount above role limit refused', async () => { ok(await call('/sales', { token: cashier.token, branch: acc, body: { items: [{ product: panadol._id, qty: 1 }], discount: 10, payments: [{ method: 'cash', amount: 100 }] } }), 403); });
  await step('refund restores stock', async () => { ok(await call(`/sales/${sale._id}/refund`, { token: cashier.token, branch: acc, body: { reason: 'smoke test' } })); const after = (await lookup('Panadol'))[0].stock; if (after !== before) throw new Error(`stock ${after} != ${before}`); });
  await step('close shift', async () => ok(await call('/shifts/close', { token: cashier.token, branch: acc, body: { countedCash: 100 } })));

  const rxs = await step('list prescriptions', async () => ok(await call('/prescriptions', { token: pharm.token, branch: acc })));
  const rx1 = rxs?.find((r) => r.rxNo === 'RX-DEMO-001'); const rx2 = rxs?.find((r) => r.rxNo === 'RX-DEMO-002'); const rx3 = rxs?.find((r) => r.rxNo === 'RX-DEMO-003');
  await step('verify raises allergy warning', async () => { const r = await call(`/prescriptions/${rx1._id}/verify`, { token: pharm.token, branch: acc, body: {} }); ok(r, 409); if (!r.data.warnings.some((w) => /ALLERGY/.test(w))) throw new Error('no allergy warning'); });
  await step('override needs reason', async () => { ok(await call(`/prescriptions/${rx1._id}/verify`, { token: pharm.token, branch: acc, body: { override: true } }), 400); });
  await step('override with reason verifies', async () => ok(await call(`/prescriptions/${rx1._id}/verify`, { token: pharm.token, branch: acc, body: { override: true, overrideReason: 'Tolerated before, doctor aware' } })));
  await step('dispense verified Rx creates dose reminders', async () => {
    const d = ok(await call(`/prescriptions/${rx2._id}/dispense`, { token: pharm.token, branch: acc, body: {} }));
    if (!d.labels.length) throw new Error('no labels');
    if (d.reminders.length !== 1 || d.reminders[0].times.join() !== '08:00,20:00') throw new Error(JSON.stringify(d.reminders));
  });
  await step('Rx cannot be dispensed beyond allowance (1 fill + 1 refill)', async () => {
    for (let i = 0; i < 1; i++) ok(await call(`/prescriptions/${rx2._id}/dispense`, { token: pharm.token, branch: acc, body: {} }));
    ok(await call(`/prescriptions/${rx2._id}/dispense`, { token: pharm.token, branch: acc, body: {} }), 409);
  });
  await step('controlled dispense writes register', async () => {
    ok(await call(`/prescriptions/${rx3._id}/dispense`, { token: pharm.token, branch: acc, body: {} }));
    const reg = ok(await call('/controlled-register', { token: pharm.token, branch: acc }));
    const supply = reg.filter((e) => e.type === 'supply' && e.rxNo === 'RX-DEMO-003'); if (!supply.length) throw new Error('no supply entry');
  });
  await step('register reconciles with shelf', async () => { const r = ok(await call('/controlled-register/reconcile', { token: pharm.token, branch: acc })); const bad = r.filter((x) => !x.matches); if (bad.length) throw new Error(JSON.stringify(bad)); });
  await step('audit log has entries', async () => { const a = ok(await call('/audit?limit=20', { token: owner.token })); if (!a.length) throw new Error('empty'); });

  // Customer portal
  const slug = 'medicare';
  await step('portal hides controlled drugs', async () => { const p = ok(await call(`/portal/${slug}/products?q=Diazepam`)); if (p.length) throw new Error('controlled drug visible'); });
  const phone = `+23324${Math.floor(1000000 + Math.random() * 8999999)}`;
  const first = await call(`/portal/${slug}/auth/request-otp`, { body: { phone } });
  await step('new customer asked for name', async () => { if (!first.data.newCustomer) throw new Error('expected newCustomer'); });
  const otp = await step('request otp', async () => ok(await call(`/portal/${slug}/auth/request-otp`, { body: { phone, name: 'Smoke Tester' } })));
  const cust = await step('verify otp', async () => ok(await call(`/portal/${slug}/auth/verify`, { body: { phone, code: otp.demoCode, consent: { communications: true, healthData: true } } })));
  const branchObj = (await call(`/portal/${slug}`)).data.branches.find((b) => b.name === 'Accra Central');
  const otc = (await call(`/portal/${slug}/products?branch=${branchObj._id}&q=ORS`)).data[0];
  const order = await step('place OTC order', async () => ok(await call(`/portal/${slug}/orders`, { token: cust.token, body: { branch: branchObj._id, items: [{ product: otc._id, qty: 2 }], fulfilment: 'delivery', address: { line: 'Test street' }, payment: { method: 'momo' } } }), 201));
  await step('Rx order without prescription refused', async () => { const rxp = (await call(`/portal/${slug}/products?branch=${branchObj._id}&q=Amoxil`)).data[0]; ok(await call(`/portal/${slug}/orders`, { token: cust.token, body: { branch: branchObj._id, items: [{ product: rxp._id, qty: 1 }], fulfilment: 'pickup', payment: { method: 'card' } } }), 400); });
  await step('record agreed delivery fee', async () => { const o = ok(await call(`/orders/${order._id}/delivery-fee`, { token: pharm.token, branch: acc, body: { fee: 15 } })); if (o.deliveryFee !== 15 || o.total !== order.total) throw new Error(`fee ${o.deliveryFee}, total ${o.total} vs ${order.total}`); });
  await step('negative delivery fee refused', async () => { ok(await call(`/orders/${order._id}/delivery-fee`, { token: pharm.token, branch: acc, body: { fee: -1 } }), 400); });
  await step('cannot pack before approval', async () => { ok(await call(`/orders/${order._id}/pack`, { token: pharm.token, branch: acc, body: {} }), 409); });
  await step('approve order', async () => ok(await call(`/orders/${order._id}/approve`, { token: pharm.token, branch: acc, body: {} })));
  await step('pack order', async () => ok(await call(`/orders/${order._id}/pack`, { token: pharm.token, branch: acc, body: {} })));
  const riders = await step('list riders', async () => ok(await call('/riders', { token: pharm.token, branch: acc })));
  await step('dispatch order', async () => ok(await call(`/orders/${order._id}/dispatch`, { token: pharm.token, branch: acc, body: { riderId: riders[0]._id } })));
  const mine = await step('customer sees delivery code', async () => { const o = ok(await call(`/portal/orders/${order._id}`, { token: cust.token })); if (!o.deliveryCode) throw new Error('no code'); return o; });
  await step('delivery with wrong code refused', async () => { ok(await call(`/orders/${order._id}/deliver`, { token: rider.token, body: { recipient: 'X', code: '0000' } }), 409); });
  await step('delivery with right code', async () => ok(await call(`/orders/${order._id}/deliver`, { token: rider.token, body: { recipient: 'Smoke Tester', code: mine.deliveryCode } })));

  // Transfers and purchasing
  const tr = await step('request transfer', async () => ok(await call('/transfers', { token: owner.token, body: { from: acc, to: ksi, items: [{ product: panadol._id, qty: 5 }] } }), 201));
  await step('dispatch transfer', async () => ok(await call(`/transfers/${tr._id}/dispatch`, { token: owner.token, body: {} })));
  await step('receive transfer short flags variance', async () => { const t = ok(await call(`/transfers/${tr._id}/receive`, { token: owner.token, body: { items: [{ product: panadol._id, receivedQty: 4 }] } })); if (!t.hasVariance) throw new Error('variance not flagged'); });
  // Offline sync: idempotent by clientId, shortfalls flagged instead of rejected
  const cid = `smoke-${Date.now()}`;
  const offlineSale = { clientId: cid, createdAt: new Date(Date.now() - 3600000).toISOString(), items: [{ product: panadol._id, qty: 100000 }], payments: [{ method: 'cash', amount: 100000000 }] };
  await step('offline sync flags stock shortfall', async () => { const d = ok(await call('/sales/sync', { token: cashier.token, branch: acc, body: { sales: [offlineSale] } })); const r = d.results[0]; if (!r.ok || !r.flags.length) throw new Error(JSON.stringify(r)); });
  await step('offline sync is idempotent', async () => { const d = ok(await call('/sales/sync', { token: cashier.token, branch: acc, body: { sales: [offlineSale] } })); if (!d.results[0].ok) throw new Error('duplicate rejected'); });
  await step('catalog snapshot for offline use', async () => { const d = ok(await call('/pos/catalog', { token: cashier.token, branch: acc })); if (!d.products.length) throw new Error('empty'); });
  await step('customer account statement', async () => { const cs = ok(await call('/customers?q=Sunrise', { token: owner.token })); const st = ok(await call(`/customers/${cs[0]._id}/statement`, { token: owner.token })); if (st.rows[0].balance !== 1350) throw new Error('bad balance'); });


  // Medication reminders (FR-RX-10, CP-NOT-02)
  const kw = ok(await call('/customers?q=Kwabena', { token: owner.token }))[0];
  const mo = ok(await call('/customers?q=Mohammed', { token: owner.token }))[0];
  await step('reminder test reaches a consenting patient', async () => { const pl = ok(await call('/reminders', { token: pharm.token, branch: acc, body: { customer: kw._id, medicine: 'Amlodipine 5mg', times: ['21:00', '09:00'], days: 30 } }), 201); if (pl.times.join() !== '09:00,21:00') throw new Error('times not sorted'); const t = ok(await call(`/reminders/${pl._id}/test`, { token: pharm.token, branch: acc, body: {} })); if (t.status !== 'sent' || !/Amlodipine/.test(t.message)) throw new Error(JSON.stringify(t)); });
  await step('no reminder sent without consent', async () => { const plans = ok(await call(`/customers/${mo._id}/reminders`, { token: pharm.token, branch: acc })); const t = ok(await call(`/reminders/${plans[0]._id}/test`, { token: pharm.token, branch: acc, body: {} })); if (t.status !== 'skipped') throw new Error(JSON.stringify(t)); });
  await step('bad reminder time rejected', async () => { ok(await call('/reminders', { token: pharm.token, branch: acc, body: { customer: kw._id, medicine: 'X', times: ['25:00'] } }), 400); });
  await step('patient pauses own reminder in the portal', async () => {
    ok(await call('/reminders', { token: pharm.token, branch: acc, body: { customer: cust.customer._id, medicine: 'Vitamin C', times: ['08:00'] } }), 201);
    const mine = ok(await call('/portal/me/reminders', { token: cust.token })); if (mine.length !== 1) throw new Error('not visible');
    const p2 = ok(await call(`/portal/me/reminders/${mine[0]._id}`, { method: 'PATCH', token: cust.token, body: { paused: true } })); if (!p2.paused) throw new Error('not paused');
  });
  await step('reminder sweep runs', async () => { const r = ok(await call('/reminders/run', { token: owner.token, body: {} })); if (typeof r.dose !== 'number') throw new Error(JSON.stringify(r)); });

  // Product photos
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  await step('upload a product photo and serve it publicly', async () => {
    const p = ok(await call(`/products/${panadol._id}/image`, { token: owner.token, body: { image: PNG } }));
    const r = await fetch(`${API}${p.imageUrl}`); if (r.status !== 200 || r.headers.get('content-type') !== 'image/png') throw new Error(`${r.status} ${r.headers.get('content-type')}`);
    const listed = ok(await call(`/portal/${slug}/products?q=Panadol`)); if (!listed[0].imageUrl) throw new Error('store list has no image');
  });
  await step('fake image rejected', async () => { ok(await call(`/products/${panadol._id}/image`, { token: owner.token, body: { image: 'data:image/png;base64,' + Buffer.from('<svg onload=alert(1)>').toString('base64') } }), 400); });

  // Pharmacist edits an online order before approval (CP-ORD-03)
  const order2 = await step('place order to edit', async () => ok(await call(`/portal/${slug}/orders`, { token: cust.token, body: { branch: branchObj._id, items: [{ product: otc._id, qty: 3 }], fulfilment: 'pickup', payment: { method: 'momo' } } }), 201));
  await step('edit needs a reason', async () => { ok(await call(`/orders/${order2._id}/edit`, { token: pharm.token, branch: acc, body: { lines: [{ product: otc._id, qty: 1 }] } }), 400); });
  await step('pharmacist reduces quantity, refund recorded', async () => {
    const o = ok(await call(`/orders/${order2._id}/edit`, { token: pharm.token, branch: acc, body: { lines: [{ product: otc._id, qty: 1 }], reason: 'Only one pack per customer' } }));
    if (o.items[0].qty !== 1 || !(o.payment.refundedAmount > 0) || !(o.total < order2.total)) throw new Error(JSON.stringify({ qty: o.items[0].qty, total: o.total, refunded: o.payment.refundedAmount }));
  });
  await step('edit cannot raise a paid total', async () => { ok(await call(`/orders/${order2._id}/edit`, { token: pharm.token, branch: acc, body: { lines: [{ product: otc._id, qty: 5 }], reason: 'x' } }), 409); });

  // Data import with validation report (NFR-12)
  const rowsC = [{ name: 'Import One', phone: '+233200000101', allergies: 'Sulfa', openingBalance: '25', creditLimit: '100' }, { name: 'Bad Phone', phone: '12' }];
  await step('import dry run reports errors without writing', async () => { const r = ok(await call('/imports/customers', { token: owner.token, body: { rows: rowsC, dryRun: true } })); if (r.created !== 1 || r.errors.length !== 1 || r.errors[0].row !== 3 || r.committed) throw new Error(JSON.stringify(r)); });
  await step('import commit writes valid rows and logs a report', async () => { const r = ok(await call('/imports/customers', { token: owner.token, body: { rows: rowsC, fileName: 'customers.csv' } })); if (r.created !== 1) throw new Error(JSON.stringify(r)); const logs = ok(await call('/imports', { token: owner.token })); if (logs[0].type !== 'customers' || logs[0].skipped !== 1) throw new Error('no import log'); });
  await step('stock import adds a batch', async () => { const r = ok(await call('/imports/stock', { token: owner.token, branch: acc, body: { rows: [{ branchCode: 'ACC', brand: 'Gaviscon', batchNo: 'IMP-1', expiry: '2030-01-31', qty: '7', cost: '30' }] } })); if (r.created !== 1) throw new Error(JSON.stringify(r)); });
  await step('import template download', async () => { const r = await fetch(`${API}/imports/templates/stock.csv`, { headers: { Authorization: `Bearer ${owner.token}` } }); if (!(await r.text()).startsWith('branchCode,barcode')) throw new Error('bad template'); });

  // Excel export (FR-REP-07)
  await step('excel export', async () => { const r = await fetch(`${API}/reports/sales?by=day&branch=all&format=xlsx`, { headers: { Authorization: `Bearer ${owner.token}` } }); const b = Buffer.from(await r.arrayBuffer()); if (!(r.headers.get('content-type') || '').includes('spreadsheetml') || b.slice(0, 2).toString() !== 'PK') throw new Error('not xlsx'); });

  // Data protection records (REG-15, 16, 18)
  await step('record of processing starts pre-filled', async () => { const a = ok(await call('/dp/processing', { token: owner.token })); if (a.length < 3) throw new Error('empty'); });
  await step('log a security incident', async () => ok(await call('/dp/incidents', { token: owner.token, body: { title: 'Lost tablet at Accra', severity: 'medium', dataAffected: 'Till session' } }), 201));
  await step('retention preview', async () => { const r = ok(await call('/dp/retention/preview', { token: owner.token })); if (typeof r.notificationsDeleted !== 'number') throw new Error(JSON.stringify(r)); });

  // Promotions and loyalty (FR-POS-04, FR-CUS-04)
  const vitc = (await lookup('Vitamin C'))[0];
  await step('create promotion', async () => ok(await call('/promotions', { token: owner.token, body: { name: 'Vitamins 20% off', type: 'percent', value: 20, categories: ['Vitamins'] } }), 201));
  await step('quote applies promotion', async () => { const q = ok(await call('/pos/quote', { token: owner.token, branch: acc, body: { items: [{ product: vitc._id, qty: 2 }] } })); if (Math.abs(q.promoDiscount - vitc.price * 2 * 0.2) > 0.01) throw new Error(JSON.stringify(q)); });
  await step('promotion never applies to prescription items', async () => { const q = ok(await call('/pos/quote', { token: owner.token, branch: acc, body: { items: [{ product: amoxil._id, qty: 1 }] } })); if (q.promoDiscount !== 0) throw new Error('rx discounted'); });
  const kwabena = ok(await call('/customers?q=Kwabena', { token: owner.token }))[0];
  await step('redeem loyalty points at the till', async () => {
    const q = ok(await call('/pos/quote', { token: owner.token, branch: acc, body: { items: [{ product: vitc._id, qty: 2 }] } }));
    const s = ok(await call('/sales', { token: owner.token, branch: acc, body: { items: [{ product: vitc._id, qty: 2 }], customer: kwabena._id, payments: [{ method: 'loyalty', amount: 5 }, { method: 'cash', amount: Math.ceil(q.total) }] } }), 201);
    if (s.pointsRedeemed !== 50 || !(s.promoDiscount > 0)) throw new Error(JSON.stringify({ r: s.pointsRedeemed, p: s.promoDiscount }));
    const after = ok(await call(`/customers/${kwabena._id}`, { token: owner.token })).customer.loyaltyPoints;
    if (after !== kwabena.loyaltyPoints - 50 + s.pointsEarned) throw new Error(`points ${kwabena.loyaltyPoints} -> ${after}`);
  });
  await step('cannot redeem more points than held', async () => { ok(await call('/sales', { token: owner.token, branch: acc, body: { items: [{ product: vitc._id, qty: 20 }], customer: kwabena._id, payments: [{ method: 'loyalty', amount: 500 }, { method: 'cash', amount: 2000 }] } }), 409); });

  // Offline receiving and dispensing (NFR-05)
  await step('offline prescription snapshot', async () => { const r = ok(await call('/offline/rx-snapshot', { token: pharm.token, branch: acc })); if (r.prescriptions.some((x) => x.rxNo === 'RX-DEMO-003')) throw new Error('controlled Rx in offline snapshot'); });
  const opR = { clientId: `rcv-${Date.now()}`, kind: 'receipt', createdAt: new Date().toISOString(), payload: { items: [{ product: otc._id, batchNo: 'OFF-1', expiry: '2030-06-30', qty: 4, cost: 8 }] } };
  const opD = { clientId: `dsp-${Date.now()}`, kind: 'dispense', createdAt: new Date().toISOString(), payload: { prescription: rx2._id, items: [{ product: rx2.items[0].product, qty: 10 }] } };
  await step('offline receipt and duplicate-fill dispensing sync with flags', async () => {
    const d = ok(await call('/offline/sync', { token: pharm.token, branch: acc, body: { ops: [opR, opD] } }));
    if (!d.results.every((r) => r.ok)) throw new Error(JSON.stringify(d.results));
    if (!d.results[1].flags?.length) throw new Error('over-fill not flagged');
  });
  await step('offline sync is idempotent', async () => { const d = ok(await call('/offline/sync', { token: pharm.token, branch: acc, body: { ops: [opR] } })); if (!d.results[0].duplicate) throw new Error('reapplied'); });

  await step('reorder suggestions', async () => ok(await call('/inventory/reorder-suggestions', { token: owner.token, branch: acc })));
  await step('reports: sales by day', async () => ok(await call('/reports/sales?by=day&branch=all', { token: owner.token })));
  await step('reports: csv export', async () => { const r = await fetch(`${API}/reports/stock?format=csv&branch=all`, { headers: { Authorization: `Bearer ${owner.token}` } }); if (!(r.headers.get('content-type') || '').includes('csv')) throw new Error('not csv'); });

  console.log(failed ? `\n${failed} step(s) FAILED` : '\nAll steps passed');
  process.exit(failed ? 1 : 0);
})();

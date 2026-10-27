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
  await step('dispense verified Rx', async () => { const d = ok(await call(`/prescriptions/${rx2._id}/dispense`, { token: pharm.token, branch: acc, body: {} })); if (!d.labels.length) throw new Error('no labels'); });
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
  const order = await step('place OTC order', async () => ok(await call(`/portal/${slug}/orders`, { token: cust.token, body: { branch: branchObj._id, items: [{ product: otc._id, qty: 2 }], fulfilment: 'delivery', address: { line: 'Test street', zone: branchObj.deliveryZones[0].name }, payment: { method: 'momo' } } }), 201));
  await step('Rx order without prescription refused', async () => { const rxp = (await call(`/portal/${slug}/products?branch=${branchObj._id}&q=Amoxil`)).data[0]; ok(await call(`/portal/${slug}/orders`, { token: cust.token, body: { branch: branchObj._id, items: [{ product: rxp._id, qty: 1 }], fulfilment: 'pickup', payment: { method: 'card' } } }), 400); });
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

  await step('reorder suggestions', async () => ok(await call('/inventory/reorder-suggestions', { token: owner.token, branch: acc })));
  await step('reports: sales by day', async () => ok(await call('/reports/sales?by=day&branch=all', { token: owner.token })));
  await step('reports: csv export', async () => { const r = await fetch(`${API}/reports/stock?format=csv&branch=all`, { headers: { Authorization: `Bearer ${owner.token}` } }); if (!(r.headers.get('content-type') || '').includes('csv')) throw new Error('not csv'); });

  console.log(failed ? `\n${failed} step(s) FAILED` : '\nAll steps passed');
  process.exit(failed ? 1 : 0);
})();

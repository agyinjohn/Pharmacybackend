// Pure-logic tests that need no database:  npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const totp = require('../src/utils/totp');
const { checkPrescription } = require('../src/services/clinical');
const { toCsv, round2, escapeRegex } = require('../src/utils/http');
const { priceFor, reorderFor } = require('../src/services/stock');

const base32 = (buf) => {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = 0; let v = 0; let out = '';
  for (const b of buf) { v = (v << 8) | b; bits += 8; while (bits >= 5) { out += A[(v >>> (bits - 5)) & 31]; bits -= 5; } }
  return out;
};

test('TOTP matches RFC 6238 vector and rejects wrong codes', () => {
  // RFC 6238 Appendix B test key: the ASCII digits 1-0 twice, base32-encoded at runtime.
  const secret = base32(Buffer.from('1234567890'.repeat(2)));
  assert.equal(totp.hotp(secret, 1), '287082');
  assert.ok(totp.verify(secret, totp.hotp(secret, Math.floor(Date.now() / 30000))));
  assert.ok(!totp.verify(secret, '000000'));
});

test('clinical checks: allergy, duplicate therapy and interactions', () => {
  const amox = { brand: 'Amoxil', generic: 'Amoxicillin' };
  assert.ok(checkPrescription([amox], ['Amoxicillin']).some((w) => /ALLERGY/.test(w)));
  assert.ok(checkPrescription([amox, { brand: 'Other', generic: 'Amoxicillin' }]).some((w) => /Duplicate/.test(w)));
  assert.ok(checkPrescription([{ brand: 'Tramadol 50', generic: 'Tramadol' }, { brand: 'Diazepam 5', generic: 'Diazepam' }]).some((w) => /sedation/.test(w)));
  assert.deepEqual(checkPrescription([{ brand: 'Panadol', generic: 'Paracetamol' }], ['Penicillin']), []);
  // class allergies: a penicillin allergy must flag amoxicillin products
  assert.ok(checkPrescription([amox], ['Penicillin']).some((w) => /ALLERGY/.test(w)));
  assert.ok(checkPrescription([{ brand: 'Augmentin', generic: 'Amoxicillin/Clavulanate' }], ['penicillins']).some((w) => /ALLERGY/.test(w)));
  assert.ok(checkPrescription([{ brand: 'Ibuprofen 400', generic: 'Ibuprofen' }], ['NSAIDs']).some((w) => /ALLERGY/.test(w)));
});

test('csv export escapes commas, quotes and newlines', () => {
  assert.equal(toCsv([{ a: 'x,y', b: 'say "hi"', c: 'l1\nl2' }]), 'a,b,c\n"x,y","say ""hi""","l1\nl2"');
  assert.equal(toCsv([]), '');
});

test('money rounding and regex escaping', () => {
  assert.equal(round2(1.005 + 0.0000001), 1.01);
  assert.equal(round2(10.1 + 0.2), 10.3);
  assert.equal(escapeRegex('a.b*c'), 'a\\.b\\*c');
});

test('branch price and reorder overrides fall back to defaults', () => {
  const p = { price: 10, reorderLevel: 5, branchPrices: [{ branch: 'b1', price: 12 }], branchReorder: [{ branch: 'b1', level: 20 }] };
  assert.equal(priceFor(p, 'b1'), 12); assert.equal(priceFor(p, 'b2'), 10);
  assert.equal(reorderFor(p, 'b1'), 20); assert.equal(reorderFor(p, 'b2'), 5);
});

const { priceBasket } = require('../src/services/pricing');
const P = (id, extra = {}) => ({ _id: id, category: 'Vitamins', legalStatus: 'otc', taxRate: 0, ...extra });

test('promotions: percent, fixed and buy-x-get-y; best one wins, no stacking', () => {
  const promos = [
    { _id: 'a', name: '10% vitamins', type: 'percent', value: 10, categories: ['Vitamins'], active: true },
    { _id: 'b', name: 'GHS 3 off', type: 'fixed', value: 3, products: ['p1'], active: true },
    { _id: 'c', name: 'Buy 2 get 1', type: 'bogo', buyQty: 2, getQty: 1, products: ['p2'], active: true },
  ];
  const r = priceBasket([{ p: P('p1'), qty: 2, unitPrice: 20 }, { p: P('p2'), qty: 3, unitPrice: 10 }], { promos });
  assert.equal(r.lines[0].promoName, 'GHS 3 off'); assert.equal(r.lines[0].promoDiscount, 6); // beats 10% (=4)
  assert.equal(r.lines[1].promoName, 'Buy 2 get 1'); assert.equal(r.lines[1].promoDiscount, 10); // beats 10% (=3)
  assert.equal(r.subtotal, 70); assert.equal(r.promoDiscount, 16); assert.equal(r.total, 54);
});

test('promotions never apply to prescription or controlled medicines, or outside their window', () => {
  const promos = [{ _id: 'a', name: 'All 50%', type: 'percent', value: 50, active: true }, { _id: 'b', name: 'Expired', type: 'percent', value: 90, active: true, endsAt: new Date(Date.now() - 1000) }];
  const r = priceBasket([{ p: P('rx', { legalStatus: 'prescription_only' }), qty: 1, unitPrice: 40 }, { p: P('o'), qty: 1, unitPrice: 10 }], { promos });
  assert.equal(r.lines[0].promoDiscount, 0);
  assert.equal(r.lines[1].promoName, 'All 50%');
});

test('manual discount is spread across lines and tax is charged on the discounted amount', () => {
  const r = priceBasket([{ p: P('t', { taxRate: 0.15 }), qty: 1, unitPrice: 100 }, { p: P('n'), qty: 1, unitPrice: 100 }], { manualDiscount: 20 });
  assert.equal(r.lines[0].manualDiscount, 10); assert.equal(r.lines[0].tax, 13.5);
  assert.equal(r.tax, 13.5); assert.equal(r.total, 193.5);
  assert.equal(r.lines[0].net + r.lines[1].net, r.total);
});

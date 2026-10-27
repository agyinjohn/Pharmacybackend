// Pure-logic tests that need no database:  npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const totp = require('../src/utils/totp');
const { checkPrescription } = require('../src/services/clinical');
const { toCsv, round2, escapeRegex } = require('../src/utils/http');
const { priceFor, reorderFor } = require('../src/services/stock');

test('TOTP matches RFC 6238 vector and rejects wrong codes', () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // base32 of "12345678901234567890"
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

const crypto = require('crypto');

// RFC 6238 time-based one-time passwords (30 s step, 6 digits, SHA-1) for authenticator apps.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const base32Encode = (buf) => {
  let bits = 0; let value = 0; let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
};
const base32Decode = (str) => {
  let bits = 0; let value = 0; const out = [];
  for (const c of str.replace(/=+$/, '').toUpperCase()) {
    const idx = ALPHABET.indexOf(c); if (idx < 0) continue;
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
};

const generateSecret = () => base32Encode(crypto.randomBytes(20));
const hotp = (secret, counter) => {
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const o = h[h.length - 1] & 15;
  const code = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(code % 1e6).padStart(6, '0');
};
const verify = (secret, token, window = 1) => {
  const t = Math.floor(Date.now() / 30000);
  for (let i = -window; i <= window; i++) if (hotp(secret, t + i) === String(token).trim()) return true;
  return false;
};
const otpauthUrl = (secret, account, issuer = 'PharmaOne') => `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}`;

module.exports = { generateSecret, verify, otpauthUrl, hotp };

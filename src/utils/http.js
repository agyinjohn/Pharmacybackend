class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const bad = (msg, details) => new HttpError(400, msg, details);
const notFound = (msg = 'Not found') => new HttpError(404, msg);
const forbidden = (msg = 'You do not have permission to do that') => new HttpError(403, msg);
const conflict = (msg) => new HttpError(409, msg);

// Wraps an async express handler so rejections reach the error middleware.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const toCsv = (rows) => {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = v instanceof Date ? v.toISOString() : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
};

const sendRows = (req, res, name, rows) => {
  if (req.query.format === 'csv') {
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`);
    return res.send(toCsv(rows));
  }
  return res.json(rows);
};

const seq = (prefix) => `${prefix}-${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 36 ** 2).toString(36).toUpperCase().padStart(2, '0')}`;

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

module.exports = { HttpError, bad, notFound, forbidden, conflict, wrap, escapeRegex, toCsv, sendRows, seq, round2 };

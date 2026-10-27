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

// Excel export (FR-REP-07): bold header, frozen first row, sensible column widths, real dates and numbers.
const sendXlsx = async (res, name, rows) => {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'PharmaOne';
  const ws = wb.addWorksheet(name.slice(0, 31));
  const cols = rows.length ? Object.keys(rows[0]) : ['(no data)'];
  ws.columns = cols.map((c) => ({ header: c.replace(/_/g, ' '), key: c, width: Math.min(45, Math.max(10, c.length + 2, ...rows.slice(0, 200).map((r) => String(r[c] ?? '').length + 2))) }));
  rows.forEach((r) => ws.addRow(Object.fromEntries(cols.map((c) => {
    const v = r[c];
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return [c, new Date(v)];
    return [c, v ?? ''];
  }))));
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.columns.forEach((col) => { if (rows.some((r) => r[col.key] instanceof Date)) col.numFmt = 'yyyy-mm-dd hh:mm'; });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${name}.xlsx"`);
  res.end(Buffer.from(await wb.xlsx.writeBuffer()));
};

const sendRows = (req, res, name, rows) => {
  if (req.query.format === 'xlsx') {
    return sendXlsx(res, name, rows).catch((e) => { console.error(e); if (!res.headersSent) res.status(500).json({ error: 'Could not build the Excel file' }); });
  }
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

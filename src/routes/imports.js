const router = require('express').Router();
const ExcelJS = require('exceljs');
const { ImportLog } = require('../models');
const { wrap, bad, toCsv } = require('../utils/http');
const { roles, branch, writable } = require('../middleware/auth');
const { audit } = require('../services/audit');
const { IMPORTERS, runImport } = require('../services/importers');

const IMPORT_ROLES = ['branch_manager', 'store_officer', 'accountant'];

router.get('/imports', roles(...IMPORT_ROLES), wrap(async (req, res) => {
  res.json(await ImportLog.find({ org: req.orgId }).sort('-createdAt').limit(100));
}));

router.get('/imports/templates/:type.csv', roles(...IMPORT_ROLES), wrap(async (req, res) => {
  const imp = IMPORTERS[req.params.type];
  if (!imp) throw bad('Unknown import type');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.type}-template.csv"`);
  res.send(toCsv([Object.fromEntries(imp.columns.map((c) => [c, imp.example[c] ?? '']))]));
}));

// Reads the first sheet of an uploaded .xlsx (sent as base64) into row objects keyed by header.
router.post('/imports/parse-xlsx', roles(...IMPORT_ROLES), wrap(async (req, res) => {
  const b64 = String(req.body.file || '').replace(/^data:.*?;base64,/, '');
  if (!b64) throw bad('No file');
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(Buffer.from(b64, 'base64')); } catch { throw bad('Could not read that file; save it as .xlsx or .csv'); }
  const ws = wb.worksheets[0];
  if (!ws) throw bad('The workbook has no sheets');
  const cell = (c) => {
    const v = c.value;
    if (v === null || v === undefined) return '';
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (typeof v === 'object') return v.text ?? v.result ?? (v.richText ? v.richText.map((t) => t.text).join('') : '');
    return String(v);
  };
  const header = []; ws.getRow(1).eachCell({ includeEmpty: true }, (c, i) => { header[i] = cell(c).trim(); });
  const rows = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const o = {}; let any = false;
    header.forEach((h, i) => { if (!h) return; const v = cell(row.getCell(i)).trim(); o[h] = v; if (v) any = true; });
    if (any) rows.push(o);
  });
  if (rows.length > 5000) throw bad('Import at most 5000 rows at a time');
  res.json({ rows });
}));

// dryRun=true validates only; otherwise applies valid rows and records the migration report.
router.post('/imports/:type', branch(false), roles(...IMPORT_ROLES), writable, wrap(async (req, res) => {
  const { type } = req.params;
  if (!IMPORTERS[type]) throw bad('Unknown import type');
  if (type === 'customers' || type === 'suppliers') { if (!['owner', 'branch_manager', 'accountant'].includes(req.user.role)) throw bad('Your role cannot import this data'); }
  const rows = req.body.rows;
  if (!Array.isArray(rows) || !rows.length) throw bad('No rows to import');
  if (rows.length > 5000) throw bad('Import at most 5000 rows at a time');
  const commit = !req.body.dryRun;
  const report = await runImport(type, rows, { org: req.orgId, branchId: req.branchId, user: req.user }, commit);
  if (commit) {
    await ImportLog.create({ org: req.orgId, type, fileName: req.body.fileName, by: req.user._id, byName: req.user.name, total: report.total, created: report.created, updated: report.updated, skipped: report.skipped, rowErrors: report.errors.slice(0, 500) });
    await audit(req, 'data.import', 'ImportLog', null, `Imported ${type}: ${report.created} created, ${report.updated} updated, ${report.skipped} skipped`);
  }
  res.json({ ...report, committed: commit });
}));

module.exports = router;

// Builds the year workbook with the browser's exporter (js/excel.js) for a generated year.
// tests/test_excel_parity.py compares the result with the Python export, cell for cell.
//   node tools/export_xlsx.js <out.xlsx> [seed]
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

global.window = {};
for (const f of ['core', 'books', 'close', 'excel']) {
  // eslint-disable-next-line no-eval
  eval(fs.readFileSync(path.join(__dirname, '..', 'js', f + '.js'), 'utf8'));
}
const M = window.MEC;
const out = process.argv[2] || 'fy2026-browser.xlsx';
const seed = Number(process.argv[3]) || 2026;

let prior = null;
const closed = [];
for (const p of M.PERIODS) {
  const g = M.generateMonth(p, seed, M.opening(p, prior));
  const ms = { period: p, seed, events: g.events, shrinkBps: g.shrinkBps, cafeWasteBps: g.cafeWasteBps, countOverride: null };
  const r = M.closeMonth(ms, prior);
  if (!r.snapshot) break;
  closed.push({ period: p, books: r.books, result: r.result });
  prior = r.snapshot;
}
M.buildYearWorkbook(ExcelJS, closed, M.yearStatements(closed)).xlsx.writeFile(out)
  .then(() => console.log(`written ${out}`))
  .catch(e => { console.error(e); process.exit(1); });

// Runs the JavaScript engine for a full generated year and writes its results as JSON.
// The Python engine's parity test compares itself against this file, to the cent.
//   node tools/export_golden.js [seed] > tests/golden_fy2026.json
const fs = require('fs');
const path = require('path');

global.window = {};
for (const f of ['core', 'books', 'close']) {
  // eslint-disable-next-line no-eval
  eval(fs.readFileSync(path.join(__dirname, '..', 'js', f + '.js'), 'utf8'));
}
const M = window.MEC;
const seed = Number(process.argv[2]) || 2026;

let prior = null;
const months = [], closed = [];
for (const p of M.PERIODS) {
  const g = M.generateMonth(p, seed, M.opening(p, prior));
  const ms = { period: p, seed, events: g.events, shrinkBps: g.shrinkBps, cafeWasteBps: g.cafeWasteBps, countOverride: null };
  const { books, result, snapshot } = M.closeMonth(ms, prior);
  const st = result.statements;
  months.push({
    period: p,
    events: g.events.length,
    adjustments: result.adjustments.length,
    verdict: result.verdict,
    findings: result.findings.map(f => `${f.control} ${f.severity} ${f.message}`),
    netSales: st.netSales, grossProfit: st.grossProfit, netIncome: st.netIncome,
    totalAssets: st.totalAssets, cash: M.acctSum(result.ledger, '1000'),
    bankClosing: books.docs.bank.closing,
    inputHash: result.lock.inputHash, ledgerHash: result.lock.ledgerHash,
    trialBalance: Object.fromEntries(result.tb.rows.map(r => [r.code, r.net])),
  });
  if (!snapshot) break;
  closed.push({ period: p, books, result });
  prior = snapshot;
}
const y = M.yearStatements(closed);
const demos = M.PERIODS.map(p => ({ period: p, allHeld: M.runGuardrailDemo(p, seed).allHeld }));
process.stdout.write(JSON.stringify({
  seed, months,
  year: { netSales: y.totals.netSales, grossProfit: y.totals.grossProfit, netIncome: y.totals.netIncome, openingEquity: y.openingEquity, closingEquity: y.closing.totalEquity, equityCheck: y.equityCheck },
  demos,
}, null, 2) + '\n');

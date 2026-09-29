// Runs the JavaScript engine over generated months plus the hand-entered transactions in
// tests/extras_events.json (owner, loan, renewals, returns, write-offs, manual journal entries)
// and writes the results. The Python parity test compares itself against this file, to the cent.
//   node tools/export_extras.js > tests/golden_extras.json
const fs = require('fs');
const path = require('path');

global.window = {};
for (const f of ['core', 'books', 'close']) {
  // eslint-disable-next-line no-eval
  eval(fs.readFileSync(path.join(__dirname, '..', 'js', f + '.js'), 'utf8'));
}
const M = window.MEC;
const spec = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tests', 'extras_events.json'), 'utf8'));

let prior = null;
const months = [];
for (const p of spec.periods) {
  const g = M.generateMonth(p, spec.seed, M.opening(p, prior));
  const extras = (spec.extras[p] || []).map((e, i) => ({ id: 'u' + (i + 1), source: 'user', ...e }));
  const ms = { period: p, seed: spec.seed, events: g.events.concat(extras), shrinkBps: g.shrinkBps, cafeWasteBps: g.cafeWasteBps, countOverride: null };
  const { result, snapshot } = M.closeMonth(ms, prior);
  const accrual = result.adjustments.find(j => j.tag === 'accrual:interest');
  months.push({
    period: p,
    verdict: result.verdict,
    findings: result.findings.map(f => `${f.control} ${f.severity} ${f.message}`),
    netIncome: result.statements.netIncome,
    totalAssets: result.statements.totalAssets,
    interestAccrued: accrual ? accrual.lines[0].dr : 0,
    prepaidsCarried: snapshot ? snapshot.prepaids.map(pp => pp.id) : null,
    inputHash: result.lock.inputHash, ledgerHash: result.lock.ledgerHash,
    trialBalance: Object.fromEntries(result.tb.rows.map(r => [r.code, r.net])),
  });
  if (!snapshot) break;
  prior = snapshot;
}
process.stdout.write(JSON.stringify({ seed: spec.seed, months }, null, 2) + '\n');

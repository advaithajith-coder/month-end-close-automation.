const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = vm.createContext({ window: {} });
for (const name of ['core', 'books', 'close']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', `${name}.js`), 'utf8'), context);
}
const M = context.window.MEC;

for (const change of ['unchanged', 'count', 'cafe_waste', 'period']) {
  test(`period lock: ${change}`, () => {
    const state = { period: '2026-01', seed: 2026, ...M.generateMonth('2026-01', 2026) };
    const books = M.buildBooks(state);
    const original = M.runClose(books);
    const lock = { ...original.lock };
    if (change === 'count') state.countOverride = books.docs.count.value + 10000;
    if (change === 'cafe_waste') state.cafeWasteBps += 100;
    if (change === 'period') lock.period = '2026-02';
    const out = M.closeMonth(state, null, { lock });
    assert.equal(out.result.lock.inputHash, original.lock.inputHash);
    assert.equal(out.result.controlStatus.C8, change === 'unchanged' ? 'PASS' : 'FAIL');
    assert.equal(out.snapshot !== null, change === 'unchanged');
    if (change === 'count' || change === 'cafe_waste') {
      assert.notEqual(out.result.lock.ledgerHash, original.lock.ledgerHash);
    }
  });
}

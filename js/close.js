'use strict';
// The automated month-end close: nine steps, financial statements, eight controls,
// an independent shadow recompute, and the fault-injection (guardrail) demo.
(function () {
  const M = window.MEC;
  const { dr, cr } = M;

  const acctSum = (entries, acct) => entries.reduce((t, je) => t + je.lines.reduce((u, l) => u + (l.acct === acct ? l.dr - l.cr : 0), 0), 0);
  M.acctSum = acctSum;
  const serialize = entries => entries.map(je => `${je.id}|${je.date}|${je.lines.map(l => `${l.acct}:${l.dr}:${l.cr}`).join(',')}`).join('\n');
  const sum = (arr, f) => arr.reduce((t, x) => t + f(x), 0);

  M.runClose = function (books, opts = {}) {
    const f = opts.faults || {}, s = M.SETUP, p = books.period, end = M.periodEnd(p), prev = M.shiftPeriod(p, -1);
    const ledger = books.entries.slice(), adjustments = [];
    let n = 0;
    const post = (step, je) => {
      je.id = 'ADJ-' + String(++n).padStart(3, '0');
      je.source = 'close'; je.step = step; je.date = je.date || end;
      je.lines = je.lines.filter(l => l.dr !== 0 || l.cr !== 0);
      ledger.push(je); adjustments.push(je);
      return je;
    };
    const bal = a => acctSum(ledger, a);
    const steps = [];

    // 1 — card processor settlements
    {
      const rows = books.docs.processor.map(r => ({ ...r, posted: r.settleDate <= end }));
      for (const r of rows) if (r.posted) post('card', { date: r.settleDate, tag: 'card-settlement', memo: `Card settlement – sales of ${M.shortDate(r.saleDate)}`, lines: [M.line('1000', r.net), M.line('6300', r.fee), M.line('1100', -r.gross)] });
      const inTransit = sum(rows.filter(r => !r.posted), r => r.gross);
      const gl = bal('1100');
      const settled = rows.filter(r => r.posted);
      steps.push({
        id: 'card', title: 'Card processor settlements', diff: gl - inTransit,
        summary: `${settled.length} payouts booked: ${M.usd(sum(settled, r => r.net))} deposited after ${M.usd(sum(settled, r => r.fee))} in fees. ${M.usd(inTransit)} of card sales still in transit.`,
        detail: { rows, inTransit, gl },
      });
    }

    // 2 — bank reconciliation
    {
      // last month's uncleared checks and deposits are still waiting to hit the bank
      const bookItems = books.opening.bankOutstanding.map(x => ({ ...x, jeId: 'b/f', matched: false, broughtForward: true }));
      for (const je of ledger) {
        if (je.source === 'opening') continue;
        const amt = je.lines.reduce((t, l) => t + (l.acct === '1000' ? l.dr - l.cr : 0), 0);
        if (amt) bookItems.push({ date: je.date, amount: amt, memo: je.memo, jeId: je.id, matched: false });
      }
      const bankLines = books.docs.bank.lines.map(l => ({ ...l, matched: false }));
      for (const bl of bankLines) {
        let best = null;
        for (const bi of bookItems) {
          if (bi.matched || bi.amount !== bl.amount || bi.date > bl.date || M.dayDiff(bi.date, bl.date) > 10) continue;
          if (!best || bi.date < best.date) best = bi;
        }
        if (best) { best.matched = true; bl.matched = true; }
      }
      const bankOnly = bankLines.filter(l => !l.matched), unexplained = [];
      for (const bl of bankOnly) {
        if (/fee/i.test(bl.desc)) {
          if (!f.skipBankFee) { post('bank', { tag: 'bank-fee', memo: 'Bank service fee per statement', lines: [dr('6600', -bl.amount), cr('1000', -bl.amount)] }); bl.booked = true; }
        } else if (/interest/i.test(bl.desc)) {
          post('bank', { tag: 'bank-interest', memo: 'Interest earned per statement', lines: [dr('1000', bl.amount), cr('4900', bl.amount)] }); bl.booked = true;
        } else unexplained.push(bl);
      }
      const outstanding = bookItems.filter(b => !b.matched);
      const dit = sum(outstanding.filter(b => b.amount > 0), b => b.amount);
      const oc = sum(outstanding.filter(b => b.amount < 0), b => b.amount);
      const bankEnd = books.docs.bank.closing, adjustedBank = bankEnd + dit + oc, bookCash = bal('1000');
      steps.push({
        id: 'bank', title: 'Bank reconciliation', diff: adjustedBank - bookCash, exceptions: unexplained,
        summary: `Matched ${bankLines.length - bankOnly.length} of ${bankLines.length} bank lines automatically. Booked ${bankOnly.filter(b => b.booked).length} bank-only items; ${outstanding.length} items still in transit.`,
        detail: { bankEnd, dit, oc, adjustedBank, bookCash, outstanding, bankOnly, matched: bankLines.length - bankOnly.length, total: bankLines.length },
      });
    }

    // 3 — stock counts: books (shrinkage) and café stock (waste)
    {
      const book = bal('1200'), count = books.docs.count.value, shrink = book - count;
      if (shrink !== 0) post('inventory', { tag: 'shrinkage', memo: shrink > 0 ? 'Inventory shrinkage per physical count' : 'Inventory overage per physical count', lines: [M.line('5010', shrink), M.line('1200', -shrink)] });
      const cafeBook = bal('1210'), cafeCount = books.docs.cafeCount.value, waste = cafeBook - cafeCount;
      if (waste !== 0) post('inventory', { tag: 'cafe-waste', memo: 'Café stock waste and spoilage per count', lines: [M.line('5030', waste), M.line('1210', -waste)] });
      steps.push({
        id: 'inventory', title: 'Stock counts: books & café', diff: (bal('1200') - count) + (bal('1210') - cafeCount),
        summary: `Books: records ${M.usd(book)}, shelf count ${M.usd(count)}, shrinkage ${M.usd(shrink)} (${book ? (shrink * 100 / book).toFixed(2) : '0.00'}%). Café: records ${M.usd(cafeBook)}, count ${M.usd(cafeCount)}, waste ${M.usd(waste)}.`,
        detail: { book, count, shrink, cafeBook, cafeCount, waste },
      });
    }

    // 4 — prepaid amortization
    {
      const rows = books.prepaids.map(pp => {
        const opening = pp.total - M.prepaidAmortThrough(pp, prev);
        let amt = M.prepaidAmort(pp, p);
        if (f.tamperPrepaid && pp.id === 'ins' && amt) amt += 5000;
        if (amt) post('prepaids', { tag: 'prepaid:' + pp.id, memo: `Amortize ${pp.name}`, lines: [dr(pp.expense, amt), cr(pp.asset, amt)] });
        return { ...pp, opening, amort: amt, closing: opening - amt, monthNo: M.monthIndex(p) - M.monthIndex(pp.start) + 1 };
      });
      const accts = [...new Set(rows.map(r => r.asset))];
      const diff = sum(accts, a => bal(a) - sum(rows.filter(r => r.asset === a), r => r.closing));
      steps.push({ id: 'prepaids', title: 'Prepaid amortization', diff, summary: `Expensed ${M.usd(sum(rows, r => r.amort))} of prepaid costs across ${rows.filter(r => r.amort).length} items.`, detail: { rows } });
    }

    // 5 — depreciation
    {
      const rows = books.assets.map(a => {
        const opening = M.depreciationThrough(a, prev);
        let amt = M.depreciation(a, p);
        if (f.deadAssetDepreciates && opening >= a.cost) amt = Math.floor(a.cost / a.life);
        if (amt) post('depreciation', { tag: 'dep:' + a.id, memo: `Depreciation – ${a.name}`, lines: [dr('6500', amt), cr('1510', amt)] });
        const closing = opening + amt;
        const status = amt ? (closing >= a.cost ? 'Final month' : 'Depreciating')
          : opening >= a.cost ? 'Fully depreciated' : M.monthIndex(p) <= M.monthIndex(a.inService) ? 'Starts next month' : '—';
        return { ...a, opening, amt, closing, nbv: a.cost - closing, status };
      });
      steps.push({ id: 'depreciation', title: 'Depreciation', diff: -bal('1510') - sum(rows, r => r.closing), summary: `Depreciation of ${M.usd(sum(rows, r => r.amt))} on ${rows.filter(r => r.amt).length} of ${rows.length} assets.`, detail: { rows } });
    }

    // 6 — accruals
    {
      const pays = books.events.filter(e => e.type === 'payroll' && e.date <= end).map(e => e.date).sort();
      const lastPay = pays.length ? pays[pays.length - 1] : books.opening.lastPayroll;
      const days = Math.max(0, M.dayDiff(lastPay, end));
      const loanBalance = Math.max(0, -(books.opening.balances['2500'] || 0)); // interest runs on the balance owed at the start of the month
      const items = [
        { key: 'wages', name: 'Wages earned since last payroll', basis: `${days} days × ${M.usd(s.dailyWage)}/day (last payroll ${M.shortDate(lastPay)})`, amount: days * s.dailyWage, exp: '6000', liab: '2200' },
        { key: 'utilities', name: 'Unbilled utilities', basis: "Estimate – this month's bill arrives next month", amount: s.utilityEstimate, exp: '6200', liab: '2210' },
        { key: "interest", name: "Loan interest", basis: `${M.usd(loanBalance)} loan balance × ${s.loan.rateBps / 100}% ÷ 12`, amount: M.loanInterest(loanBalance), exp: "7000", liab: "2220" },
      ];
      for (const it of items) {
        it.posted = it.amount > 0 && !(f.dropWagesAccrual && it.key === 'wages');
        if (it.posted) post('accruals', { tag: 'accrual:' + it.key, memo: `Accrue ${it.name.toLowerCase()}`, lines: [dr(it.exp, it.amount), cr(it.liab, it.amount)] });
        it.gl = -bal(it.liab);
      }
      steps.push({ id: 'accruals', title: 'Accruals', diff: sum(items, it => it.gl - it.amount), summary: `Accrued ${M.usd(sum(items.filter(i => i.posted), i => i.amount))} of expenses incurred but not yet paid.`, detail: { items } });
    }

    // 7 — gift card liability
    {
      const sold = sum(books.events.filter(e => e.type === 'giftcard_sold'), e => e.amount);
      const redeemed = sum(books.events.filter(e => e.type === 'giftcard_redeemed'), e => e.amount + M.pct(e.amount, s.taxBps));
      const opening = books.opening.giftCards;
      const expected = opening + sold - redeemed, gl = -bal('2300');
      steps.push({ id: 'giftcards', title: 'Gift card liability', diff: gl - expected, summary: `Opening ${M.usd(opening)} + sold ${M.usd(sold)} − redeemed ${M.usd(redeemed)} = ${M.usd(expected)} still owed to customers.`, detail: { opening, sold, redeemed, expected, gl } });
    }

    // 8 — sales tax
    {
      let taxable = 0, collected = 0;
      for (const e of books.events) {
        const sign = ['book_sale', 'cafe_sale', 'giftcard_redeemed'].includes(e.type) ? 1 : e.type === 'sale_return' ? -1 : 0;
        if (!sign) continue;
        taxable += sign * e.amount; collected += sign * M.pct(e.amount, s.taxBps);
      }
      const remitted = sum(books.events.filter(e => e.type === 'sales_tax_remittance'), e => e.amount);
      const opening = books.opening.salesTax;
      const expected = opening + collected - remitted, gl = -bal('2100');
      steps.push({ id: 'salestax', title: 'Sales tax', diff: gl - expected, summary: `8% on ${M.usd(taxable)} of net taxable sales = ${M.usd(collected)} collected; ${M.usd(expected)} owed to the state next month.`, detail: { opening, taxable, collected, remitted, expected, gl } });
    }

    // 9 — statements + lock
    const tb = M.trialBalance(ledger);
    const statements = M.statements(tb);
    const lock = { period: p, inputHash: M.fingerprint(serialize(books.entries)), ledgerHash: M.fingerprint(serialize(ledger)) };
    steps.push({
      id: 'close', title: 'Financial statements & period lock', diff: statements.bsDiff,
      summary: `Net income ${M.usd(statements.netIncome)}. Balance sheet ${statements.bsDiff === 0 ? 'balances' : 'is OUT of balance'}. Period seal ${lock.inputHash}.`,
      detail: { statements, lock },
    });
    steps.forEach((st, i) => { st.n = i + 1; st.entries = adjustments.filter(j => j.step === st.id); st.ok = st.diff === 0 && !(st.exceptions && st.exceptions.length); });

    const res = { period: p, ledger, adjustments, steps, tb, statements, lock };
    const ctl = M.runControls(books, res, opts);
    res.findings = ctl.findings; res.flux = ctl.flux; res.controlStatus = ctl.status; res.evidence = ctl.evidence;
    const crit = res.findings.filter(x => x.severity === 'CRITICAL').length, warn = res.findings.filter(x => x.severity === 'WARN').length;
    res.verdict = crit ? 'BLOCKED' : warn ? 'CLOSED WITH WARNINGS' : 'CLOSED CLEAN';
    res.counts = { crit, warn };
    return res;
  };

  M.trialBalance = function (ledger) {
    const m = {};
    for (const je of ledger) for (const l of je.lines) { const r = m[l.acct] || (m[l.acct] = { dr: 0, cr: 0 }); r.dr += l.dr; r.cr += l.cr; }
    const rows = M.ACCOUNTS.filter(a => m[a.code]).map(a => {
      const net = m[a.code].dr - m[a.code].cr;
      return { ...a, net, dr: net > 0 ? net : 0, cr: net < 0 ? -net : 0 };
    });
    return { rows, totalDr: sum(rows, r => r.dr), totalCr: sum(rows, r => r.cr) };
  };

  M.statements = function (tb) {
    const get = code => (tb.rows.find(r => r.code === code) || { net: 0 }).net;
    const of = t => tb.rows.filter(r => r.type === t);
    const revenue = of('R').map(r => ({ ...r, amount: -r.net }));
    const expenses = of('X').map(r => ({ ...r, amount: r.net }));
    const totalRevenue = sum(revenue, r => r.amount), totalExpenses = sum(expenses, r => r.amount);
    const netIncome = totalRevenue - totalExpenses;
    const netSales = -(get('4000') + get('4010') + get('4100'));
    const cogs = get('5000') + get('5010') + get('5020') + get('5030'); // books + shrinkage + café + waste
    const assets = of('A').map(r => ({ ...r, amount: r.net }));
    const liabilities = of('L').map(r => ({ ...r, amount: -r.net }));
    const equity = of('E').map(r => ({ ...r, amount: -r.net }));
    const totalAssets = sum(assets, r => r.amount), totalLiabilities = sum(liabilities, r => r.amount);
    const totalEquity = sum(equity, r => r.amount) + netIncome;
    return {
      revenue, expenses, totalRevenue, totalExpenses, netIncome, netSales, cogs, grossProfit: netSales - cogs,
      assets, liabilities, equity, totalAssets, totalLiabilities, totalEquity, bsDiff: totalAssets - totalLiabilities - totalEquity,
    };
  };

  // ---------- independent shadow recompute (deliberately different code from the posting path) ----------
  const shadow = {
    straightLine(total, count, k) {
      if (k < 0 || k >= count) return 0;
      const per = Math.floor(total / count);
      let left = total;
      for (let i = 0; i < k; i++) left -= per;
      return k === count - 1 ? left : per;
    },
    prepaid: (pp, p) => shadow.straightLine(pp.total, pp.months, M.monthIndex(p) - M.monthIndex(pp.start)),
    dep: (a, p) => shadow.straightLine(a.cost, a.life, M.monthIndex(p) - M.monthIndex(a.inService) - 1),
    interest: loan => Math.round(loan.principal / 12 * loan.rateBps / 10000),
  };

  M.CONTROLS = [
    { id: 'C1', name: 'Balanced entries', blocks: 'An entry — or the trial balance — where debits do not equal credits.' },
    { id: 'C2', name: 'Reconciliations tie', blocks: 'A bank, card, inventory, prepaid, asset, accrual, gift-card or sales-tax balance that does not agree with its support.' },
    { id: 'C3', name: 'Completeness', blocks: 'A month-end entry that was forgotten, posted twice, or should not exist.' },
    { id: 'C4', name: 'Asset-life guard', blocks: 'A fully depreciated asset that keeps depreciating, or depreciation beyond cost.' },
    { id: 'C5', name: 'Fluctuation review', blocks: 'An expense that moves more than 20% and more than $100 versus last month without an explanation.' },
    { id: 'C6', name: 'Balance sheet balances', blocks: 'Assets not equal to Liabilities + Equity.' },
    { id: 'C7', name: 'Shadow recompute', blocks: 'A wrong amount in the posting path — every close amount is recomputed independently from raw data.' },
    { id: 'C8', name: 'Period lock', blocks: 'A closed month quietly edited after it was locked.' },
  ];

  M.runControls = function (books, res, opts = {}) {
    const s = M.SETUP, p = books.period, end = M.periodEnd(p), prev = M.shiftPeriod(p, -1);
    const findings = [];
    const add = (control, severity, message, detail = '') => findings.push({ control, severity, message, detail });
    const posted = tag => res.adjustments.filter(j => j.tag === tag);
    const postedTo = (tag, acct) => sum(posted(tag), j => sum(j.lines.filter(l => l.acct === acct), l => l.dr - l.cr));

    // C1 balanced entries
    for (const je of res.ledger) {
      const d = M.lineTotal(je.lines, 'dr'), c = M.lineTotal(je.lines, 'cr');
      if (d !== c) add('C1', 'CRITICAL', `Entry ${je.id} does not balance`, `${je.memo}: debits ${M.usd(d)} vs credits ${M.usd(c)}`);
    }
    if (res.tb.totalDr !== res.tb.totalCr) add('C1', 'CRITICAL', 'Trial balance does not balance', `Debits ${M.usd(res.tb.totalDr)} vs credits ${M.usd(res.tb.totalCr)}`);

    // C2 reconciliations tie
    for (const st of res.steps) {
      if (st.id === 'close') continue;
      if (st.diff !== 0) add('C2', 'CRITICAL', `${st.title} does not tie`, `Unexplained difference of ${M.usd(st.diff)} between the ledger and the support.`);
      for (const x of st.exceptions || []) add('C2', 'CRITICAL', 'Unexplained bank statement line', `${x.date} ${x.desc} ${M.usd(x.amount)}`);
    }

    // C3 completeness — expected entries derived independently from the sub-ledgers and documents
    const expected = {};
    const exp = tag => { expected[tag] = (expected[tag] || 0) + 1; };
    books.docs.processor.forEach(r => { if (r.settleDate <= end) exp('card-settlement'); });
    books.docs.bank.lines.forEach(l => { if (/service fee/i.test(l.desc)) exp('bank-fee'); else if (/interest earned/i.test(l.desc)) exp('bank-interest'); });
    if (books.docs.count.value !== books.docs.count.book) exp('shrinkage');
    if (books.docs.cafeCount.value !== books.docs.cafeCount.book) exp('cafe-waste');
    books.prepaids.forEach(pp => { if (shadow.prepaid(pp, p) > 0) exp('prepaid:' + pp.id); });
    books.assets.forEach(a => { if (shadow.dep(a, p) > 0) exp('dep:' + a.id); });
    const pays = books.events.filter(e => e.type === 'payroll').map(e => e.date).sort();
    const wageDays = M.dayDiff(pays.length ? pays[pays.length - 1] : books.opening.lastPayroll, end);
    if (wageDays > 0) exp('accrual:wages');
    exp("accrual:utilities");
    if (M.loanInterest(-(books.opening.balances["2500"] || 0)) > 0) exp("accrual:interest"); // no loan left, no interest to accrue
    const actual = {};
    res.adjustments.forEach(j => { actual[j.tag] = (actual[j.tag] || 0) + 1; });
    const nice = tag => tag.replace('accrual:', 'accrual – ').replace('prepaid:', 'prepaid – ').replace('dep:', 'depreciation – ');
    for (const tag of Object.keys(expected)) {
      const a = actual[tag] || 0, e = expected[tag];
      if (a < e) add('C3', 'CRITICAL', `Missing month-end entry: ${nice(tag)}`, `Expected ${e}, found ${a}.`);
      if (a > e) add('C3', 'CRITICAL', `Duplicate month-end entry: ${nice(tag)}`, `Expected ${e}, found ${a}.`);
    }
    for (const tag of Object.keys(actual)) if (!expected[tag]) add('C3', 'CRITICAL', `Unexpected month-end entry: ${nice(tag)}`, 'Nothing in the sub-ledgers calls for this entry.');

    // C4 asset-life guard
    for (const a of books.assets) {
      const dep = postedTo('dep:' + a.id, '6500');
      const monthsUsed = Math.min(Math.max(M.monthIndex(prev) - M.monthIndex(a.inService), 0), a.life);
      const openingAccum = M.monthIndex(prev) > M.monthIndex(a.inService) ? (monthsUsed >= a.life ? a.cost : Math.floor(a.cost / a.life) * monthsUsed) : 0;
      if (dep > 0 && monthsUsed >= a.life) add('C4', 'CRITICAL', `Fully depreciated asset still depreciating: ${a.name}`, `${monthsUsed} of ${a.life} months already used; ${M.usd(dep)} posted this month.`);
      if (openingAccum + dep > a.cost) add('C4', 'CRITICAL', `Accumulated depreciation exceeds cost: ${a.name}`, `${M.usd(openingAccum + dep)} vs cost ${M.usd(a.cost)}.`);
    }

    // C5 fluctuation review vs last month
    // last month's actual results when last month was closed in this app; otherwise the preset baseline
    const base = books.opening.expenseBaseline || M.baseline(p), flux = [];
    const scheduleExpected = {
      '6400': sum(books.prepaids.filter(x => x.expense === '6400'), x => shadow.prepaid(x, p)),
      '6410': sum(books.prepaids.filter(x => x.expense === '6410'), x => shadow.prepaid(x, p)),
      '6500': sum(books.assets, a => shadow.dep(a, p)),
    };
    for (const a of M.ACCOUNTS.filter(x => x.type === 'X')) {
      const cur = acctSum(res.ledger, a.code), prior = base[a.code] || 0, delta = cur - prior;
      const pct = prior ? delta * 100 / prior : null;
      const big = Math.abs(delta) > 10000 && (prior === 0 || Math.abs(delta) * 100 > 20 * Math.abs(prior));
      let status = 'OK';
      if (big) {
        if (a.code in scheduleExpected && cur === scheduleExpected[a.code]) {
          status = 'Explained';
          add('C5', 'INFO', `${a.name} moved ${pct === null ? 'from zero' : pct.toFixed(0) + '%'} — explained by its schedule`, 'A prepaid ended/started or an asset finished/started depreciating.');
        } else {
          status = 'Review';
          add('C5', 'WARN', `${a.name} moved ${pct === null ? 'from zero' : (pct > 0 ? '+' : '') + pct.toFixed(0) + '%'} vs last month`, `${M.usd(prior)} → ${M.usd(cur)} (${delta > 0 ? '+' : ''}${M.usd(delta)}). Needs an explanation.`);
        }
      }
      if (cur || prior) flux.push({ ...a, prior, cur, delta, pct, status });
    }

    // C6 balance sheet
    if (res.statements.bsDiff !== 0) add('C6', 'CRITICAL', 'Balance sheet does not balance', `Assets − (Liabilities + Equity) = ${M.usd(res.statements.bsDiff)}`);

    // C7 shadow recompute
    const shadowChecks = []; // every comparison, kept so the Controls screen can show its evidence
    const check = (label, postedAmt, shadowAmt) => { shadowChecks.push({ label, posted: postedAmt, shadow: shadowAmt }); if (postedAmt !== shadowAmt) add('C7', 'CRITICAL', `Shadow recompute disagrees: ${label}`, `Posted ${M.usd(postedAmt)}, independent recompute ${M.usd(shadowAmt)}.`); };
    books.prepaids.forEach(pp => check(pp.name, postedTo('prepaid:' + pp.id, pp.expense), shadow.prepaid(pp, p)));
    books.assets.forEach(a => check('depreciation – ' + a.name, postedTo('dep:' + a.id, '6500'), shadow.dep(a, p)));
    check("loan interest accrual", postedTo("accrual:interest", "7000"), shadow.interest({ principal: Math.max(0, -(books.opening.balances["2500"] || 0)), rateBps: s.loan.rateBps }));
    check('card settlement cash', postedTo('card-settlement', '1000'),
      sum(books.docs.processor.filter(r => r.settleDate <= end), r => r.gross - (r.gross > 0 ? Math.round(r.gross * s.cardFeeBps / 10000) : 0)));

    // C8 period lock
    if (opts.lock && (opts.lock.period !== p || opts.lock.inputHash !== res.lock.inputHash || opts.lock.ledgerHash !== res.lock.ledgerHash)) {
      add('C8', 'CRITICAL', 'Closed period was changed after it was locked', `Sealed period ${opts.lock.period}, current ${p}. Sealed input ${opts.lock.inputHash}, current ${res.lock.inputHash}. Sealed ledger ${opts.lock.ledgerHash}, current ${res.lock.ledgerHash}.`);
    }

    const order = { CRITICAL: 0, WARN: 1, INFO: 2 };
    findings.sort((a, b) => order[a.severity] - order[b.severity] || a.control.localeCompare(b.control));
    const status = {};
    for (const c of M.CONTROLS) {
      const fs = findings.filter(x => x.control === c.id);
      status[c.id] = fs.some(x => x.severity === 'CRITICAL') ? 'FAIL' : fs.some(x => x.severity === 'WARN') ? 'WARN' : 'PASS';
    }
    return { findings, flux, status, evidence: { expected, actual, shadowChecks } };
  };

  // ---------- roll-forward and the year ----------
  // Everything the next month needs to open exactly where this month closed.
  M.closingSnapshot = function (books, res) {
    const end = M.periodEnd(books.period);
    const balances = {};
    for (const r of res.tb.rows) if ('ALE'.includes(r.type) && r.net) balances[r.code] = r.net;
    balances['3100'] = (balances['3100'] || 0) - res.statements.netIncome; // this month's profit moves into retained earnings
    const pays = books.events.filter(e => e.type === 'payroll' && e.date <= end).map(e => e.date).sort();
    const bank = res.steps.find(s => s.id === 'bank').detail;
    const expenses = {};
    for (const r of res.tb.rows) if (r.type === 'X') expenses[r.code] = r.net;
    return {
      period: books.period, balances,
      lastPayroll: pays.length ? pays[pays.length - 1] : books.opening.lastPayroll,
      cardRows: books.docs.processor.filter(r => r.settleDate > end).map(r => ({ saleDate: r.saleDate, gross: r.gross })),
      bankClosing: books.docs.bank.closing,
      bankOutstanding: bank.outstanding.map(o => ({ date: o.date, amount: o.amount, memo: o.broughtForward ? o.memo : `${o.memo} (from ${M.periodLabel(books.period)})` })),
      bankAfterPeriod: books.docs.bank.afterPeriod.map(l => ({ ...l })),
      assets: books.assets.filter(a => a.id.startsWith("eq-")).map(a => ({ ...a })),
      prepaids: books.prepaids.filter(pp => pp.id.startsWith("pp-")).map(pp => ({ ...pp })), // renewals keep amortising next month
      expenses,
    };
  };

  // Build and close one month on top of the previous month's closing snapshot.
  M.closeMonth = function (monthState, prior, opts = {}) {
    const books = M.buildBooks({ ...monthState, prior });
    const result = M.runClose(books, opts);
    return { books, result, snapshot: result.counts.crit === 0 ? M.closingSnapshot(books, result) : null };
  };

  // Year-to-date statements from a run of consecutive closed months.
  M.yearStatements = function (closed) {
    if (!closed.length) return null;
    const lineCodes = ['4000', '4010', '4100', '5000', '5010', '5020', '5030', '6000', '6100', '6200', '6300', '6400', '6410', '6500', '6600', '6700', '4900', '7000'];
    const months = closed.map(({ period, result }) => {
      const st = result.statements;
      const amt = code => {
        const r = st.revenue.concat(st.expenses).find(x => x.code === code);
        return r ? r.amount : 0;
      };
      return { period, st, lines: Object.fromEntries(lineCodes.map(c => [c, amt(c)])) };
    });
    const total = key => months.reduce((t, m) => t + key(m), 0);
    const first = closed[0], last = closed[closed.length - 1];
    const openingTb = M.trialBalance(first.books.entries.filter(j => j.source === 'opening'));
    const opening = M.statements(openingTb);
    const closing = last.result.statements;
    const openingEquity = opening.totalEquity, ytdNetIncome = total(m => m.st.netIncome);
    return {
      months, lineCodes,
      totals: {
        lines: Object.fromEntries(lineCodes.map(c => [c, total(m => m.lines[c])])),
        netSales: total(m => m.st.netSales), cogs: total(m => m.st.cogs), grossProfit: total(m => m.st.grossProfit),
        netIncome: ytdNetIncome,
      },
      opening, closing, openingEquity,
      equityCheck: openingEquity + ytdNetIncome - closing.totalEquity, // must be 0: nothing but profit changes equity
      firstPeriod: first.period, lastPeriod: last.period,
    };
  };

  // ---------- fault-injection demo ----------
  M.FAULTS = [
    { id: 'unbalanced_entry', label: 'An unbalanced journal entry slips into the books', expect: 'C1', build: { events: ev => { ev.push({ id: 'fx1', date: ev[Math.floor(ev.length / 2)].date, type: 'supplies', source: 'generated', amount: 12345, unbalance: 1000 }); return ev; } } },
    { id: 'opening_typo', label: 'Opening cash keyed in $500 too high', expect: 'C6', build: { openingCashTypo: 50000 } },
    { id: 'bank_fee_missed', label: "The bank's service fee is never booked", expect: 'C2', close: { skipBankFee: true } },
    { id: 'wrong_tax', label: 'A sale is taxed at 7% instead of 8%', expect: 'C2', build: { events: ev => { ev.find(x => x.type === 'book_sale').taxBps = 700; return ev; } } },
    { id: 'missing_accrual', label: 'The month-end wages accrual is forgotten', expect: 'C3', close: { dropWagesAccrual: true } },
    { id: 'dead_asset', label: 'A fully depreciated asset keeps depreciating', expect: 'C4', close: { deadAssetDepreciates: true } },
    { id: 'double_rent', label: 'Rent is recorded twice', expect: 'C5', build: { events: ev => { const r = ev.find(x => x.type === 'rent'); ev.push({ ...r, id: 'fx2' }); return ev; } } },
    { id: 'tampered_amount', label: 'An amortization amount is altered in the posting path', expect: 'C7', close: { tamperPrepaid: true } },
    { id: 'edited_after_lock', label: 'A closed month is edited after it was locked', expect: 'C8', afterLock: true },
  ];

  M.runGuardrailDemo = function (period, seed) {
    const gen = M.generateMonth(period, seed);
    const state = { period, seed, events: gen.events, shrinkBps: gen.shrinkBps, cafeWasteBps: gen.cafeWasteBps, countOverride: null };
    const base = M.runClose(M.buildBooks(state));
    const loud = r => r.findings.filter(x => x.severity !== "INFO");
    // the figures a reader cares about, so the demo can show what each mistake would have done to the books
    const metrics = r => ({ netIncome: r.statements.netIncome, cash: acctSum(r.ledger, "1000"), salesTax: -acctSum(r.ledger, "2100"),
      expenses: r.statements.totalExpenses, bsDiff: r.statements.bsDiff, tbDiff: r.tb.totalDr - r.tb.totalCr, verdict: r.verdict, crit: r.counts.crit, warn: r.counts.warn, findings: loud(r) });
    const results = [{ id: 'baseline', label: 'Baseline – clean generated month, no fault', expect: '—', pass: loud(base).length === 0, caught: null, also: [...new Set(loud(base).map(x => x.control))], metrics: metrics(base) }];
    for (const fx of M.FAULTS) {
      let res;
      if (fx.afterLock) {
        const edited = { ...state, events: state.events.map(e => (e.type === 'book_sale' && e.date === state.events[0].date && e.method === 'cash' ? { ...e, amount: e.amount + 100 } : e)) };
        res = M.runClose(M.buildBooks(edited), { lock: base.lock });
      } else {
        res = M.runClose(M.buildBooks(state, fx.build || {}), { faults: fx.close || {} });
      }
      const hit = res.findings.find(x => x.control === fx.expect && (x.severity === 'CRITICAL' || (fx.expect === 'C5' && x.severity === 'WARN')));
      results.push({ ...fx, pass: !!hit, caught: hit || null, also: [...new Set(loud(res).map(x => x.control).filter(c => c !== fx.expect))], verdict: res.verdict, metrics: metrics(res) });
    }
    return { period, seed, results, allHeld: results.every(r => r.pass) };
  };

  // ---------- planting the mistakes into a real month ----------
  // Transaction mistakes change the month's own events (each marked `planted` so it can be shown);
  // the rest are switched on in the opening or in the close, as a typo, a skipped step or a bug would be.
  M.plantFaults = function (period, events, ids = M.FAULTS.map(f => f.id)) {
    const on = new Set(ids), ev = events.map(e => ({ ...e })), build = {}, close = {}, changes = {};
    const sorted = ev.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const midDate = sorted.length ? sorted[Math.floor(sorted.length / 2)].date : M.periodStart(period);
    const free = pred => ev.find(e => !e.planted && pred(e));
    let n = 0;
    const add = (fault, e) => { const x = { id: 'px' + ++n, source: 'planted', planted: fault, ...e }; ev.push(x); return x; };
    if (on.has('unbalanced_entry')) {
      add('unbalanced_entry', { date: midDate, type: 'supplies', amount: 12345, unbalance: 1000 });
      changes.unbalanced_entry = `A ${M.usd(12345)} supplies purchase is added on ${M.shortDate(midDate)}, with its debit $10.00 more than its credit.`;
    }
    if (on.has('opening_typo')) {
      build.openingCashTypo = 50000;
      changes.opening_typo = `Opening cash brought forward is raised by ${M.usd(50000)}.`;
    }
    if (on.has('bank_fee_missed')) {
      close.skipBankFee = true;
      changes.bank_fee_missed = "The close is told to skip booking the bank's service fee.";
    }
    if (on.has('wrong_tax')) {
      const sale = free(e => e.type === 'book_sale' && e.method === 'card') || free(e => e.type === 'book_sale');
      if (sale) { sale.taxBps = 700; sale.planted = 'wrong_tax'; changes.wrong_tax = `Your ${M.usd(sale.amount)} of ${sale.method} book sales on ${M.shortDate(sale.date)} are re-taxed at 7%.`; }
      else { const x = add('wrong_tax', { date: midDate, type: 'book_sale', method: 'card', amount: 50000, taxBps: 700 }); changes.wrong_tax = `${M.usd(x.amount)} of card book sales taxed at 7% is added on ${M.shortDate(x.date)}.`; }
    }
    if (on.has('missing_accrual')) {
      close.dropWagesAccrual = true;
      changes.missing_accrual = 'The close is told to leave out the wages accrual.';
    }
    if (on.has('dead_asset')) {
      close.deadAssetDepreciates = true;
      changes.dead_asset = 'The depreciation run is given a copied formula that ignores the end of an asset\'s life.';
    }
    if (on.has('double_rent')) {
      const rent = free(e => e.type === 'rent');
      if (rent) { add('double_rent', { ...rent, id: undefined, source: 'planted', planted: 'double_rent' }); changes.double_rent = `Your ${M.usd(rent.amount)} rent payment on ${M.shortDate(rent.date)} is entered a second time.`; }
      else {
        for (let i = 0; i < 2; i++) add('double_rent', { date: M.periodStart(period), type: 'rent', amount: M.SETUP.rent });
        changes.double_rent = `The month's ${M.usd(M.SETUP.rent)} rent is entered twice on ${M.shortDate(M.periodStart(period))}.`;
      }
    }
    if (on.has('tampered_amount')) {
      close.tamperPrepaid = true;
      changes.tampered_amount = 'The posting code is altered to add $50.00 to the insurance amortisation.';
    }
    if (on.has('edited_after_lock')) {
      const sale = free(e => e.type === 'book_sale' && e.method === 'cash') || free(e => e.amount > 0 && !e.lines);
      if (sale) { sale.amount += 100; sale.planted = 'edited_after_lock'; changes.edited_after_lock = `After the month is sealed, $1.00 is added to ${sale.type === 'book_sale' ? `the ${sale.method} book sales` : `the ${M.TEMPLATES[sale.type].label.toLowerCase()}`} on ${M.shortDate(sale.date)}.`; }
      else { add('edited_after_lock', { date: midDate, type: 'book_sale', method: 'cash', amount: 100 }); changes.edited_after_lock = `After the month is sealed, a $1.00 cash sale is slipped in on ${M.shortDate(midDate)}.`; }
    }
    ev.forEach(e => { if (e.id === undefined) e.id = 'px' + ++n; });
    return { events: ev, build, close, changes };
  };

  // What each planted mistake does on its own to this month's real figures, next to the clean month.
  M.plantedDemo = function (state, prior) {
    const clean = { ...state, prior };
    const base = M.runClose(M.buildBooks(clean));
    const loud = r => r.findings.filter(x => x.severity !== 'INFO');
    const metrics = r => ({ netIncome: r.statements.netIncome, cash: acctSum(r.ledger, '1000'), salesTax: -acctSum(r.ledger, '2100'),
      expenses: r.statements.totalExpenses, bsDiff: r.statements.bsDiff, tbDiff: r.tb.totalDr - r.tb.totalCr, verdict: r.verdict, crit: r.counts.crit, warn: r.counts.warn, findings: loud(r) });
    const results = [{ id: 'baseline', pass: loud(base).length === 0, also: [], metrics: metrics(base) }];
    for (const fx of M.FAULTS) {
      const pl = M.plantFaults(state.period, state.events, [fx.id]);
      const res = M.runClose(M.buildBooks({ ...clean, events: pl.events }, pl.build), { faults: pl.close, lock: fx.afterLock ? base.lock : null });
      const hit = res.findings.find(x => x.control === fx.expect && (x.severity === 'CRITICAL' || (fx.expect === 'C5' && x.severity === 'WARN')));
      results.push({ ...fx, pass: !!hit, caught: hit || null, also: [...new Set(loud(res).map(x => x.control).filter(c => c !== fx.expect))], metrics: metrics(res) });
    }
    return { period: state.period, results, allHeld: results.slice(1).every(r => r.pass), cleanLock: base.lock };
  };
})();

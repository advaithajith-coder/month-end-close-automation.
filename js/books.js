            'use strict';
// Recording the month: transaction templates, the auto-generator, opening balances,
// building the ledger, and the outside documents (bank statement, card report, stock count).
(function () {
  const M = window.MEC;
  const { dr, cr } = M;
  const S = () => M.SETUP;

  const methodAcct = m => (m === 'card' ? '1100' : '1000');
  const METHOD = { key: 'method', label: 'Paid by', kind: 'select', options: [['card', 'Card'], ['cash', 'Cash']], default: 'card' };
  const VENDOR = { key: 'vendor', label: 'Publisher / vendor', kind: 'select', options: () => S().vendors.map(v => [v, v]), default: () => S().vendors[0] };
  const money = (label, def) => ({ key: 'amount', label, kind: 'money', default: def });
  const taxOf = e => M.pct(e.amount, e.taxBps ?? S().taxBps);
  const costOf = e => M.pct(e.amount, S().costBps);
  const cafeCostOf = e => M.pct(e.amount, S().cafeCostBps);

  // Every template produces a balanced journal entry from a few simple inputs.
  M.TEMPLATES = {
    book_sale: {
      label: 'Book sales (day total)', group: 'Sales', usual: 'Every day',
      fields: [money('Sales before tax', 120000), METHOD],
      describe: e => `Book sales – ${e.method}`,
      lines: e => [dr(methodAcct(e.method), e.amount + taxOf(e)), cr('4000', e.amount), cr('2100', taxOf(e)), dr('5000', costOf(e)), cr('1200', costOf(e))],
    },
    cafe_sale: {
      label: 'Café sales (day total)', group: 'Sales', usual: 'Every day',
      fields: [money('Sales before tax', 25000), METHOD],
      describe: e => `Café sales – ${e.method}`,
      lines: e => [dr(methodAcct(e.method), e.amount + taxOf(e)), cr('4010', e.amount), cr('2100', taxOf(e)), dr('5020', cafeCostOf(e)), cr('1210', cafeCostOf(e))],
    },
    sale_return: {
      label: 'Customer return', group: 'Sales', usual: 'Occasionally',
      fields: [money('Refund before tax', 2500), METHOD],
      describe: e => `Customer return – refunded by ${e.method}`,
      lines: e => [dr('4100', e.amount), dr('2100', taxOf(e)), cr(methodAcct(e.method), e.amount + taxOf(e)), dr('1200', costOf(e)), cr('5000', costOf(e))],
    },
    giftcard_sold: {
      label: 'Gift card sold', group: 'Sales', usual: 'Occasionally',
      fields: [money('Card value', 5000), METHOD],
      describe: e => `Gift card sold – ${e.method}`,
      lines: e => [dr(methodAcct(e.method), e.amount), cr('2300', e.amount)],
    },
    giftcard_redeemed: {
      label: 'Gift card redeemed for books', group: 'Sales', usual: 'Occasionally',
      fields: [money('Books before tax', 3000)],
      describe: () => 'Gift card redeemed for books',
      lines: e => [dr('2300', e.amount + taxOf(e)), cr('4000', e.amount), cr('2100', taxOf(e)), dr('5000', costOf(e)), cr('1200', costOf(e))],
    },
    inventory_purchase: {
      label: 'Buy books from publisher (on account)', group: 'Purchases & payments', usual: 'Every Monday',
      fields: [money('Invoice amount', 450000), VENDOR],
      describe: e => `Books purchased on account – ${e.vendor}`,
      lines: e => [dr('1200', e.amount), cr('2000', e.amount)],
    },
    cafe_purchase: {
      label: 'Buy café stock (on account)', group: 'Purchases & payments', usual: 'Every Thursday',
      fields: [money('Invoice amount', 62000)],
      describe: () => `Café stock purchased on account – ${S().cafeVendor}`,
      lines: e => [dr('1210', e.amount), cr('2000', e.amount)],
    },
    vendor_payment: {
      label: 'Pay publisher (check)', group: 'Purchases & payments', usual: '10th, and late month',
      fields: [money('Check amount', ctx => (ctx && ctx.opening ? ctx.opening.ap : S().opening.ap)), { ...VENDOR, options: () => [['Various (last month)', 'Various (last month)']].concat(S().vendors.map(v => [v, v]), [[S().cafeVendor, S().cafeVendor]]), default: 'Various (last month)' }],
      describe: e => `Check to ${e.vendor}`,
      lines: e => [dr('2000', e.amount), cr('1000', e.amount)],
    },
    supplies: {
      label: 'Store supplies (debit card)', group: 'Purchases & payments', usual: '3rd and 17th',
      fields: [money('Amount', 28000)],
      describe: () => 'Store supplies – bags, receipt rolls, cleaning',
      lines: e => [dr('6700', e.amount), cr('1000', e.amount)],
    },
    equipment_purchase: {
      label: 'Buy equipment (debit card)', group: 'Purchases & payments', usual: 'Rarely',
      fields: [money('Cost', 250000), { key: 'name', label: 'What is it?', kind: 'text', default: 'Reading nook furniture' }, { key: 'life', label: 'Useful life (months)', kind: 'int', default: 60 }],
      describe: e => `Equipment purchased – ${e.name}`,
      lines: e => [dr('1500', e.amount), cr('1000', e.amount)],
    },
    payroll: {
      label: 'Payroll (direct deposit)', group: 'Bills & payroll', usual: 'Every 2 weeks',
      fields: [money('Pay amount', ctx => ctx.payrollDefault)],
      describe: () => 'Payroll – staff wages',
      lines: e => [dr('6000', e.amount), cr('1000', e.amount)],
    },
    rent: {
      label: 'Store rent', group: 'Bills & payroll', usual: '1st of month',
      fields: [money('Amount', () => S().rent)],
      describe: () => 'Rent – landlord ACH',
      lines: e => [dr('6100', e.amount), cr('1000', e.amount)],
    },
    utility_bill: {
      label: "Utility bill (last month's usage)", group: 'Bills & payroll', usual: '12th',
      fields: [money('Amount', 86000)],
      describe: () => 'Utilities – power & water (autopay)',
      lines: e => [dr('6200', e.amount), cr('1000', e.amount)],
    },
    interest_payment: {
      label: 'Loan interest payment', group: 'Bills & payroll', usual: '5th',
      fields: [money('Amount', () => M.monthlyInterest(S().loan))],
      describe: () => 'Bank loan – monthly interest',
      lines: e => [dr('7000', e.amount), cr('1000', e.amount)],
    },
    sales_tax_remittance: {
      label: "Pay last month's sales tax", group: 'Bills & payroll', usual: '20th',
      fields: [money('Amount', ctx => (ctx && ctx.opening ? ctx.opening.salesTax : S().opening.salesTax))],
      describe: () => 'Sales tax remitted to the state',
      lines: e => [dr('2100', e.amount), cr('1000', e.amount)],
    },

    // ---------- owner, loan, renewals and stock adjustments ----------
    owner_contribution: {
      label: 'Owner puts money into the business', group: 'Owner & financing', usual: 'Occasionally',
      fields: [money('Amount', 500000)],
      describe: () => "Owner's contribution – deposited to the bank",
      lines: e => [dr('1000', e.amount), cr('3000', e.amount)],
    },
    owner_drawing: {
      label: 'Owner takes money out (drawings)', group: 'Owner & financing', usual: 'Occasionally',
      fields: [money('Amount', 200000)],
      describe: () => "Owner's drawings – withdrawn from the bank",
      lines: e => [dr('3200', e.amount), cr('1000', e.amount)],
    },
    loan_repayment: {
      label: 'Repay part of the bank loan', group: 'Owner & financing', usual: 'Occasionally',
      fields: [money('Principal repaid', 250000)],
      describe: () => 'Bank loan – principal repayment',
      lines: e => [dr('2500', e.amount), cr('1000', e.amount)],
    },
    prepaid_purchase: {
      label: 'Renew insurance or software (paid in advance)', group: 'Owner & financing', usual: 'Once a year',
      fields: [
        { key: 'kind', label: 'What is renewed', kind: 'select', options: [['insurance', 'Store insurance'], ['software', 'POS & inventory software']], default: 'insurance' },
        money('Amount paid', 720000),
        { key: 'months', label: 'Months it covers', kind: 'int', default: 12 },
        { key: 'starts', label: 'Cover starts', kind: 'select', options: [['next', 'Next month'], ['this', 'This month']], default: 'next' },
      ],
      describe: e => `${e.kind === 'software' ? 'Software licence' : 'Insurance'} renewal – ${e.months} months paid in advance`,
      lines: e => [dr(e.kind === 'software' ? '1310' : '1300', e.amount), cr('1000', e.amount)],
    },
    publisher_return: {
      label: 'Return books to a publisher (credit note)', group: 'Owner & financing', usual: 'Occasionally',
      fields: [money('Credit note amount', 50000), VENDOR],
      describe: e => `Books returned to ${e.vendor} for credit`,
      lines: e => [dr('2000', e.amount), cr('1200', e.amount)],
    },
    stock_writeoff: {
      label: 'Write off damaged stock', group: 'Owner & financing', usual: 'Occasionally',
      fields: [money('Cost of the damaged books', 15000), { key: 'reason', label: 'What happened', kind: 'text', default: 'Water-damaged books' }],
      describe: e => `Stock written off – ${e.reason}`,
      lines: e => [dr('5010', e.amount), cr('1200', e.amount)],
    },

    // ---------- anything else: a manual journal entry, lines typed by the user ----------
    manual: {
      label: 'Manual journal entry', group: 'Journal entry', usual: 'For anything not listed above',
      fields: [],
      describe: e => `Manual: ${e.memo}`,
      lines: e => e.lines.map(l => ({ acct: l.acct, dr: l.dr, cr: l.cr })),
    },
  };
  M.TEMPLATE_GROUPS = ['Sales', 'Purchases & payments', 'Bills & payroll', 'Owner & financing', 'Journal entry'];

  // A renewal paid in advance joins the prepaid schedule and is amortised like the original policies.
  M.prepaidFromEvent = e => ({
    id: 'pp-' + e.id, name: e.kind === 'software' ? 'Software licence renewal' : 'Insurance renewal',
    asset: e.kind === 'software' ? '1310' : '1300', expense: e.kind === 'software' ? '6410' : '6400',
    total: e.amount, start: e.starts === 'this' ? e.date.slice(0, 7) : M.shiftPeriod(e.date.slice(0, 7), 1), months: e.months || 12,
  });

  // How each cash transaction shows up on the bank statement: description + days until it clears.
  const BANK = {
    book_sale: ['Cash deposit', 1], cafe_sale: ['Cash deposit', 1], giftcard_sold: ['Cash deposit', 1],
    sale_return: ['Register refund adjustment', 1], vendor_payment: [null, null],
    payroll: ['Payroll direct deposit', 0], rent: ['ACH – landlord rent', 0], utility_bill: ['ACH – city power & water', 0],
    interest_payment: ['Loan interest debit', 0], sales_tax_remittance: ['State sales tax e-payment', 1],
    supplies: ['Debit card purchase', 1], equipment_purchase: ['Debit card purchase', 1],
    owner_contribution: ['Owner deposit', 1], owner_drawing: ['Owner withdrawal', 0], loan_repayment: ['Loan principal repayment', 0],
    prepaid_purchase: ['Debit card purchase', 1], manual: ['Bank transfer', 0],
  };
  M.bankInfo = function (e, seed) {
    const [desc, lag] = BANK[e.type] || ['Bank transaction', 0];
    if (lag === null) return { desc: 'Check paid – ' + (e.vendor || 'vendor'), lag: 3 + (M.hash32(e.id + ':' + seed) % 4) };
    return { desc, lag };
  };

  // Opening balances for a period. With `prior` (the previous month's closing snapshot) the month
  // opens exactly where last month closed; without it, balances are derived from the store setup.
  M.opening = function (period, prior) {
    const s = S(), prev = M.shiftPeriod(period, -1), prevEnd = M.periodEnd(prev);
    if (prior) {
      if (prior.period !== prev) throw new Error(`${M.periodLabel(period)} must open from ${M.periodLabel(prev)}'s close`);
      const b = { ...prior.balances };
      return {
        balances: b, lines: Object.keys(b).sort().filter(k => b[k] !== 0).map(k => M.line(k, b[k])), prevEnd,
        lastPayroll: prior.lastPayroll,
        accruedWages: -(b['2200'] || 0), accruedUtilities: -(b['2210'] || 0), accruedInterest: -(b['2220'] || 0),
        cardRows: prior.cardRows.map(x => ({ ...x })),
        ap: -(b['2000'] || 0), salesTax: -(b['2100'] || 0), giftCards: -(b['2300'] || 0),
        bankOpening: prior.bankClosing,
        bankOutstanding: prior.bankOutstanding.map(x => ({ ...x })),
        bankCarried: prior.bankAfterPeriod.map(x => ({ ...x })),
        extraAssets: prior.assets.map(a => ({ ...a })),
        extraPrepaids: (prior.prepaids || []).map(pp => ({ ...pp })),
        expenseBaseline: { ...prior.expenses },
        fromPrior: true,
      };
    }
    const lastPayroll = M.addDays(prevEnd, -3);
    const accruedWages = s.dailyWage * M.dayDiff(lastPayroll, prevEnd);
    const interest = M.monthlyInterest(s.loan);
    const cardRows = [
      { saleDate: M.addDays(prevEnd, -1), gross: s.opening.cardClearing[0] },
      { saleDate: prevEnd, gross: s.opening.cardClearing[1] },
    ];
    const b = {};
    const put = (a, v) => { b[a] = (b[a] || 0) + v; };
    put('1000', s.opening.cash);
    put('1100', cardRows.reduce((t, x) => t + x.gross, 0));
    put('1200', s.opening.inventory);
    put('1210', s.opening.cafeStock);
    for (const pp of s.prepaids) put(pp.asset, pp.total - M.prepaidAmortThrough(pp, prev));
    for (const a of s.assets) { put('1500', a.cost); put('1510', -M.depreciationThrough(a, prev)); }
    put('2000', -s.opening.ap); put('2100', -s.opening.salesTax); put('2200', -accruedWages);
    put('2210', -s.utilityEstimate); put('2220', -interest); put('2300', -s.opening.giftCards);
    put('2500', -s.loan.principal); put('3000', -s.opening.ownerCapital);
    put('3100', -Object.values(b).reduce((t, v) => t + v, 0)); // retained earnings balances the books
    const lines = Object.keys(b).sort().filter(k => b[k] !== 0).map(k => M.line(k, b[k]));
    return {
      balances: b, lines, prevEnd, lastPayroll, accruedWages, accruedUtilities: s.utilityEstimate, accruedInterest: interest, cardRows,
      ap: s.opening.ap, salesTax: s.opening.salesTax, giftCards: s.opening.giftCards,
      bankOpening: s.opening.cash, bankOutstanding: [], bankCarried: [], extraAssets: [], extraPrepaids: [], expenseBaseline: null, fromPrior: false,
    };
  };

  // Default amount for a payroll on a given date: wages earned since the previous payroll.
  M.payrollDefault = function (state, date, op = M.opening(state.period, state.prior)) {
    const prior = state.events.filter(e => e.type === 'payroll' && e.date < date).map(e => e.date).sort();
    const from = prior.length ? prior[prior.length - 1] : op.lastPayroll;
    return Math.max(0, M.dayDiff(from, date)) * S().dailyWage;
  };

  // A realistic, seeded month of activity.
  M.generateMonth = function (period, seed, op = M.opening(period)) {
    const r = M.rng(seed * 7919 + M.monthIndex(period));
    const s = S(), days = M.periodDays(period), end = days[days.length - 1];
    const ev = []; let n = 0;
    const add = (date, type, props) => ev.push(Object.assign({ id: 'g' + (++n), date, type, source: 'generated' }, props));
    let gift = op.giftCards, lastPay = op.lastPayroll;
    const purchases = [];
    for (const d of days) {
      const dom = Number(d.slice(8)), wd = M.weekday(d), mult = (wd === 0 || wd === 6) ? 14 : 10; // weekends are busier
      if (dom === 1) add(d, 'rent', { amount: s.rent });
      if (dom === 3 || dom === 17) add(d, 'supplies', { amount: r.int(26000, 30000) });
      if (dom === 5) add(d, 'interest_payment', { amount: M.monthlyInterest(s.loan) });
      if (dom === 10 && op.ap > 0) add(d, 'vendor_payment', { amount: op.ap, vendor: 'Various (last month)' });
      if (dom === 12) add(d, 'utility_bill', { amount: r.int(80000, 92000) });
      if (dom === 20 && op.salesTax > 0) add(d, 'sales_tax_remittance', { amount: op.salesTax });
      if (wd === 1) {
        const amount = r.int(520000, 620000), vendor = s.vendors[purchases.length % s.vendors.length];
        add(d, 'inventory_purchase', { amount, vendor });
        purchases.push({ amount, vendor });
      }
      if (wd === 4) add(d, 'cafe_purchase', { amount: r.int(52000, 64000) });
      if (M.dayDiff(lastPay, d) === 14) { add(d, 'payroll', { amount: 14 * s.dailyWage }); lastPay = d; }
      const book = Math.round(r.int(95000, 140000) * mult / 10), bookCard = M.pct(book, 7200);
      add(d, 'book_sale', { amount: bookCard, method: 'card' });
      add(d, 'book_sale', { amount: book - bookCard, method: 'cash' });
      const cafe = Math.round(r.int(18000, 32000) * mult / 10), cafeCard = M.pct(cafe, 6000);
      add(d, 'cafe_sale', { amount: cafeCard, method: 'card' });
      add(d, 'cafe_sale', { amount: cafe - cafeCard, method: 'cash' });
      if (r.chance(0.25)) add(d, 'sale_return', { amount: r.int(1500, 6000), method: r.chance(0.7) ? 'card' : 'cash' });
      if (r.chance(0.2)) { const amount = r.pick([2500, 5000]) * r.int(1, 3); add(d, 'giftcard_sold', { amount, method: 'card' }); gift += amount; }
      if (r.chance(0.15)) {
        const amount = r.int(1500, 4500), tax = M.pct(amount, s.taxBps);
        if (amount + tax <= gift) { add(d, 'giftcard_redeemed', { amount }); gift -= amount + tax; }
      }
    }
    // pay the first publisher invoice late in the month – the check won't clear before month end
    if (purchases.length) add(M.addDays(end, -2), 'vendor_payment', { amount: purchases[0].amount, vendor: purchases[0].vendor });
    ev.sort(byDate);
    return { events: ev, shrinkBps: r.int(30, 60), cafeWasteBps: r.int(150, 350) };
  };

  const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  M.lineTotal = (lines, side) => lines.reduce((t, l) => t + l[side], 0);

  // Turn the inputs (events) into a ledger. hooks are used only by the fault-injection demo.
  M.buildBooks = function (state, hooks = {}) {
    const p = state.period, s = S(), op = M.opening(p, state.prior), start = M.periodStart(p);
    const entries = []; let n = 0;
    const post = je => { je.id = 'JE-' + String(++n).padStart(4, '0'); entries.push(je); return je; };

    const openLines = op.lines.map(l => ({ ...l }));
    if (hooks.openingCashTypo) openLines.find(l => l.acct === '1000').dr += hooks.openingCashTypo;
    post({ date: start, memo: 'Opening balances carried forward from ' + M.periodLabel(M.shiftPeriod(p, -1)), source: 'opening', type: 'opening', lines: openLines });
    post({
      date: start, memo: "Auto-reverse last month's accruals", source: 'system', type: 'reversal',
      lines: [dr('2200', op.accruedWages), cr('6000', op.accruedWages), dr('2210', op.accruedUtilities), cr('6200', op.accruedUtilities), dr('2220', op.accruedInterest), cr('7000', op.accruedInterest)]
        .filter(l => l.dr || l.cr),
    });

    let events = state.events.map(e => ({ ...e }));
    if (hooks.events) events = hooks.events(events);
    events.sort(byDate);
    const assets = s.assets.map(a => ({ ...a })).concat(op.extraAssets.map(a => ({ ...a }))); // + equipment bought in earlier months
    const prepaids = s.prepaids.map(pp => ({ ...pp })).concat((op.extraPrepaids || []).map(pp => ({ ...pp }))); // + renewals from earlier months
    for (const e of events) {
      const t = M.TEMPLATES[e.type];
      if (!t) continue;
      const lines = t.lines(e);
      if (e.unbalance) lines[0].dr += e.unbalance; // fault injection only – real inputs always balance
      else if (M.lineTotal(lines, 'dr') !== M.lineTotal(lines, 'cr')) throw new Error('Unbalanced entry from ' + e.type);
      if (e.type === 'manual' && lines.some(l => M.CONTROL_ACCOUNTS.includes(l.acct))) throw new Error('A manual journal entry cannot post to a control account');
      post({ date: e.date, memo: t.describe(e), source: e.source, type: e.type, eventId: e.id, event: e, lines });
      if (e.type === 'equipment_purchase') assets.push({ id: 'eq-' + e.id, name: e.name || 'New equipment', cost: e.amount, inService: e.date.slice(0, 7), life: e.life || 60 });
      if (e.type === 'prepaid_purchase') prepaids.push(M.prepaidFromEvent(e));
    }
    const books = { period: p, state, opening: op, entries, events, assets, prepaids };
    books.docs = M.buildDocs(books);
    return books;
  };

  // Documents that arrive from outside the store at month end.
  M.buildDocs = function (books) {
    const s = S(), p = books.period, end = M.periodEnd(p), state = books.state, seed = state.seed || 2026;

    // card processor report: one settlement per sales day, paid out two days later less the fee
    const byDay = {};
    for (const je of books.entries) {
      if (je.source === 'opening') continue;
      for (const l of je.lines) if (l.acct === '1100') byDay[je.date] = (byDay[je.date] || 0) + l.dr - l.cr;
    }
    const processor = books.opening.cardRows.map(x => ({ ...x }))
      .concat(Object.keys(byDay).sort().map(d => ({ saleDate: d, gross: byDay[d] })))
      .filter(r => r.gross !== 0);
    for (const r of processor) {
      r.fee = r.gross > 0 ? M.pct(r.gross, s.cardFeeBps) : 0;
      r.net = r.gross - r.fee;
      r.settleDate = M.addDays(r.saleDate, 2);
    }

    // bank statement: every cash movement clears after a realistic delay, plus bank-only items
    const all = [];
    for (const je of books.entries) {
      if (!je.event) continue;
      const cash = je.lines.reduce((t, l) => t + (l.acct === '1000' ? l.dr - l.cr : 0), 0);
      if (!cash) continue;
      const info = M.bankInfo(je.event, seed);
      all.push({ date: M.addDays(je.date, info.lag), desc: info.desc, amount: cash });
    }
    for (const r of processor) all.push({ date: r.settleDate, desc: 'Card processor deposit', amount: r.net });
    // checks and deposits from last month that the bank clears this month
    for (const c of books.opening.bankCarried) all.push({ ...c });
    all.push({ date: end, desc: 'Monthly service fee', amount: -s.bankFee });
    all.push({ date: end, desc: 'Interest earned', amount: M.pct(books.opening.bankOpening, s.bankInterestBps) });
    all.sort(byDate);
    const lines = all.filter(l => l.date <= end);
    const opening = books.opening.bankOpening;
    const closing = opening + lines.reduce((t, l) => t + l.amount, 0);

    // physical stock count
    const bookInv = books.entries.reduce((t, je) => t + je.lines.reduce((u, l) => u + (l.acct === '1200' ? l.dr - l.cr : 0), 0), 0);
    const shrinkBps = state.shrinkBps ?? 50;
    const override = state.countOverride !== null && state.countOverride !== undefined;
    const count = override ? state.countOverride : bookInv - M.pct(bookInv, shrinkBps);
    // café stock count: milk and pastries spoil, so a little is always lost
    const cafeBook = books.entries.reduce((t, je) => t + je.lines.reduce((u, l) => u + (l.acct === '1210' ? l.dr - l.cr : 0), 0), 0);
    const cafeWasteBps = state.cafeWasteBps ?? 250;
    const cafeCount = cafeBook - M.pct(Math.max(0, cafeBook), cafeWasteBps);

    return {
      processor,
      cafeCount: { book: cafeBook, value: cafeCount, wasteBps: cafeWasteBps },
      // card payouts after month end are re-created next month from the processor report, so they are not carried
      bank: { opening, closing, lines, afterPeriod: all.filter(l => l.date > end && l.desc !== 'Card processor deposit') },
      count: { book: bookInv, value: count, shrinkBps, override },
    };
  };
})();

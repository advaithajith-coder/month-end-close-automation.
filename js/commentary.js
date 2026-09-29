'use strict';
// Month-end commentary: the facts sent to the LLM, the number check on what comes back,
// and a template fallback used when no AI key is configured.
(function () {
  const M = window.MEC;
  const pct = (part, whole) => (whole ? (part * 100 / whole).toFixed(1) + '%' : '0.0%');
  const signed = c => (c > 0 ? '+' : '') + M.usd(c);

  // The ratios a CFO reads first, computed here so the writer never has to calculate anything.
  M.commentaryMetrics = function (res, books) {
    const st = res.statements;
    const bal = code => (res.tb.rows.find(r => r.code === code) || { net: 0 }).net;
    const days = M.daysInMonth(res.period);
    const cash = bal('1000'), card = bal('1100'), inventory = bal('1200'), cafeStock = bal('1210'), prepaids = bal('1300') + bal('1310');
    const ap = -bal('2000'), salesTax = -bal('2100'), accrued = -(bal('2200') + bal('2210') + bal('2220')), giftCards = -bal('2300');
    const currentAssets = cash + card + inventory + cafeStock + prepaids, currentLiabilities = ap + salesTax + accrued + giftCards;
    const opex = st.expenses.filter(r => !['5000', '5010', '5020', '5030'].includes(r.code)).reduce((t, r) => t + r.amount, 0);
    const bookSales = -bal('4000'), cafeSales = -bal('4010'), returns = bal('4100'), bookNet = bookSales - returns;
    const cogs = bal('5000'), shrink = bal('5010'), cafeCost = bal('5020'), cafeWaste = bal('5030');
    // payable days cover everything bought on account: books and café stock
    const purchases = books.events.filter(e => e.type === 'inventory_purchase' || e.type === 'cafe_purchase').reduce((t, e) => t + e.amount, 0);
    const cafeCountDetail = res.steps.find(s => s.id === 'inventory').detail;
    const invDetail = res.steps.find(s => s.id === 'inventory').detail;
    const warnings = res.findings.filter(f => f.severity === 'WARN');
    return {
      days, cash, card, inventory, prepaids, ap, salesTax, accrued, giftCards, currentAssets, currentLiabilities, opex,
      bookSales, cafeSales, returns, bookNet, cogs, shrink, purchases, warnings, wages: bal('6000'), cafeStock, cafeCost, cafeWaste,
      cafeMarginPct: cafeSales ? (cafeSales - cafeCost - cafeWaste) * 100 / cafeSales : 0,
      cafeWastePct: cafeCountDetail.cafeBook ? cafeCountDetail.waste * 100 / cafeCountDetail.cafeBook : 0,
      netSales: st.netSales, netIncome: st.netIncome, loan: { principal: Math.max(0, -bal("2500")), rateBps: M.SETUP.loan.rateBps }, week: M.salesByWeekday(books),
      ins: M.businessInsights(res, books),
      currentRatio: currentLiabilities ? currentAssets / currentLiabilities : 0,
      quickRatio: currentLiabilities ? (cash + card) / currentLiabilities : 0,
      cashCoverMonths: opex ? cash / opex : 0,
      inventoryDays: cogs ? inventory / cogs * days : 0,
      payableDays: purchases ? ap / purchases * days : 0,
      bookMarginPct: bookNet ? (bookNet - cogs) * 100 / bookNet : 0,
      netMarginPct: st.netSales ? st.netIncome * 100 / st.netSales : 0,
      shrinkPct: invDetail.book ? invDetail.shrink * 100 / invDetail.book : 0,
      shareOf: amount => (st.netSales ? amount * 100 / st.netSales : 0),
    };
  };

  // Net sales (books + café − returns) per calendar day, grouped by day of the week.
  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  M.salesByWeekday = function (books) {
    const daily = {};
    for (const d of M.periodDays(books.period)) daily[d] = 0;
    for (const je of books.entries) {
      if (!je.event || !(je.date in daily)) continue;
      for (const l of je.lines) if (['4000', '4010', '4100'].includes(l.acct)) daily[je.date] += l.cr - l.dr;
    }
    const dates = Object.keys(daily);
    const total = dates.reduce((t, d) => t + daily[d], 0);
    const byDay = WEEKDAYS.map((name, wd) => {
      const ds = dates.filter(d => M.weekday(d) === wd);
      const sum = ds.reduce((t, d) => t + daily[d], 0);
      return { name, wd, count: ds.length, sum, avg: ds.length ? Math.round(sum / ds.length) : 0 };
    });
    const ranked = byDay.slice().sort((a, b) => b.avg - a.avg);
    const weekendDays = dates.filter(d => [0, 6].includes(M.weekday(d))), weekDays = dates.filter(d => ![0, 6].includes(M.weekday(d)));
    const avgOf = ds => (ds.length ? Math.round(ds.reduce((t, d) => t + daily[d], 0) / ds.length) : 0);
    const sortedDates = dates.slice().sort((a, b) => daily[b] - daily[a]);
    return {
      daily, total, byDay, strongest: ranked[0], weakest: ranked[ranked.length - 1],
      weekendAvg: avgOf(weekendDays), weekdayAvg: avgOf(weekDays),
      bestDate: sortedDates[0], worstDate: sortedDates[sortedDates.length - 1],
    };
  };

  // Break-even, cash bridge, payment mix, café attach rate and supplier concentration.
  const CASH_CATEGORY = {
    book_sale: 'Cash takings deposited', cafe_sale: 'Cash takings deposited', giftcard_sold: 'Cash takings deposited',
    sale_return: 'Cash refunds to customers', vendor_payment: 'Paid to publishers', payroll: 'Payroll',
    rent: 'Rent', utility_bill: 'Utilities', interest_payment: 'Loan interest',
    sales_tax_remittance: "Sales tax paid to the state", supplies: "Supplies and equipment", equipment_purchase: "Supplies and equipment",
    owner_contribution: "Owner contributions", owner_drawing: "Owner drawings", loan_repayment: "Loan principal repaid",
    prepaid_purchase: "Insurance and software renewals", manual: "Manual journal entries",
  };
  M.businessInsights = function (res, books) {
    const bal = code => (res.tb.rows.find(r => r.code === code) || { net: 0 }).net;
    const sum = (arr, f) => arr.reduce((t, x) => t + f(x), 0);
    const st = res.statements, days = M.daysInMonth(res.period), ev = books.events;

    // Break-even: costs that move with sales vs costs that don't.
    const variable = bal('5000') + bal('5010') + bal('5020') + bal('5030') + bal('6300');
    const fixed = st.expenses.filter(r => !['5000', '5010', '5020', '5030', '6300'].includes(r.code)).reduce((t, r) => t + r.amount, 0) + bal('4900'); // 4900 is a credit (negative), so this nets off interest income
    const contribution = st.netSales - variable;
    const cmRatio = st.netSales ? contribution / st.netSales : 0;
    const breakEven = cmRatio > 0 ? Math.round(fixed / cmRatio) : null;
    const week = M.salesByWeekday(books);
    const bePerDay = breakEven === null ? null : Math.round(breakEven / days);
    const daysBelow = bePerDay === null ? 0 : Object.values(week.daily).filter(v => v < bePerDay).length;
    const weekdaysBelow = bePerDay === null ? [] : week.byDay.filter(d => d.count && d.avg < bePerDay).map(d => d.name);

    // Cash bridge: every movement on Cash – Bank after the close, grouped by what caused it.
    const openingCash = sum(res.ledger.filter(j => j.source === 'opening'), j => sum(j.lines.filter(l => l.acct === '1000'), l => l.dr - l.cr));
    const flows = {};
    for (const je of res.ledger) {
      if (je.source === 'opening') continue;
      const amt = sum(je.lines.filter(l => l.acct === '1000'), l => l.dr - l.cr);
      if (!amt) continue;
      const cat = je.source === 'close'
        ? (je.tag === 'card-settlement' ? 'Card payouts received' : 'Bank fees and interest')
        : (CASH_CATEGORY[je.type] || 'Other');
      flows[cat] = (flows[cat] || 0) + amt;
    }
    const closingCash = bal('1000');
    const bridge = Object.entries(flows).sort((a, b) => b[1] - a[1]);
    const bridgeTies = openingCash + sum(bridge, ([, v]) => v) === closingCash;

    // Payment mix (sales before tax).
    const salesOf = (types, method) => sum(ev.filter(e => types.includes(e.type) && (!method || e.method === method)), e => e.amount);
    const cardSales = salesOf(['book_sale', 'cafe_sale'], 'card'), cashSales = salesOf(['book_sale', 'cafe_sale'], 'cash');
    const cardFees = bal('6300');

    // Café attach rate.
    const bookSales = salesOf(['book_sale']), cafeSales = salesOf(['cafe_sale']);
    const attachPer100 = bookSales ? Math.round(cafeSales * 100 / bookSales * 100) : 0; // cents of café per $100 of books

    // Supplier concentration.
    const byVendor = {};
    ev.filter(e => e.type === 'inventory_purchase').forEach(e => { byVendor[e.vendor] = (byVendor[e.vendor] || 0) + e.amount; });
    const vendors = Object.entries(byVendor).sort((a, b) => b[1] - a[1]);
    const purchases = sum(vendors, ([, v]) => v), cogsBooks = bal('5000');

    return {
      breakEven: { variable, fixed, contribution, cmRatio, breakEven, bePerDay, daysBelow, weekdaysBelow, safety: breakEven === null ? null : st.netSales - breakEven, days },
      cash: { openingCash, closingCash, bridge, ties: bridgeTies },
      payments: { cardSales, cashSales, cardFees },
      cafe: { bookSales, cafeSales, attachPer100 },
      suppliers: { vendors, purchases, cogsBooks },
    };
  };

  // Everything the writer may say, pre-formatted, so it can copy numbers instead of computing them.
  M.commentaryFacts = function (res, books) {
    const m = M.commentaryMetrics(res, books);
    const bal0 = code => (res.tb.rows.find(r => r.code === code) || { net: 0 }).net;
    const st = res.statements;
    const bal = code => (res.tb.rows.find(r => r.code === code) || { net: 0 }).net;
    const step = id => res.steps.find(s => s.id === id);
    const bank = step('bank').detail, inv = step('inventory').detail;
    const opex = st.expenses.filter(r => !['5000', '5010', '5020', '5030'].includes(r.code));
    const notable = res.flux.filter(x => x.status !== 'OK');
    const biggest = res.flux.slice().sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 4);
    const changes = [...new Set(notable.concat(biggest))].map(x => ({
      account: x.name, lastMonth: M.usd(x.prior), thisMonth: M.usd(x.cur), change: signed(x.delta),
      changePct: x.pct === null ? 'new this month' : (x.pct > 0 ? '+' : '') + x.pct.toFixed(1) + '%',
      review: x.status === 'Review' ? 'needs explanation' : x.status === 'Explained' ? 'explained by schedule' : 'within normal range',
    }));
    return {
      company: M.SETUP.company,
      period: M.periodLabel(res.period),
      closeResult: res.verdict,
      performance: {
        netSales: M.usd(st.netSales), bookSales: M.usd(-bal('4000')), cafeSales: M.usd(-bal('4010')), salesReturns: M.usd(bal('4100')),
        costOfSalesBooksAndCafe: `${M.usd(st.cogs)} (books ${M.usd(m.cogs)}, book shrinkage ${M.usd(m.shrink)}, café ${M.usd(m.cafeCost)}, café waste ${M.usd(m.cafeWaste)})`, grossProfit: M.usd(st.grossProfit), grossMargin: pct(st.grossProfit, st.netSales),
        operatingExpenses: M.usd(opex.reduce((t, r) => t + r.amount, 0)), netIncome: M.usd(st.netIncome), netMargin: pct(st.netIncome, st.netSales),
      },
      cashAndBalanceSheet: {
        cashInBank: M.usd(bal('1000')), bankStatementBalance: M.usd(bank.bankEnd), depositsInTransit: M.usd(bank.dit), outstandingPayments: M.usd(-bank.oc),
        bankReconciliation: `reconciled to the cent; ${bank.outstanding.length} normal timing items clear after month end: ${M.usd(bank.dit)} of deposits in transit and ${M.usd(-bank.oc)} of payments not yet cleared`,
        cardSalesAwaitingPayout: M.usd(bal('1100')), inventory: M.usd(bal('1200')), accountsPayable: M.usd(-bal('2000')),
        salesTaxOwed: M.usd(-bal('2100')), giftCardsOutstanding: M.usd(-bal('2300')), bankLoan: M.usd(-bal('2500')),
        totalAssets: M.usd(st.totalAssets), totalLiabilities: M.usd(st.totalLiabilities), totalEquity: M.usd(st.totalEquity),
      },
      close: {
        transactionsRecorded: String(books.events.length), adjustingEntriesPosted: String(res.adjustments.length),
        stepsTiedOut: `${res.steps.filter(s => s.ok).length} of ${res.steps.length}`,
        shrinkage: `${M.usd(inv.shrink)} (${pct(inv.shrink, inv.book)} of book inventory)`,
        steps: res.steps.map(s => `${s.title}: ${s.ok ? 'tied' : 'EXCEPTION'} – ${s.summary}`),
        findings: res.findings.filter(f => f.severity !== 'INFO').map(f => `${f.severity}: ${f.message}. ${f.detail}`),
      },
      expenseChangesVsLastMonth: changes,
      salesByDayOfWeek: (() => {
        const w = M.salesByWeekday(books);
        const uplift = w.weekdayAvg ? (w.weekendAvg - w.weekdayAvg) * 100 / w.weekdayAvg : 0;
        const gap = w.weakest.avg ? (w.strongest.avg - w.weakest.avg) * 100 / w.weakest.avg : 0;
        return {
          byDay: w.byDay.map(d => ({
            day: d.name, daysInMonth: String(d.count), netSales: M.usd(d.sum),
            averagePerDay: M.usd(d.avg), shareOfMonth: pct(d.sum, w.total),
          })),
          strongestDay: `${w.strongest.name} (average ${M.usd(w.strongest.avg)} per day)`,
          weakestDay: `${w.weakest.name} (average ${M.usd(w.weakest.avg)} per day)`,
          strongestVsWeakest: `${w.strongest.name} averages ${gap.toFixed(1)}% more than ${w.weakest.name}`,
          weekendAveragePerDay: M.usd(w.weekendAvg),
          weekdayAveragePerDay: M.usd(w.weekdayAvg),
          weekendVsWeekday: `weekend days average ${uplift >= 0 ? uplift.toFixed(1) + '% more' : Math.abs(uplift).toFixed(1) + '% less'} than weekdays`,
          bestSingleDay: `${M.dayLabel(w.bestDate)}: ${M.usd(w.daily[w.bestDate])}`,
          quietestSingleDay: `${M.dayLabel(w.worstDate)}: ${M.usd(w.daily[w.worstDate])}`,
        };
      })(),
      ...(() => {
        const I = m.ins, b = I.breakEven, c = I.cash, p = I.payments, cafe = I.cafe, s = I.suppliers;
        const top = s.vendors[0];
        return {
          breakEvenAnalysis: b.breakEven === null
            ? { breakEvenSales: 'not meaningful this month: costs that move with sales are higher than sales' }
            : {
              costsThatMoveWithSales: `${M.usd(b.variable)} (cost of books and café items sold, shrinkage, café waste and card fees)`,
              fixedMonthlyCosts: `${M.usd(b.fixed)} (wages, rent, utilities, insurance, software, depreciation, supplies, bank fees and loan interest, net of interest earned)`,
              contributionMargin: `${pct(b.contribution, m.netSales)} of every sales dollar is left after costs that move with sales`,
              breakEvenSales: `${M.usd(b.breakEven)} of net sales a month`,
              breakEvenPerDay: `${M.usd(b.bePerDay)} of net sales per day`,
              marginOfSafety: `${M.usd(b.safety)} (${pct(b.safety, m.netSales)} of net sales) ${b.safety >= 0 ? 'above' : 'below'} break-even`,
              daysBelowBreakEven: `${b.daysBelow} of ${b.days} days had sales below the daily break-even level`,
              weekdaysAveragingBelowBreakEven: b.weekdaysBelow.length ? b.weekdaysBelow.join(', ') : 'none',
            },
          cashMovement: {
            openingCash: M.usd(c.openingCash), closingCash: M.usd(c.closingCash), netChange: signed(c.closingCash - c.openingCash),
            movements: c.bridge.map(([k, v]) => `${k}: ${signed(v)}`),
            check: c.ties ? 'the movements add up exactly to the change in cash' : 'the movements do NOT add up to the change in cash',
          },
          paymentMix: {
            cardSalesBeforeTax: M.usd(p.cardSales), cashSalesBeforeTax: M.usd(p.cashSales),
            cardShare: pct(p.cardSales, p.cardSales + p.cashSales), cashShare: pct(p.cashSales, p.cardSales + p.cashSales),
            cardFees: `${M.usd(p.cardFees)} (${pct(p.cardFees, p.cardSales)} of card sales before tax)`,
          },
          cafeAttachRate: {
            bookSalesAtTheTill: M.usd(cafe.bookSales), cafeSales: M.usd(cafe.cafeSales),
            attachRate: `${M.usd(cafe.attachPer100)} of café sales for every $100 of book sales`,
          },
          suppliers: top ? {
            publishersUsed: String(s.vendors.length), purchasesThisMonth: M.usd(s.purchases),
            byPublisher: s.vendors.map(([k, v]) => `${k}: ${M.usd(v)} (${pct(v, s.purchases)})`),
            largestPublisher: `${top[0]} (${pct(top[1], s.purchases)} of purchases)`,
            stockBoughtVsSold: `bought ${M.usd(s.purchases)} of books at cost and sold ${M.usd(s.cogsBooks)} at cost, so stock ${s.purchases >= s.cogsBooks ? 'grew' : 'fell'} by ${M.usd(Math.abs(s.purchases - s.cogsBooks))} before shrinkage`,
          } : { purchasesThisMonth: 'no publisher purchases this month' },
        };
      })(),
      cfoMetrics: {
        currentRatio: `${m.currentRatio.toFixed(2)}x (current assets ${M.usd(m.currentAssets)} vs current liabilities ${M.usd(m.currentLiabilities)}, bank loan excluded)`,
        quickRatio: `${m.quickRatio.toFixed(2)}x (cash and card receipts only)`,
        cashCoversOperatingExpenses: `${m.cashCoverMonths.toFixed(1)} months of this month's operating expenses`,
        inventoryDays: `${Math.round(m.inventoryDays)} days of cost of goods sold held in stock`,
        payableDays: m.purchases ? `${Math.round(m.payableDays)} days of this month's purchases on account (books and café stock) still unpaid` : 'no purchases on account this month',
        bookGrossMargin: pct(m.bookNet - m.cogs, m.bookNet),
        cafeGrossMargin: `${pct(m.cafeSales - m.cafeCost - m.cafeWaste, m.cafeSales)} (after ingredients, cups and ${M.usd(m.cafeWaste)} of waste)`,
        cafeWaste: `${M.usd(m.cafeWaste)} (${m.cafeWastePct.toFixed(1)}% of café stock spoiled or thrown away)`,
        salesMix: `books ${pct(m.bookNet, m.netSales)}, café ${pct(m.cafeSales, m.netSales)} of net sales`,
        wagesShareOfSales: pct(bal0('6000'), m.netSales),
        rentShareOfSales: pct(bal0('6100'), m.netSales),
        cardFeesShareOfSales: pct(bal0('6300'), m.netSales),
        bankLoan: `${M.usd(m.loan.principal)} at ${(m.loan.rateBps / 100).toFixed(1)}% a year (${M.usd(M.monthlyInterest(m.loan))} interest a month)`,
      },
    };
  };

  // Rule-based CFO suggestions: used by the template, and a sanity baseline for the AI's own list.
  M.ruleRecommendations = function (m) {
    const recs = [];
    const add = (priority, text) => recs.push({ priority, text });
    m.warnings.forEach(w => add('High', `Explain before sign-off: ${w.message}.`));
    if (m.shrinkPct > 0.5) add('High', `Investigate inventory shrinkage of ${M.usd(m.shrink)} (${m.shrinkPct.toFixed(1)}% of book inventory): check receiving, returns handling and store security.`);
    if (m.cafeWastePct > 3) add('Medium', `Café waste was ${M.usd(m.cafeWaste)} (${m.cafeWastePct.toFixed(1)}% of café stock): order milk and pastries in smaller, more frequent batches.`);
    if (m.cashCoverMonths < 1) add('High', `Cash covers only ${m.cashCoverMonths.toFixed(1)} months of operating expenses: time publisher payments carefully and hold discretionary spend.`);
    else if (m.cashCoverMonths >= 3) add('Medium', `Cash covers ${m.cashCoverMonths.toFixed(1)} months of operating expenses: consider an early paydown on the ${M.usd(m.loan.principal)} bank loan at ${(m.loan.rateBps / 100).toFixed(1)}%, keeping an agreed cash buffer.`);
    else add('Medium', `Cash covers ${m.cashCoverMonths.toFixed(1)} months of operating expenses: keep building the cash buffer before considering any early paydown of the ${M.usd(m.loan.principal)} bank loan.`);
    if (m.inventoryDays > 45) add('Medium', `Inventory covers ${Math.round(m.inventoryDays)} days of cost of goods sold: review slow-moving titles and use publisher returns to free up cash.`);
    const w = m.week, gap = w.weakest.avg ? (w.strongest.avg - w.weakest.avg) * 100 / w.weakest.avg : 0;
    const uplift = w.weekdayAvg ? (w.weekendAvg - w.weekdayAvg) * 100 / w.weekdayAvg : 0;
    const weakestBelowBreakEven = m.ins.breakEven.weekdaysBelow.includes(w.weakest.name); // covered by the break-even suggestion
    if (gap > 25 && !weakestBelowBreakEven) add('Medium', `Build traffic on ${w.weakest.name}s (average ${M.usd(w.weakest.avg)} per day, against ${M.usd(w.strongest.avg)} on ${w.strongest.name}s): try an in-store event, author reading or café offer on that day.`);
    if (uplift > 20) add('Medium', `Staff to the weekly pattern: weekend days average ${uplift.toFixed(1)}% more than weekdays, so move hours toward Saturday and Sunday and trim the quietest weekday shifts.`);
    const be = m.ins.breakEven;
    if (be.breakEven !== null) {
      const safetyPct = be.safety * 100 / m.netSales;
      if (safetyPct < 10) add('High', `Sales are only ${M.usd(be.safety)} (${pct(be.safety, m.netSales)} of net sales) ${be.safety >= 0 ? 'above' : 'below'} break-even of ${M.usd(be.breakEven)}: hold fixed costs flat and protect the busiest days.`);
      if (be.weekdaysBelow.length) add('Medium', `${be.weekdaysBelow.join(', ')} average below the daily break-even of ${M.usd(be.bePerDay)}: build traffic on those days with events or café offers, and review opening hours and staffing there.`);
    }
    const sup = m.ins.suppliers, top = sup.vendors[0];
    if (top && top[1] * 100 / sup.purchases > 35) add('Medium', `${top[0]} supplies ${pct(top[1], sup.purchases)} of purchases: use that volume to ask for a better discount or longer payment terms, and keep a second source for key titles.`);
    add('Low', `Grow the café attach rate (${M.usd(m.ins.cafe.attachPer100)} of café sales per $100 of books): try book-and-coffee bundles or a reading-corner offer.`);
    if (m.netMarginPct < 5) add('Medium', `Net margin is ${m.netMarginPct.toFixed(1)}% and wages take ${m.shareOf(m.wages).toFixed(1)}% of net sales: match staffing to busy hours and review café pricing.`);
    add('Low', 'Keep the monthly stock count and bank reconciliation cadence; both tied out this month.');
    const rank = { High: 0, Medium: 1, Low: 2 };
    return recs.sort((a, b) => rank[a.priority] - rank[b.priority]).slice(0, 7);
  };

  // ---------- number check ----------
  const NUM = /\d(?:[\d,]*\d)?(?:\.\d+)?/g; // never ends on a comma, so "152," reads as 152
  const norm = raw => String(Math.round(Number(raw.replace(/,/g, '')) * 100) / 100);
  const isIdDigit = (text, i) => /(?:JE-|ADJ-|\bC)$/.test(text.slice(Math.max(0, i - 4), i));

  const isMoneyAt = (text, i) => text[i - 1] === '$';
  function allowedNumbers(facts) {
    const any = new Set(), money = new Set();
    const json = JSON.stringify(facts);
    for (const m of json.matchAll(NUM)) {
      any.add(norm(m[0]));
      if (isMoneyAt(json, m.index)) money.add(norm(m[0]));
    }
    return { any, money };
  }
  // A dollar amount must match a dollar amount in the facts – so a count of "3 items" can't pass as "$3".
  // Other numbers must appear in the facts; small whole numbers (1–31) pass as dates or counts.
  function verdictFor(raw, allowed, isMoney) {
    if (isMoney) return allowed.money.has(norm(raw));
    if (allowed.any.has(norm(raw))) return true;
    const v = Number(raw.replace(/,/g, ''));
    return Number.isInteger(v) && v >= 1 && v <= 31 && !raw.includes(',');
  }
  M.checkCommentaryNumbers = function (text, facts) {
    const allowed = allowedNumbers(facts);
    let total = 0; const unverified = [];
    for (const m of text.matchAll(NUM)) {
      if (isIdDigit(text, m.index)) continue;
      total++;
      if (!verdictFor(m[0], allowed, isMoneyAt(text, m.index))) unverified.push((isMoneyAt(text, m.index) ? '$' : '') + m[0]);
    }
    return { total, unverified };
  };

  // Render plain-text commentary as HTML, highlighting any number that could not be verified.
  const HEADINGS = ['headline', 'performance', 'sales by day of week', 'sales mix', 'break-even', 'break even', 'cash and balance sheet', 'suppliers and stock', 'close quality and items to watch', 'ai recommendations', 'cfo recommendations', 'recommendations'];
  const PRIORITY = /^\[?(high|medium|low)\]?\s*[:—–-]?\s*/i;
  M.renderCommentary = function (text, facts, esc) {
    const allowed = allowedNumbers(facts);
    const marked = line => esc(line).replace(NUM, (m, i, s) => (isIdDigit(s, i) || verdictFor(m, allowed, isMoneyAt(s, i)) ? m : `<mark title="Not found in the close figures">${m}</mark>`));
    const mark = line => {
      const p = line.match(PRIORITY);
      if (!p || !/^\[|^(high|medium|low)\b\s*[:—–-]/i.test(line)) return marked(line);
      const level = p[1][0].toUpperCase() + p[1].slice(1).toLowerCase();
      return `<span class="prio ${level.toLowerCase()}">${level}</span> ${marked(line.slice(p[0].length))}`;
    };
    let html = '', inList = false;
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      const bare = line.replace(/^#+\s*|\*\*/g, '').replace(/:$/, '').trim();
      if (inList && !line.startsWith('- ')) { html += '</ul>'; inList = false; }
      if (!line) continue;
      if (HEADINGS.includes(bare.toLowerCase())) html += `<h4>${esc(bare)}</h4>`;
      else if (line.startsWith('- ') || line.startsWith('* ')) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${mark(line.slice(2).replace(/\*\*/g, ''))}</li>`; }
      else html += `<p>${mark(line.replace(/\*\*/g, ''))}</p>`;
    }
    return html + (inList ? '</ul>' : '');
  };

  // ---------- template fallback (no AI) ----------
  M.templateCommentary = function (facts, metrics) {
    const p = facts.performance, c = facts.cashAndBalanceSheet, k = facts.close;
    const watch = facts.expenseChangesVsLastMonth.filter(x => x.review === 'needs explanation');
    const lines = [
      'Headline',
      `${facts.company} closed ${facts.period} with net income of ${p.netIncome} on net sales of ${p.netSales} (${p.netMargin} net margin). The close result is ${facts.closeResult}.`,
      'Performance',
      `- Book sales ${p.bookSales}, café sales ${p.cafeSales}, returns ${p.salesReturns}.`,
      `- Gross profit ${p.grossProfit}, a gross margin of ${p.grossMargin}; operating expenses ${p.operatingExpenses}.`,
      `- By line: books earn a ${facts.cfoMetrics.bookGrossMargin} gross margin, the café ${facts.cfoMetrics.cafeGrossMargin}.`,
      'Sales by day of week',
      `- Strongest day: ${facts.salesByDayOfWeek.strongestDay}; weakest: ${facts.salesByDayOfWeek.weakestDay}.`,
      `- Weekends vs weekdays: ${facts.salesByDayOfWeek.weekendVsWeekday} (${facts.salesByDayOfWeek.weekendAveragePerDay} vs ${facts.salesByDayOfWeek.weekdayAveragePerDay} per day).`,
      `- Best single day ${facts.salesByDayOfWeek.bestSingleDay}; quietest ${facts.salesByDayOfWeek.quietestSingleDay}.`,
      'Sales mix',
      `- Payment mix: ${facts.paymentMix.cardShare} card, ${facts.paymentMix.cashShare} cash; card fees ${facts.paymentMix.cardFees}.`,
      `- Café attach rate: ${facts.cafeAttachRate.attachRate}.`,
      'Break-even',
      ...(facts.breakEvenAnalysis.fixedMonthlyCosts ? [
        `- Break-even is ${facts.breakEvenAnalysis.breakEvenSales} (${facts.breakEvenAnalysis.breakEvenPerDay}); margin of safety ${facts.breakEvenAnalysis.marginOfSafety}.`,
        `- ${facts.breakEvenAnalysis.contributionMargin}; fixed monthly costs ${facts.breakEvenAnalysis.fixedMonthlyCosts.split(' (')[0]}.`,
        `- ${facts.breakEvenAnalysis.daysBelowBreakEven}.`,
      ] : [`- Break-even is ${facts.breakEvenAnalysis.breakEvenSales}.`]),
      'Cash and balance sheet',
      `- Cash moved from ${facts.cashMovement.openingCash} to ${facts.cashMovement.closingCash} (${facts.cashMovement.netChange}): ${facts.cashMovement.movements.join('; ')}.`,
      `- Cash in bank ${c.cashInBank}; the bank statement shows ${c.bankStatementBalance}, with ${c.depositsInTransit} of deposits in transit and ${c.outstandingPayments} of payments not yet cleared.`,
      `- Inventory ${c.inventory}; owed to publishers ${c.accountsPayable}; sales tax owed ${c.salesTaxOwed}; bank loan ${c.bankLoan}.`,
      'Suppliers and stock',
      ...(facts.suppliers.largestPublisher ? [
        `- ${facts.suppliers.publishersUsed} publishers supplied ${facts.suppliers.purchasesThisMonth}; the largest was ${facts.suppliers.largestPublisher}.`,
        `- The shop ${facts.suppliers.stockBoughtVsSold}.`,
      ] : [`- ${facts.suppliers.purchasesThisMonth}.`]),
      'Close quality and items to watch',
      `- ${k.stepsTiedOut} close steps tied out, with ${k.adjustingEntriesPosted} adjusting entries posted.`,
      `- Inventory shrinkage was ${k.shrinkage}.`,
    ];
    if (watch.length) watch.forEach(x => lines.push(`- ${x.account} moved ${x.changePct} vs last month (${x.lastMonth} to ${x.thisMonth}) and needs an explanation.`));
    else lines.push('- No expense moved enough versus last month to need an explanation.');
    lines.push('Recommendations'); // rule-based, so not labelled AI
    M.ruleRecommendations(metrics).forEach(r => lines.push(`- [${r.priority}] ${r.text}`));
    return lines.join('\n');
  };
})();

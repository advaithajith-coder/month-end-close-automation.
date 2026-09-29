'use strict';
// Core helpers: money (integer cents), dates, seeded RNG, fingerprint, chart of accounts, store setup, schedules.
(function () {
  const M = (window.MEC = window.MEC || {});

  // ---------- money: always integer cents ----------
  M.fmt = function (c) {
    if (c === null || c === undefined || Number.isNaN(c)) return '—';
    const a = Math.abs(c);
    const s = Math.floor(a / 100).toLocaleString('en-US') + '.' + String(a % 100).padStart(2, '0');
    return c < 0 ? '(' + s + ')' : s;
  };
  M.usd = c => (c < 0 ? '-$' : '$') + M.fmt(Math.abs(c));
  M.parseCents = function (text) {
    const t = String(text).replace(/[$,\s]/g, '');
    if (!/^-?\d+(\.\d{0,2})?$/.test(t)) return NaN;
    const neg = t.startsWith('-');
    const [w, f = ''] = t.replace('-', '').split('.');
    const v = Number(w) * 100 + Number((f + '00').slice(0, 2));
    return neg ? -v : v;
  };
  // cents × basis points, rounded half away from zero, integer-exact
  M.pct = function (cents, bps) {
    const r = Math.floor((Math.abs(cents) * bps + 5000) / 10000);
    return cents < 0 ? -r : r;
  };
  M.dr = (acct, amount) => ({ acct, dr: amount, cr: 0 });
  M.cr = (acct, amount) => ({ acct, dr: 0, cr: amount });
  M.line = (acct, signed) => (signed >= 0 ? M.dr(acct, signed) : M.cr(acct, -signed));

  // ---------- dates (ISO strings, UTC) ----------
  const pad = n => String(n).padStart(2, '0');
  M.parsePeriod = p => { const [y, m] = p.split('-').map(Number); return { y, m }; };
  M.daysInMonth = p => { const { y, m } = M.parsePeriod(p); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };
  M.periodStart = p => p + '-01';
  M.periodEnd = p => p + '-' + pad(M.daysInMonth(p));
  M.periodDays = p => Array.from({ length: M.daysInMonth(p) }, (_, i) => p + '-' + pad(i + 1));
  M.addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  M.dayDiff = (from, to) => Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000);
  M.weekday = iso => new Date(iso + 'T00:00:00Z').getUTCDay();
  M.monthIndex = p => { const { y, m } = M.parsePeriod(p); return y * 12 + (m - 1); };
  M.shiftPeriod = (p, n) => { const i = M.monthIndex(p) + n; return Math.floor(i / 12) + '-' + pad((i % 12) + 1); };
  M.periodLabel = p => new Date(p + '-01T00:00:00Z').toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  M.shortDate = iso => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  M.dayLabel = iso => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

  // ---------- seeded RNG (mulberry32) + fingerprints ----------
  M.rng = function (seed) {
    let a = seed >>> 0;
    const next = () => {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return {
      next,
      int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
      chance: p => next() < p,
      pick: arr => arr[Math.floor(next() * arr.length)],
    };
  };
  M.hash32 = function (str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return h >>> 0;
  };
  // 64-bit fingerprint (two independent FNV-style lanes) used to seal a closed period
  M.fingerprint = function (str) {
    let h1 = 0x811c9dc5, h2 = 0x9e3779b9;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      h1 ^= c; h1 = Math.imul(h1, 0x01000193);
      h2 ^= c; h2 = Math.imul(h2, 0x5bd1e995); h2 ^= h2 >>> 13;
    }
    return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
  };

  // ---------- chart of accounts ----------
  // type: A asset, L liability, E equity, R revenue, X expense
  M.ACCOUNTS = [
    ['1000', 'Cash – Bank', 'A'], ['1100', 'Card Clearing', 'A'], ['1200', 'Inventory', 'A'], ['1210', 'Café Stock', 'A'],
    ['1300', 'Prepaid Insurance', 'A'], ['1310', 'Prepaid Software', 'A'],
    ['1500', 'Store Fixtures & Equipment', 'A'], ['1510', 'Accumulated Depreciation', 'A'],
    ['2000', 'Accounts Payable', 'L'], ['2100', 'Sales Tax Payable', 'L'], ['2200', 'Accrued Wages', 'L'],
    ['2210', 'Accrued Utilities', 'L'], ['2220', 'Accrued Interest', 'L'], ['2300', 'Gift Card Liability', 'L'],
    ['2500', 'Bank Loan', 'L'],
    ['3000', "Owner's Capital", 'E'], ['3100', 'Retained Earnings', 'E'], ['3200', "Owner's Drawings", 'E'],
    ['4000', 'Book Sales', 'R'], ['4010', 'Café Sales', 'R'], ['4100', 'Sales Returns', 'R'], ['4900', 'Interest Income', 'R'],
    ['5000', 'Cost of Goods Sold', 'X'], ['5010', 'Inventory Shrinkage', 'X'], ['5020', 'Café Cost of Sales', 'X'], ['5030', 'Café Waste', 'X'],
    ['6000', 'Wages', 'X'], ['6100', 'Rent', 'X'], ['6200', 'Utilities', 'X'], ['6300', 'Card Processing Fees', 'X'],
    ['6400', 'Insurance', 'X'], ['6410', 'Software', 'X'], ['6500', 'Depreciation', 'X'], ['6600', 'Bank Fees', 'X'],
    ['6700', 'Supplies', 'X'], ['7000', 'Interest Expense', 'X'],
  ].map(([code, name, type]) => ({ code, name, type }));
  const byCode = Object.fromEntries(M.ACCOUNTS.map(a => [a.code, a]));
  M.acct = code => byCode[code] || { code, name: 'Unknown ' + code, type: '?' };

  // ---------- the fictional store ----------
  M.SETUP = {
    company: 'Quincy Bookstore',
    taxBps: 800,          // 8% sales tax
    cardFeeBps: 250,      // 2.5% card processing fee
    costBps: 6000,        // books cost 60% of the shelf price
    cafeCostBps: 3000,    // café ingredients and cups cost 30% of the menu price
    cafeVendor: 'Riverside Coffee Co.',
    dailyWage: 43000,     // $430 of staff wages earned per day
    rent: 400000,
    utilityEstimate: 85000,
    bankFee: 1500,
    bankInterestBps: 1,
    loan: { principal: 5000000, rateBps: 600 },
    vendors: ['Northwind Publishing', 'Bluebird Press', 'Harbor Books Distribution', 'Lantern House'],
    prepaids: [
      { id: 'ins', name: 'Store insurance policy', asset: '1300', expense: '6400', total: 720000, start: '2026-01', months: 12 },
      { id: 'sw', name: 'POS & inventory software (annual)', asset: '1310', expense: '6410', total: 180000, start: '2025-10', months: 12 },
    ],
    // depreciation starts the month after the asset is placed in service
    assets: [
      { id: 'shelves', name: 'Bookshelves & store fixtures', cost: 3600000, inService: '2023-04', life: 84 },
      { id: 'pos', name: 'POS terminals', cost: 480000, inService: '2023-02', life: 36 },
      { id: 'espresso', name: 'Café espresso machine', cost: 900000, inService: '2025-06', life: 60 },
      { id: 'register', name: 'Old cash register', cost: 120000, inService: '2021-12', life: 36 }, // fully depreciated since Dec 2024
    ],
    opening: { cash: 2800000, inventory: 4200000, cafeStock: 120000, ap: 1240000, salesTax: 396000, giftCards: 120000, ownerCapital: 3000000, cardClearing: [118000, 131500] },
    // last month's actuals for the fluctuation review (schedule-driven lines are derived per period)
    baselineFixed: { '5000': 2400000, '5010': 20000, '5020': 250000, '5030': 3500, '6000': 1290000, '6100': 400000, '6200': 86000, '6300': 92000, '6600': 1500, '6700': 56000, '7000': 25000 },
  };
  // Financial year = calendar 2026. January opens from the setup balances; every later month
  // opens from the previous month's close.
  M.YEAR = 2026;
  M.PERIODS = Array.from({ length: 12 }, (_, i) => M.shiftPeriod('2026-01', i));

  // ---------- schedules (primary implementation; the shadow recompute lives in close.js) ----------
  M.prepaidAmort = function (pp, p) {
    const i = M.monthIndex(p) - M.monthIndex(pp.start);
    if (i < 0 || i >= pp.months) return 0;
    const base = Math.floor(pp.total / pp.months);
    return i === pp.months - 1 ? pp.total - base * (pp.months - 1) : base;
  };
  M.prepaidAmortThrough = function (pp, p) {
    const i = M.monthIndex(p) - M.monthIndex(pp.start);
    if (i < 0) return 0;
    if (i >= pp.months - 1) return pp.total;
    return Math.floor(pp.total / pp.months) * (i + 1);
  };
  M.depreciation = function (a, p) {
    const i = M.monthIndex(p) - (M.monthIndex(a.inService) + 1);
    if (i < 0 || i >= a.life) return 0;
    const base = Math.floor(a.cost / a.life);
    return i === a.life - 1 ? a.cost - base * (a.life - 1) : base;
  };
  M.depreciationThrough = function (a, p) {
    const i = M.monthIndex(p) - (M.monthIndex(a.inService) + 1);
    if (i < 0) return 0;
    if (i >= a.life - 1) return a.cost;
    return Math.floor(a.cost / a.life) * (i + 1);
  };
  M.monthlyInterest = loan => Math.floor((loan.principal * loan.rateBps + 60000) / 120000);
  // Interest for a month on whatever the loan balance actually is (it falls as principal is repaid).
  M.loanInterest = balance => M.monthlyInterest({ principal: Math.max(0, balance), rateBps: M.SETUP.loan.rateBps });

  // Control accounts: kept right by their own transactions and the close, so a manual journal entry
  // may not touch them (the close would flag the difference anyway). Retained earnings moves only at close.
  M.CONTROL_ACCOUNTS = ['1100', '1300', '1310', '1510', '2100', '2200', '2210', '2220', '2300', '3100'];

  M.baseline = function (p) {
    const s = M.SETUP, prev = M.shiftPeriod(p, -1);
    const b = Object.assign({}, s.baselineFixed);
    for (const pp of s.prepaids) b[pp.expense] = (b[pp.expense] || 0) + M.prepaidAmort(pp, prev);
    b['6500'] = s.assets.reduce((t, a) => t + M.depreciation(a, prev), 0);
    return b;
  };
})();

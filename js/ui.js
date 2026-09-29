'use strict';
// Dashboard: input (generate or pick transactions), journal, month-end close, statements, controls.
(function () {
  const M = window.MEC;
  const KEY = 'mec-bookstore-v3'; // v3: café stock & café cost of sales
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = c => `<span class="num${c < 0 ? ' neg' : ''}">${M.fmt(c)}</span>`; // negatives in red ink, as in a ledger
  const sum = (arr, f) => arr.reduce((t, x) => t + f(x), 0);

  // The workbook holds one record per month of the financial year; `state` is the month on screen.
  const fresh = period => ({ period, seed: 2026, mode: null, events: [], shrinkBps: 50, countOverride: null, lock: null, nextId: 1 });
  let wb = (() => {
    try {
      const w = JSON.parse(localStorage.getItem(KEY));
      if (w && w.months && M.PERIODS.includes(w.current)) return w;
    } catch (e) { /* fall through */ }
    return { current: M.PERIODS[0], months: {} };
  })();
  const monthState = p => wb.months[p] || (wb.months[p] = fresh(p));
  let state = monthState(wb.current);
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(wb)); } catch (e) { /* storage unavailable – keep working in memory */ } };

  const ui = { tab: 'overview', fsView: 'month', type: 'book_sale', date: null, filter: '', source: '', open: new Set(), editing: null, lastRun: null, demo: null, flash: null, confirm: null };
  let books = null, result = null, error = null, blockedBy = null, priorSnap = null;
  const locked = () => !!state.lock;
  const prevPeriod = p => { const i = M.PERIODS.indexOf(p); return i > 0 ? M.PERIODS[i - 1] : null; };
  const nextPeriod = p => { const i = M.PERIODS.indexOf(p); return i >= 0 && i < M.PERIODS.length - 1 ? M.PERIODS[i + 1] : null; };

  // Closed months are rebuilt in order so each opens from the previous close; results are cached per input.
  const cache = new Map();
  function closedMonth(p, prior, priorKey) {
    const ms = wb.months[p];
    const { commentary, ...inputs } = ms;
    const key = M.fingerprint(JSON.stringify(inputs) + '|' + priorKey);
    const hit = cache.get(p);
    if (hit && hit.key === key) return hit;
    const out = M.closeMonth(ms, prior, { lock: ms.lock });
    const entry = { key, ...out };
    cache.set(p, entry);
    return entry;
  }
  // The closed months from January up to (not including) `upto`, or the whole closed run when upto is null.
  function closedRun(upto) {
    const run = []; let prior = null, key = 'start';
    for (const p of M.PERIODS) {
      if (p === upto) break;
      const ms = wb.months[p];
      if (!ms || !ms.lock) return { run, prior, blockedBy: upto ? p : null };
      const out = closedMonth(p, prior, key);
      if (!out.snapshot) return { run, prior, blockedBy: upto ? p : null };
      run.push({ period: p, books: out.books, result: out.result });
      prior = out.snapshot; key = out.key;
    }
    return { run, prior, blockedBy: null };
  }
  function monthStatus(p) {
    const ms = wb.months[p];
    if (ms && ms.lock) return 'Closed';
    if (ms && ms.mode) return 'Open';
    return 'Not started';
  }

  function recompute() {
    error = null;
    try {
      const chain = closedRun(state.period);
      blockedBy = chain.blockedBy; priorSnap = chain.prior;
      if (blockedBy) { books = null; result = null; return; }
      const pl = state.planted; // guardrail demo: mistakes planted into this month
      books = M.buildBooks({ ...state, prior: priorSnap }, pl ? pl.build : {});
      result = state.lock ? M.runClose(books, { lock: state.lock })
        : pl ? M.runClose(books, { faults: pl.close, lock: pl.seal }) // always shown, so the flags are visible on every tab
        : ui.lastRun;
    } catch (e) { error = e; books = null; result = null; console.error(e); }
  }
  function goToMonth(p) {
    wb.current = p; state = monthState(p);
    ui.lastRun = null; ui.demo = null; ui.commentaryError = null; ui.editing = null; ui.date = null;
    save();
  }
  function changed(msg) { ui.lastRun = null; ui.demo = null; ui.flash = msg || null; save(); render(); }

  const SOURCE = { opening: ['Opening', 'muted'], system: ['Auto', 'muted'], generated: ['Generated', 'info'], user: ['You', 'accent'], close: ['Month-end', 'ok'] };
  const chip = (text, kind) => `<span class="chip ${kind}">${esc(text)}</span>`;
  const sevChip = sev => chip(sev, sev === 'CRITICAL' ? 'bad' : sev === 'WARN' ? 'warn' : 'muted');
  const sentence = s => s.charAt(0) + s.slice(1).toLowerCase(); // "CLOSED CLEAN" -> "Closed clean"
  const verdictKind = v => (v === 'BLOCKED' ? 'bad' : v === 'CLOSED CLEAN' ? 'ok' : 'warn');

  // ---------- header + tabs ----------
  const TABS = [['overview', 'Overview'], ['txns', 'Transactions'], ['close', 'Month-end close'], ['fs', 'Financial statements'], ['controls', 'Controls and guardrails']];
  // The page head names the month being worked on, like the heading ruled across a ledger page.
  function header() {
    const [name, yearNo] = M.periodLabel(state.period).split(' ');
    const status = locked()
      ? `<span class="status closed">Closed and locked</span>`
      : result ? `<span class="status ${verdictKind(result.verdict)}">${esc(sentence(result.verdict))}</span>`
      : state.mode ? `<span class="status open">Open</span>` : `<span class="status empty">Not started</span>`;
    const section = (TABS.find(([id]) => id === ui.tab) || TABS[0])[1];
    return `
      <p class="page-kicker">${esc(section)}</p>
      <h1 class="page-title">${name} <span class="page-year">${yearNo}</span></h1>
      ${status}`;
  }
  function nav() {
    return TABS.map(([id, label]) => `<button class="section ${ui.tab === id ? 'active' : ''}" data-act="tab" data-tab="${id}" ${ui.tab === id ? 'aria-current="page"' : ''}>${label}</button>`).join('');
  }

  function render() {
    recompute();
    document.getElementById('hdr').innerHTML = header();
    document.getElementById('nav').innerHTML = nav();
    document.getElementById('months').innerHTML = thumbIndex();
    if (window.matchMedia('(max-width: 900px)').matches) { // on phones the month tabs are a row: keep the current one in view
      const cur = document.querySelector('.tab-month.current');
      if (cur) cur.parentElement.scrollLeft = cur.offsetLeft - cur.parentElement.clientWidth / 2 + cur.clientWidth / 2;
    }
    let body = '';
    if (ui.flash) body += `<div class="banner info">${esc(ui.flash)}</div>`;
    if (state.planted) body += `<div class="banner bad planted-banner"><span><b>Nine mistakes are planted in ${M.periodLabel(state.period)}'s books.</b> The controls are flagging them, so this month cannot be closed until they are removed.</span>
      <span class="spacer"></span>${ui.tab === 'controls' ? '' : '<button class="btn" data-act="tab" data-tab="controls">See what was flagged</button>'}<button class="btn" data-act="plant-remove">Remove the mistakes</button></div>`;
    if (error) body += `<div class="banner bad">Something went wrong: ${esc(error.message)}</div>`;
    else if (blockedBy && !(ui.tab === 'fs' && ui.fsView === 'year') && ui.tab !== 'controls') body += blockedView();
    else body += ({ overview: viewOverview, txns: viewTxns, close: viewClose, fs: viewStatements, controls: viewControls })[ui.tab]();
    document.getElementById('app').innerHTML = body;
    ui.flash = null;
    if (ui.tab === 'txns') updatePreview();
  }

  // ---------- thumb index + blocked month ----------
  // One tab per month, cut into the page edge like a ledger's thumb index. Closed months are inked;
  // the month on screen is pulled out.
  function thumbIndex() {
    const closedCount = M.PERIODS.filter(p => monthStatus(p) === 'Closed').length;
    const tabs = M.PERIODS.map(p => {
      const s = monthStatus(p), kind = s === 'Closed' ? 'closed' : s === 'Open' ? 'open' : 'empty';
      const short = M.periodLabel(p).slice(0, 3);
      return `<button class="tab-month ${kind} ${p === state.period ? 'current' : ''}" data-act="goto" data-period="${p}"
        aria-label="${M.periodLabel(p)}: ${s.toLowerCase()}" ${p === state.period ? 'aria-current="true"' : ''}>${short}</button>`;
    }).join('');
    return `<p class="thumb-year">FY ${M.YEAR}</p>${tabs}<p class="thumb-count">${closedCount} of 12 closed</p>`;
  }
  function blockedView() {
    return `<div class="card"><h3>${M.periodLabel(state.period)} can't start yet</h3>
      <p>Each month opens with the previous month's closing balances, so <b>${M.periodLabel(blockedBy)}</b> has to be closed first.
      That's how real books work: the next month can't begin from numbers that may still change.</p>
      <div class="row"><button class="btn primary" data-act="goto" data-period="${blockedBy}">Go to ${M.periodLabel(blockedBy)}</button></div></div>`;
  }

  // ---------- overview ----------
  function welcome() {
    return `
      <section class="hero">
        <h2>Record a month of bookstore activity, then close the books automatically.</h2>
        <p class="lede">Choose how to fill ${M.periodLabel(state.period)}. You can mix the two: generate a month, then add or edit your own transactions.
          ${prevPeriod(state.period) ? `It opens with ${M.periodLabel(prevPeriod(state.period))}'s closing balances.` : `It is the first month of FY ${M.YEAR} and opens from the store's starting balances.`}</p>
      </section>
      <div class="grid two">
        <div class="card choice">
          <h3>Generate a month automatically</h3>
          <p>A realistic month of daily sales, returns, gift cards, publisher invoices, payroll, rent and bills (roughly 145–160 transactions, depending on the month and seed). The same seed always gives the same month.</p>
          <div class="row"><label>Seed <input id="seed" class="input small" type="number" value="${state.seed || 2026}"></label>
          <button class="btn primary" data-act="generate">Generate ${M.periodLabel(state.period)}</button></div>
        </div>
        <div class="card choice">
          <h3>Enter transactions yourself</h3>
          <p>Pick a day, choose a common transaction (book sales, publisher invoice, payroll, rent…) and type your own amount. Start empty, or use the quick-add buttons for the usual monthly bills.</p>
          <div class="row"><button class="btn primary" data-act="manual">Start with an empty month</button></div>
        </div>
      </div>
      <div class="card choice year-card">
        <div><h3>Generate &amp; close the full year</h3>
          <p>Builds all 12 months of FY ${M.YEAR} in order: each month is generated, closed through all nine steps and eight controls, locked, and its closing balances carried into the next. Then see the yearly statements.</p></div>
        <div class="row">${ui.confirm === 'year'
          ? `<button class="btn danger" data-act="generate-year">Click again: replace all 12 months</button>`
          : `<button class="btn primary" data-act="generate-year">Generate &amp; close FY ${M.YEAR}</button>`}</div>
      </div>
      ${howItWorks()}`;
  }
  function howItWorks() {
    const steps = [
      ['1', 'Record', 'Transactions become balanced journal entries (debits = credits).'],
      ['2', 'Receive', 'Bank statement, card processor report and stock count arrive at month end.'],
      ['3', 'Close', 'Nine automated steps reconcile, adjust, accrue and produce statements.'],
      ['4', 'Prove', 'Eight controls check the result; any critical finding blocks the close.'],
    ];
    return `<div class="card"><h3>How it works</h3><ol class="flow">${steps.map(([n, t, d]) => `<li><span class="n">${n}</span><div><b>${t}</b><p>${d}</p></div></li>`).join('')}</ol></div>`;
  }
  function viewOverview() {
    if (!state.mode) return welcome();
    const ledger = result ? result.ledger : books.entries;
    const st = M.statements(M.trialBalance(ledger));
    const cash = M.acctSum(ledger, '1000');
    const margin = st.netSales ? (st.grossProfit * 100 / st.netSales).toFixed(1) + '%' : '—';
    const stage = result ? 'after month-end close' : 'before month-end close';
    const kpi = (label, value, note) => `<div class="kpi"><div class="k-label">${label}</div><div class="k-value">${value}</div><div class="k-note">${note}</div></div>`;
    return `
      <div class="kpis">
        ${kpi('Net sales', M.usd(st.netSales), 'books + café − returns')}
        ${kpi('Gross margin', margin, M.usd(st.grossProfit) + ' gross profit')}
        ${kpi('Net income', M.usd(st.netIncome), stage)}
        ${kpi('Cash in bank', M.usd(cash), stage)}
        ${kpi('Transactions', String(state.events.length), state.mode === 'generated' ? 'generated + yours' : 'entered by you')}
      </div>
      <div class="grid two wide-left">
        <div class="card"><h3>Daily sales</h3>${salesChart()}</div>
        <div class="card"><h3>Close status</h3>${closeStatus()}</div>
      </div>
      ${howItWorks()}`;
  }
  function salesChart() {
    const days = M.periodDays(state.period);
    const val = {};
    for (const je of books.entries) {
      if (!je.event) continue;
      for (const l of je.lines) if (['4000', '4010', '4100'].includes(l.acct)) val[je.date] = (val[je.date] || 0) + l.cr - l.dr;
    }
    const data = days.map(d => ({ d, v: val[d] || 0 }));
    const max = Math.max(1, ...data.map(x => x.v));
    if (!data.some(x => x.v)) return '<p class="muted">No sales recorded yet.</p>';
    const W = 620, H = 200, pad = 28, bw = (W - pad) / data.length;
    const bars = data.map((x, i) => {
      const h = Math.max(0, x.v) / max * (H - 30);
      return `<rect x="${pad + i * bw + 1}" y="${H - 18 - h}" width="${Math.max(1, bw - 3)}" height="${h}" rx="2" class="bar"><title>${M.dayLabel(x.d)}: ${M.usd(x.v)}</title></rect>`;
    }).join('');
    const ticks = [0, 0.5, 1].map(t => `<text x="${pad - 4}" y="${H - 18 - t * (H - 30) + 4}" class="axis" text-anchor="end">${Math.round(max * t / 100000)}k</text><line x1="${pad}" x2="${W}" y1="${H - 18 - t * (H - 30)}" y2="${H - 18 - t * (H - 30)}" class="gridline"/>`).join('');
    const labels = data.map((x, i) => (i % 5 === 0 ? `<text x="${pad + i * bw + bw / 2}" y="${H - 4}" class="axis" text-anchor="middle">${Number(x.d.slice(8))}</text>` : '')).join('');
    return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Daily net sales">${ticks}${bars}${labels}</svg>`;
  }
  function closeStatus() {
    if (!result) return `<p>${M.periodLabel(state.period)} is open. ${state.events.length} transactions recorded.</p><button class="btn primary" data-act="tab" data-tab="close">Open the month-end close</button>`;
    return `<div class="verdict ${verdictKind(result.verdict)}">${esc(sentence(result.verdict))}</div>
      <ul class="steplist">${result.steps.map(s => `<li>${s.ok ? '✓' : '✕'} ${esc(s.title)}</li>`).join('')}</ul>
      <p class="muted">${result.counts.crit} critical findings, ${result.counts.warn} warnings</p>`;
  }

  // ---------- transactions ----------
  function fieldDefault(f, type, date) {
    const ctx = { payrollDefault: M.payrollDefault(state, date, books.opening), opening: books.opening };
    return typeof f.default === 'function' ? f.default(ctx) : f.default;
  }
  // ---------- manual journal entry: the catch-all for anything the templates don't cover ----------
  const blankManual = () => ({ memo: '', reason: '', lines: [{ acct: '', dr: '', cr: '' }, { acct: '', dr: '', cr: '' }] });
  const MANUAL_GROUPS = [['A', 'Assets'], ['L', 'Liabilities'], ['E', 'Equity'], ['R', 'Revenue'], ['X', 'Expenses']];
  function manualForm() {
    const mj = ui.manual || (ui.manual = blankManual());
    const accountOptions = sel => MANUAL_GROUPS.map(([type, label]) => `<optgroup label="${label}">${M.ACCOUNTS
      .filter(a => a.type === type && !M.CONTROL_ACCOUNTS.includes(a.code))
      .map(a => `<option value="${a.code}" ${a.code === sel ? 'selected' : ''}>${a.code} ${esc(a.name)}</option>`).join('')}</optgroup>`).join('');
    const rows = mj.lines.map((l, i) => `<tr>
        <td><select class="input" data-mj-line="${i}" data-mj-field="acct" aria-label="Account, line ${i + 1}"><option value="">Choose an account…</option>${accountOptions(l.acct)}</select></td>
        <td class="r"><div class="money-in"><span>$</span><input class="input num" data-mj-line="${i}" data-mj-field="dr" inputmode="decimal" value="${esc(l.dr)}" aria-label="Debit, line ${i + 1}"></div></td>
        <td class="r"><div class="money-in"><span>$</span><input class="input num" data-mj-line="${i}" data-mj-field="cr" inputmode="decimal" value="${esc(l.cr)}" aria-label="Credit, line ${i + 1}"></div></td>
        <td>${mj.lines.length > 2 ? `<button class="btn tiny ghost" data-act="mj-remove-line" data-i="${i}" title="Remove this line" aria-label="Remove line ${i + 1}">✕</button>` : ''}</td></tr>`).join('');
    return `
      <div class="manual">
        <div class="form manual-head">
          <label class="field wide">Description<input class="input" data-mj="memo" value="${esc(mj.memo)}" placeholder="e.g. Refund from Bluebird Press for a short delivery"></label>
          <label class="field wide">Reason and supporting evidence<input class="input" data-mj="reason" value="${esc(mj.reason)}" placeholder="e.g. Credit note BP-2291 received 14 March"></label>
        </div>
        <div class="scroll"><table class="t manual-lines"><thead><tr><th>Account</th><th class="r">Debit</th><th class="r">Credit</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
          <tfoot><tr class="tot"><td>Total <span class="muted" id="mj-diff"></span></td><td class="r" id="mj-dr"></td><td class="r" id="mj-cr"></td><td></td></tr></tfoot></table></div>
        <p class="hint" id="mj-msg"></p>
        <div class="row">
          <button class="btn" data-act="mj-add-line">Add a line</button>
          <button class="btn primary" data-act="mj-post" id="mj-post">Post journal entry</button>
        </div>
        <p class="hint">Control accounts (card clearing, prepaids, accumulated depreciation, accruals, gift cards, sales tax and retained earnings) are not offered: only their own transactions and the month-end close may change them, which keeps every reconciliation honest.</p>
      </div>`;
  }
  // Checks the manual entry as typed; returns the event to post, or the first problem in plain words.
  function readManual() {
    const mj = ui.manual || blankManual();
    const lines = [];
    for (const [i, l] of mj.lines.entries()) {
      const d = l.dr.trim() ? M.parseCents(l.dr) : 0, c = l.cr.trim() ? M.parseCents(l.cr) : 0;
      if (!l.acct && !d && !c) continue; // an untouched spare line
      if (!l.acct) return { error: `Line ${i + 1}: choose an account.` };
      if (Number.isNaN(d) || Number.isNaN(c) || d < 0 || c < 0) return { error: `Line ${i + 1}: enter amounts like 1,250.00.` };
      if ((d > 0) === (c > 0)) return { error: `Line ${i + 1}: enter either a debit or a credit, not both.` };
      lines.push({ acct: l.acct, dr: d, cr: c });
    }
    const drT = M.lineTotal(lines, 'dr'), crT = M.lineTotal(lines, 'cr');
    const totals = { dr: drT, cr: crT };
    if (lines.length < 2) return { error: 'An entry needs at least two lines.', totals };
    if (drT !== crT) return { error: `Debits and credits differ by ${M.usd(Math.abs(drT - crT))}. They must be equal before the entry can post.`, totals };
    if (!mj.memo.trim()) return { error: 'Add a description of what happened.', totals };
    if (!mj.reason.trim()) return { error: 'Add the reason and the evidence that supports it.', totals };
    return { ev: { date: ui.date, type: 'manual', memo: mj.memo.trim(), reason: mj.reason.trim(), lines, amount: drT }, totals };
  }
  function updateManualTotals() {
    const r = readManual();
    const mj = ui.manual || blankManual();
    const sumSide = side => mj.lines.reduce((t, l) => { const v = l[side].trim() ? M.parseCents(l[side]) : 0; return t + (Number.isNaN(v) ? 0 : v); }, 0);
    const drT = sumSide('dr'), crT = sumSide('cr');
    const set = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
    set('mj-dr', money(drT));
    set('mj-cr', money(crT));
    set('mj-diff', drT === crT ? (drT ? '· balanced' : '') : `· out by ${M.usd(Math.abs(drT - crT))}`);
    set('mj-msg', r.error ? esc(r.error) : 'Balanced and ready to post.');
    const msg = document.getElementById('mj-msg');
    if (msg) msg.className = 'hint ' + (r.error ? 'bad-text' : 'ok-text');
    const post = document.getElementById('mj-post');
    if (post) post.disabled = !!r.error;
  }

  function builder() {
    const days = M.periodDays(state.period);
    if (!ui.date || !days.includes(ui.date)) ui.date = days[0];
    const t = M.TEMPLATES[ui.type];
    const typeOpts = M.TEMPLATE_GROUPS.map(g => `<optgroup label="${g}">${Object.entries(M.TEMPLATES).filter(([, v]) => v.group === g).map(([k, v]) => `<option value="${k}" ${k === ui.type ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}</optgroup>`).join('');
    if (ui.type === 'manual') {
      return `
      <div class="card" id="builder">
        <div class="card-head"><h3>Add a transaction</h3><span class="muted">Manual journal entry: for anything the transaction list doesn't cover</span></div>
        <div class="form">
          <label class="field">Day<select class="input" data-chg="bdate">${days.map(d => `<option value="${d}" ${d === ui.date ? 'selected' : ''}>${M.dayLabel(d)}</option>`).join('')}</select></label>
          <label class="field">Transaction<select class="input" data-chg="btype">${typeOpts}</select></label>
        </div>
        ${manualForm()}
      </div>`;
    }
    const kept = ui.draft && ui.draft.type === ui.type ? ui.draft.values : {}; // what was typed before the day changed
    const fields = t.fields.map(f => {
      const has = f.key in kept;
      const def = has ? kept[f.key] : fieldDefault(f, ui.type, ui.date);
      let input;
      if (f.kind === 'select') {
        const opts = typeof f.options === 'function' ? f.options() : f.options;
        input = `<select class="input" name="${f.key}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${v === def ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
      } else if (f.kind === 'money') {
        input = `<div class="money-in"><span>$</span><input class="input num" name="${f.key}" inputmode="decimal" value="${has ? esc(def) : M.fmt(def)}" autocomplete="off"></div>`;
      } else {
        input = `<input class="input" name="${f.key}" ${f.kind === 'int' ? 'type="number" min="1"' : ''} value="${esc(def)}">`;
      }
      return `<label class="field">${esc(f.label)}${input}</label>`;
    }).join('');
    return `
      <div class="card" id="builder">
        <div class="card-head"><h3>Add a transaction</h3><span class="muted">Usual timing: ${esc(t.usual)}</span></div>
        <div class="form">
          <label class="field">Day<select class="input" data-chg="bdate">${days.map(d => `<option value="${d}" ${d === ui.date ? 'selected' : ''}>${M.dayLabel(d)}</option>`).join('')}</select></label>
          <label class="field">Transaction<select class="input" data-chg="btype">${typeOpts}</select></label>
          ${fields}
          <div class="field end"><button class="btn primary" data-act="add">Add transaction</button></div>
        </div>
        <div id="preview"></div>
        <div class="quick">
          <span class="muted">Quick add:</span>
          <button class="btn" data-act="quick-day">A typical sales day on ${M.shortDate(ui.date)}</button>
          <button class="btn" data-act="quick-bills">The usual monthly bills &amp; payroll</button>
        </div>
      </div>`;
  }
  function readBuilder() {
    const root = document.getElementById('builder');
    if (!root) return null;
    const t = M.TEMPLATES[ui.type];
    const ev = { date: ui.date, type: ui.type };
    for (const f of t.fields) {
      const el = root.querySelector(`[name="${f.key}"]`);
      const raw = el ? el.value.trim() : '';
      if (f.kind === 'money') {
        const c = M.parseCents(raw);
        if (!(c > 0)) return { error: `${f.label}: enter a positive amount like 1,250.00` };
        ev[f.key] = c;
      } else if (f.kind === 'int') {
        const v = parseInt(raw, 10);
        if (!(v >= 1)) return { error: `${f.label}: enter a whole number of at least 1` };
        ev[f.key] = v;
      } else {
        if (!raw) return { error: `${f.label} is required` };
        ev[f.key] = raw;
      }
    }
    return { ev };
  }
  function linesTable(lines) {
    return `<table class="t lines"><thead><tr><th>Account</th><th class="r">Debit</th><th class="r">Credit</th></tr></thead><tbody>
      ${lines.filter(l => l.dr || l.cr).map(l => `<tr><td><span class="code">${l.acct}</span> ${esc(M.acct(l.acct).name)}</td><td class="r">${l.dr ? money(l.dr) : ''}</td><td class="r">${l.cr ? money(l.cr) : ''}</td></tr>`).join('')}
      <tr class="tot"><td>Total</td><td class="r">${money(M.lineTotal(lines, 'dr'))}</td><td class="r">${money(M.lineTotal(lines, 'cr'))}</td></tr></tbody></table>`;
  }
  function updatePreview() {
    if (ui.type === 'manual') { updateManualTotals(); return; }
    const box = document.getElementById('preview');
    if (!box) return;
    const r = readBuilder();
    if (!r || r.error) { box.innerHTML = `<p class="hint bad-text">${esc(r ? r.error : '')}</p>`; return; }
    const lines = M.TEMPLATES[ui.type].lines(r.ev);
    box.innerHTML = `<p class="hint">This journal entry will be recorded:</p>${linesTable(lines)}`;
  }
  function viewTxns() {
    let out = '';
    if (!state.mode) return `<div class="card"><p>Nothing recorded yet.</p><div class="row"><button class="btn primary" data-act="tab" data-tab="overview">Choose how to start</button></div></div>`;
    if (locked()) out += `<div class="banner info">${M.periodLabel(state.period)} is closed and locked. <span class="spacer"></span><button class="btn" data-act="reopen">Reopen the month to make changes</button></div>`;
    else out += builder();

    const entries = books.entries.concat(result ? result.adjustments : []);
    const rows = entries
      .filter(je => !ui.filter || je.type === ui.filter || (ui.filter === 'close' && je.source === 'close'))
      .filter(je => !ui.source || je.source === ui.source)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const typeOpts = [['', 'All types']].concat(Object.entries(M.TEMPLATES).map(([k, v]) => [k, v.label]));
    const srcOpts = [['', 'All sources'], ['generated', 'Generated'], ['user', 'Entered by you'], ['close', 'Month-end'], ['system', 'Auto'], ['opening', 'Opening']];
    const body = rows.map(je => {
      const [lbl, kind] = je.event && je.event.planted ? ['Planted', 'bad'] : je.type === 'manual' ? ['Manual', 'warn'] : SOURCE[je.source] || ['—', 'muted'];
      const canEdit = je.event && !locked();
      const isManual = je.type === 'manual';
      const amt = je.event ? je.event.amount : M.lineTotal(je.lines, 'dr');
      const amountCell = ui.editing === je.eventId
        ? `<div class="money-in inline"><span>$</span><input class="input num" id="edit-amt" value="${M.fmt(je.event.amount)}" inputmode="decimal"></div>`
        : money(amt);
      const actions = !canEdit ? '' : ui.editing === je.eventId
        ? `<button class="btn tiny primary" data-act="edit-save" data-id="${je.eventId}">Save</button><button class="btn tiny" data-act="edit-cancel">Cancel</button>`
        : `${isManual ? '' : `<button class="btn tiny" data-act="edit" data-id="${je.eventId}">Edit amount</button>`}<button class="btn tiny ghost" data-act="del" data-id="${je.eventId}" title="Delete">✕</button>`;
      const open = ui.open.has(je.id);
      return `<tr class="je ${open ? 'open' : ''}"><td class="nowrap">${M.shortDate(je.date)}</td><td><button class="linkish" data-act="toggle" data-id="${je.id}">${open ? '▾' : '▸'} ${je.id}</button></td>
        <td>${esc(je.memo)}</td><td>${chip(lbl, kind)}</td><td class="r">${amountCell}</td><td class="actions">${actions}</td></tr>
        ${open ? `<tr class="detail"><td></td><td colspan="5">${isManual ? `<p class="hint">Reason and evidence: ${esc(je.event.reason)}</p>` : ''}${linesTable(je.lines)}</td></tr>` : ''}`;
    }).join('');
    out += `
      <div class="card">
        <div class="card-head"><h3>Journal <span class="muted">(${rows.length} entries)</span></h3>
          <div class="row">
            <select class="input" data-chg="filter">${typeOpts.map(([v, l]) => `<option value="${v}" ${v === ui.filter ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
            <select class="input" data-chg="source">${srcOpts.map(([v, l]) => `<option value="${v}" ${v === ui.source ? 'selected' : ''}>${l}</option>`).join('')}</select>
            <button class="btn" data-act="csv-journal">Export CSV</button>
            ${locked() ? '' : ui.confirm === 'reset' ? `<button class="btn danger" data-act="reset">Click again to clear everything</button>` : `<button class="btn ghost" data-act="reset">Start over</button>`}
          </div></div>
        <div class="scroll"><table class="t journal"><thead><tr><th>Date</th><th>Entry</th><th>Description</th><th>Source</th><th class="r">Amount</th><th></th></tr></thead><tbody>${body || '<tr><td colspan="6" class="muted">No entries match.</td></tr>'}</tbody></table></div>
        <p class="hint">Click an entry number to see its debits and credits. "Amount" is what you entered (before tax for sales); the full entry shows tax, cost of goods and other lines.</p>
      </div>`;
    return out;
  }

  // ---------- month-end close ----------
  function viewClose() {
    if (!state.mode) return `<div class="card"><p>Record some transactions first.</p><button class="btn primary" data-act="tab" data-tab="overview">Choose how to start</button></div>`;
    const d = books.docs;
    const bankRows = d.bank.lines.map(l => `<tr><td>${M.shortDate(l.date)}</td><td>${esc(l.desc)}</td><td class="r">${money(l.amount)}</td></tr>`).join('');
    const procRows = d.processor.map(r => `<tr><td>${M.shortDate(r.saleDate)}</td><td>${M.shortDate(r.settleDate)}</td><td class="r">${money(r.gross)}</td><td class="r">${money(r.fee)}</td><td class="r">${money(r.net)}</td></tr>`).join('');
    const suggested = d.count.book - M.pct(d.count.book, state.shrinkBps ?? 50);
    let out = `
      <div class="card"><h3>1. Documents received at month end</h3>
        <p class="muted">These come from outside the store. The close checks our books against them.</p>
        <div class="grid three">
          <div class="doc"><h4>Bank statement</h4>
            <dl><dt>Opening</dt><dd>${M.usd(d.bank.opening)}</dd><dt>Closing</dt><dd>${M.usd(d.bank.closing)}</dd><dt>Lines</dt><dd>${d.bank.lines.length}</dd></dl>
            <details><summary>View statement</summary><div class="scroll short"><table class="t"><tbody>${bankRows}</tbody></table></div></details></div>
          <div class="doc"><h4>Card processor report</h4>
            <dl><dt>Payout batches</dt><dd>${d.processor.length}</dd><dt class="sub-dt">from last month's final 2 days</dt><dd class="sub-dt">${d.processor.filter(r => r.saleDate < M.periodStart(state.period)).length}</dd><dt>Gross</dt><dd>${M.usd(sum(d.processor, r => r.gross))}</dd><dt>Fees</dt><dd>${M.usd(sum(d.processor, r => r.fee))}</dd></dl>
            <details><summary>View report</summary><div class="scroll short"><table class="t"><thead><tr><th>Sold</th><th>Paid</th><th class="r">Gross</th><th class="r">Fee</th><th class="r">Net</th></tr></thead><tbody>${procRows}</tbody></table></div></details></div>
          <div class="doc"><h4>Physical stock count</h4>
            <dl><dt>Café stock counted</dt><dd>${M.usd(d.cafeCount.value)}</dd><dt>Books: book value</dt><dd>${M.usd(d.count.book)}</dd></dl>
            <label class="field">Books counted on the shelves
              <div class="money-in"><span>$</span><input class="input num" data-chg="count" value="${M.fmt(d.count.value)}" ${locked() ? 'disabled' : ''}></div></label>
            <p class="hint" id="count-hint">${d.count.override ? `Your count. <button class="linkish" data-act="count-reset">Use suggested ${M.usd(suggested)}</button>` : `Suggested: ${(state.shrinkBps / 100).toFixed(2)}% shrinkage. Type your own count to change it.`}</p></div>
        </div>
      </div>
      <div class="card run">
        <div><h3>2. Run the month-end close</h3><p class="muted">Nine steps run in order; each posts its adjusting entry and must tie out. Then eight controls check the result.</p></div>
        ${locked() ? `<button class="btn" data-act="reopen">Reopen month</button>` : `<button class="btn primary big" data-act="run">Run month-end close</button>`}
      </div>`;
    if (result) out += closeResult(result);
    return out;
  }
  function closeResult(r) {
    const msg = r.verdict === 'BLOCKED'
      ? `${r.counts.crit} critical finding${r.counts.crit === 1 ? '' : 's'} — the month was NOT locked. Fix the input and run again.`
      : `All nine steps tied out. ${locked() ? `${M.periodLabel(r.period)} is locked (period seal ${r.lock.inputHash}).` : ''} ${r.counts.warn ? r.counts.warn + ' warning(s) to explain — see Controls.' : ''}`;
    return `
      <div class="verdict-banner ${verdictKind(r.verdict)}"><b>${esc(sentence(r.verdict))}</b><span>${esc(msg)}</span>
        <button class="btn" data-act="tab" data-tab="controls">View the controls</button>
        ${locked() && nextPeriod(state.period) ? `<button class="btn primary" data-act="next-month">Start ${M.periodLabel(nextPeriod(state.period))}</button>` : ''}
        ${locked() && !nextPeriod(state.period) ? `<button class="btn primary" data-act="fs-year">See FY ${M.YEAR} statements</button>` : ''}</div>
      ${r.verdict === 'BLOCKED' ? '' : commentaryCard(r)}
      <div class="steps">${r.steps.map(stepCard).join('')}</div>`;
  }
  function currentCommentary(r) {
    const c = state.commentary;
    return c && c.seal === r.lock.ledgerHash ? c : null;
  }
  function commentaryCard(r) {
    const c = currentCommentary(r);
    const facts = M.commentaryFacts(r, books);
    const ai = ui.ai || {};
    const aiButton = ai.configured
      ? `<button class="btn primary" data-act="commentary-ai" ${ui.commentaryBusy ? 'disabled' : ''}>${ui.commentaryBusy ? 'Writing…' : c ? 'Regenerate with AI' : 'Generate with AI'}</button>`
      : `<button class="btn" disabled title="Add GROQ_API_KEY to .env and restart node serve.js">Generate with AI</button>`;
    const buttons = `<div class="row">${aiButton}<button class="btn" data-act="commentary-template">${c && c.source === 'template' ? 'Rebuild template' : 'Use template (no AI)'}</button>${c ? '<button class="btn ghost" data-act="commentary-copy">Copy text</button>' : ''}</div>`;
    const status = ai.configured ? 'AI connected' : ai.offline ? 'AI server not reachable — start the app with node serve.js' : 'AI not set up — add GROQ_API_KEY to .env and restart node serve.js';
    let body;
    if (!c) {
      body = `<p class="muted">A management summary of ${M.periodLabel(r.period)} with prioritised AI recommendations, written from the closed figures. It is generated automatically after each successful close; every number in it is checked against the close before you see it.</p>`;
    } else {
      const chk = M.checkCommentaryNumbers(c.text, facts);
      const check = chk.unverified.length
        ? `<div class="banner warn">${chk.unverified.length} of ${chk.total} numbers could not be found in the close figures (highlighted). Review before sharing.</div>`
        : `<div class="banner ok">All ${chk.total} numbers match the closed figures.</div>`;
      body = `${check}<div class="commentary">${M.renderCommentary(c.text, facts, esc)}</div>
        <p class="hint">${c.source === "groq" ? "Drafted by AI" : "Written from the template, no AI"} on ${esc(new Date(c.at).toLocaleString())}. Numbers are checked automatically; the wording is yours to review.</p>`;
    }
    return `<div class="card">
      <div class="card-head"><h3>Month-end commentary &amp; AI recommendations</h3><span class="muted">${status}</span></div>
      ${ui.commentaryError ? `<div class="banner bad">${esc(ui.commentaryError)}</div>` : ''}
      ${body}${buttons}</div>`;
  }
  function stepCard(st) {
    return `<details class="step ${st.ok ? 'ok' : 'bad'}" ${st.ok ? '' : 'open'}>
      <summary><span class="sn">${st.n}</span><span class="stitle">${esc(st.title)}</span>${st.ok ? chip('Tied', 'ok') : chip('Exception', 'bad')}<span class="ssum">${esc(st.summary)}</span></summary>
      <div class="sbody">${stepDetail(st)}
        ${st.entries.length ? `<h5>Adjusting entries posted (${st.entries.length})</h5>${st.entries.slice(0, 6).map(j => `<div class="adj"><div class="adj-h">${j.id}, ${M.shortDate(j.date)}: ${esc(j.memo)}</div>${linesTable(j.lines)}</div>`).join('')}${st.entries.length > 6 ? `<p class="muted">…and ${st.entries.length - 6} more (see Transactions, filtered to month-end entries).</p>` : ''}` : ''}
        ${st.diff !== 0 ? `<p class="bad-text"><b>Difference: ${M.usd(st.diff)}</b></p>` : ''}
      </div></details>`;
  }
  const kv = rows => `<table class="t kv"><tbody>${rows.map(([k, v, cls]) => `<tr class="${cls || ''}"><td>${k}</td><td class="r">${typeof v === 'number' ? money(v) : v}</td></tr>`).join('')}</tbody></table>`;
  function stepDetail(st) {
    const d = st.detail;
    switch (st.id) {
      case 'card': return kv([['Card clearing balance in the ledger', d.gl], ['Card sales not yet paid out (in transit)', d.inTransit], ['Difference', st.diff, 'tot']]);
      case 'bank': return `<div class="grid two">
          ${kv([['Balance per bank statement', d.bankEnd], ['+ Deposits in transit', d.dit], ['− Outstanding checks & payments', d.oc], ['Adjusted bank balance', d.adjustedBank, 'tot'], ['Cash per books (after adjustments)', d.bookCash], ['Difference', st.diff, 'tot']])}
          <div><h5>Bank-only items found</h5>${d.bankOnly.length ? `<ul class="plain">${d.bankOnly.map(b => `<li>${esc(b.desc)} ${M.usd(b.amount)} — ${b.booked ? 'booked' : '<b class="bad-text">not booked</b>'}</li>`).join('')}</ul>` : '<p class="muted">None</p>'}
          <h5>In transit at month end</h5>${d.outstanding.length ? `<ul class="plain">${d.outstanding.map(b => `<li>${M.shortDate(b.date)} ${esc(b.memo)} ${M.usd(b.amount)}</li>`).join('')}</ul>` : '<p class="muted">None</p>'}</div></div>`;
      case 'inventory': return `<div class="grid two">
          <div><h5>Books</h5>${kv([['Inventory per books', d.book], ['Physical count', d.count], [d.shrink >= 0 ? 'Shrinkage (missing stock)' : 'Overage', Math.abs(d.shrink)]])}</div>
          <div><h5>Café stock</h5>${kv([['Café stock per books', d.cafeBook], ['Counted', d.cafeCount], ['Waste and spoilage', d.waste]])}</div></div>
          ${kv([['Difference after adjustments', st.diff, 'tot']])}`;
      case 'prepaids': return `<table class="t"><thead><tr><th>Item</th><th class="r">Total paid</th><th class="r">Month</th><th class="r">Opening</th><th class="r">Expensed</th><th class="r">Closing</th></tr></thead><tbody>
          ${d.rows.map(r => `<tr><td>${esc(r.name)}</td><td class="r">${money(r.total)}</td><td class="r">${r.monthNo >= 1 && r.monthNo <= r.months ? `${r.monthNo} of ${r.months}` : 'done'}</td><td class="r">${money(r.opening)}</td><td class="r">${money(r.amort)}</td><td class="r">${money(r.closing)}</td></tr>`).join('')}</tbody></table>`;
      case 'depreciation': return `<table class="t"><thead><tr><th>Asset</th><th class="r">Cost</th><th class="r">Life</th><th class="r">Opening acc. dep.</th><th class="r">This month</th><th class="r">Book value</th><th>Status</th></tr></thead><tbody>
          ${d.rows.map(r => `<tr><td>${esc(r.name)}</td><td class="r">${money(r.cost)}</td><td class="r">${r.life} mo</td><td class="r">${money(r.opening)}</td><td class="r">${money(r.amt)}</td><td class="r">${money(r.nbv)}</td><td>${esc(r.status)}</td></tr>`).join('')}</tbody></table>`;
      case 'accruals': return `<table class="t"><thead><tr><th>Accrual</th><th>How it's calculated</th><th class="r">Amount</th><th>Posted</th></tr></thead><tbody>
          ${d.items.map(i => `<tr><td>${esc(i.name)}</td><td>${esc(i.basis)}</td><td class="r">${money(i.amount)}</td><td>${i.posted ? '✓' : '<b class="bad-text">missing</b>'}</td></tr>`).join('')}</tbody></table>`;
      case 'giftcards': return kv([['Opening balance owed', d.opening], ['+ Cards sold', d.sold], ['− Cards redeemed (incl. tax)', d.redeemed], ['Expected balance', d.expected, 'tot'], ['Gift card liability per ledger', d.gl], ['Difference', st.diff, 'tot']]);
      case 'salestax': return kv([['Opening sales tax owed', d.opening], ['+ Tax collected (8% × ' + M.usd(d.taxable) + ')', d.collected], ['− Paid to the state', d.remitted], ['Expected balance', d.expected, 'tot'], ['Sales tax payable per ledger', d.gl], ['Difference', st.diff, 'tot']]);
      case 'close': return kv([['Net sales', d.statements.netSales], ['Gross profit', d.statements.grossProfit], ['Net income', d.statements.netIncome, 'tot'], ['Total assets', d.statements.totalAssets], ['Liabilities + equity', d.statements.totalLiabilities + d.statements.totalEquity], ['Balance sheet difference', d.statements.bsDiff, 'tot'], ['Period seal — the month\'s recorded entries; checked by C8', `<code>${d.lock.inputHash}</code>`], ['Closed-ledger fingerprint — including the close adjustments', `<code>${d.lock.ledgerHash}</code>`]]);
      default: return '';
    }
  }

  // ---------- statements ----------
  function fsToggle() {
    const b = (v, label) => `<button class="seg ${ui.fsView === v ? 'on' : ''}" data-act="fs-view" data-view="${v}">${label}</button>`;
    return `<div class="segmented">${b('month', M.periodLabel(state.period))}${b('year', `FY ${M.YEAR} year to date`)}</div>`;
  }
  function viewStatements() {
    if (ui.fsView === 'year') return fsToggle() + viewYear();
    return fsToggle() + viewMonthStatements();
  }

  // Income statement rows for the year view: one value per closed month + the year total.
  const YEAR_OPEX = ['6000', '6100', '6200', '6300', '6400', '6410', '6500', '6600', '6700'];
  function yearIncomeRows(y) {
    const row = (label, f, cls = '') => {
      const values = y.months.map(f);
      return { label, values, total: values.reduce((t, v) => t + v, 0), cls };
    };
    const opex = m => YEAR_OPEX.reduce((t, c) => t + m.lines[c], 0);
    return [
      row('Book sales', m => m.lines['4000']), row('Café sales', m => m.lines['4010']), row('Sales returns', m => m.lines['4100']),
      row('Net sales', m => m.st.netSales, 'sub'),
      row('Cost of books sold', m => m.lines['5000']), row('Inventory shrinkage', m => m.lines['5010']),
      row('Café cost of sales', m => m.lines['5020']), row('Café waste', m => m.lines['5030']),
      row('Gross profit', m => m.st.grossProfit, 'sub'),
      ...YEAR_OPEX.map(c => row(M.acct(c).name, m => m.lines[c])),
      row('Operating income', m => m.st.grossProfit - opex(m), 'sub'),
      row('Interest income', m => m.lines['4900']), row('Interest expense', m => -m.lines['7000']),
      row('Net income', m => m.st.netIncome, 'tot'),
    ];
  }
  function viewYear() {
    const { run } = closedRun(null);
    if (!run.length) {
      return `<div class="card"><h3>No closed months yet</h3><p>Yearly statements are built from closed months, starting in January. Close January (and each month after it), or generate and close the whole year in one go.</p>
        <div class="row"><button class="btn primary" data-act="goto" data-period="${M.PERIODS[0]}">Go to January</button>
        ${ui.confirm === 'year' ? `<button class="btn danger" data-act="generate-year">Click again: replace all 12 months</button>` : `<button class="btn" data-act="generate-year">Generate &amp; close FY ${M.YEAR}</button>`}</div></div>`;
    }
    const y = M.yearStatements(run);
    const short = p => new Date(p + '-01T00:00:00Z').toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
    const span = run.length === 12 ? `full year, January–December ${M.YEAR}` : `year to date, January–${M.periodLabel(y.lastPeriod).split(' ')[0]} (${run.length} of 12 months closed)`;
    const rows = yearIncomeRows(y);
    const income = `<div class="card"><div class="card-head"><h3>Income statement, FY ${M.YEAR}</h3>
      <div class="row"><button class="btn primary" data-act="xlsx-year" ${ui.xlsxBusy ? 'disabled' : ''}>${ui.xlsxBusy ? 'Building workbook…' : 'Download Excel'}</button><button class="btn" data-act="csv-year">Export CSV</button></div></div>
      <div class="scroll"><table class="t fs year"><thead><tr><th></th>${y.months.map(m => `<th class="r">${short(m.period)}</th>`).join('')}<th class="r total-col">FY total</th></tr></thead><tbody>
      ${rows.map(r => `<tr class="${r.cls}"><td class="nowrap">${esc(r.label)}</td>${r.values.map(v => `<td class="r">${money(v)}</td>`).join('')}<td class="r total-col">${money(r.total)}</td></tr>`).join('')}
      <tr><td class="nowrap muted">Net margin</td>${y.months.map(m => `<td class="r muted">${m.st.netSales ? (m.st.netIncome * 100 / m.st.netSales).toFixed(1) + '%' : '—'}</td>`).join('')}<td class="r total-col muted">${y.totals.netSales ? (y.totals.netIncome * 100 / y.totals.netSales).toFixed(1) + '%' : '—'}</td></tr>
      </tbody></table></div></div>`;

    // Balance sheet: opening (1 January) vs the latest closed month end.
    const o = y.opening, c = y.closing;
    const codes = type => [...new Set(o[type].concat(c[type]).map(r => r.code))].sort();
    const amt = (st, type, code) => (st[type].find(r => r.code === code) || { amount: 0 }).amount;
    const bsRows = (type, title) => `<tr class="hd"><td colspan="4">${title}</td></tr>` + codes(type).filter(code => code !== '3100').map(code => {
      const a = amt(o, type, code), b = amt(c, type, code);
      return `<tr><td>${esc(M.acct(code).name)}</td><td class="r">${money(a)}</td><td class="r">${money(b)}</td><td class="r">${money(b - a)}</td></tr>`;
    }).join('');
    const reOpen = amt(o, 'equity', '3100');
    const tr = (label, a, b, cls = '') => `<tr class="${cls}"><td>${label}</td><td class="r">${money(a)}</td><td class="r">${money(b)}</td><td class="r">${money(b - a)}</td></tr>`;
    const balance = `<div class="card"><h3>Balance sheet: 1 January vs ${M.shortDate(M.periodEnd(y.lastPeriod))}, ${M.YEAR}</h3>
      <div class="scroll"><table class="t fs"><thead><tr><th></th><th class="r">1 Jan ${M.YEAR}</th><th class="r">${M.shortDate(M.periodEnd(y.lastPeriod))}</th><th class="r">Change</th></tr></thead><tbody>
      ${bsRows('assets', 'Assets')}${tr('Total assets', o.totalAssets, c.totalAssets, 'sub')}
      ${bsRows('liabilities', 'Liabilities')}${tr('Total liabilities', o.totalLiabilities, c.totalLiabilities, 'sub')}
      ${bsRows('equity', 'Equity')}${tr('Retained earnings at 1 January', reOpen, reOpen)}${tr('Net income, year to date', 0, y.totals.netIncome)}
      ${tr('Total equity', o.totalEquity, c.totalEquity, 'sub')}
      ${tr('Liabilities + equity', o.totalLiabilities + o.totalEquity, c.totalLiabilities + c.totalEquity, 'tot')}
      </tbody></table></div></div>`;

    const check = (ok, text, detail) => `<li class="${ok ? 'ok-text' : 'bad-text'}">${ok ? '✓' : '✕'} ${text} <span class="muted">${detail}</span></li>`;
    const chain = run.every((m, i) => i === 0 || m.books.opening.fromPrior);
    const checks = `<div class="card"><h3>Year checks</h3><ul class="plain checks">
      ${check(y.equityCheck === 0, 'Equity rolls forward', `opening equity ${M.usd(y.openingEquity)} + net income ${M.usd(y.totals.netIncome)} − closing equity ${M.usd(c.totalEquity)} = ${M.usd(y.equityCheck)}`)}
      ${check(c.bsDiff === 0, 'Closing balance sheet balances', `assets − (liabilities + equity) = ${M.usd(c.bsDiff)}`)}
      ${check(chain, 'Every month opened from the previous month\'s close', `${run.length} consecutive closed months`)}
      ${check(run.every(m => m.result.counts.crit === 0), 'Every month passed its close controls', `${run.filter(m => m.result.counts.warn).length} month(s) closed with warnings to explain`)}
      </ul></div>`;

    const vals = y.months.map(m => m.st.netIncome);
    const max = Math.max(1, ...vals.map(Math.abs)), hasNeg = vals.some(v => v < 0);
    const W = 620, H = 160, bw = W / 12, plot = H - 20;
    const zero = hasNeg ? plot / 2 : plot, scale = (hasNeg ? plot / 2 - 6 : plot - 12) / max;
    const bars = y.months.map((m, i) => {
      const v = m.st.netIncome, h = Math.max(1, Math.abs(v) * scale);
      return `<rect x="${i * bw + 6}" y="${v >= 0 ? zero - h : zero}" width="${bw - 12}" height="${h}" rx="2" class="${v >= 0 ? 'bar' : 'bar neg'}"><title>${M.periodLabel(m.period)}: ${M.usd(v)}</title></rect><text x="${i * bw + bw / 2}" y="${H - 4}" class="axis" text-anchor="middle">${short(m.period)}</text>`;
    }).join('');
    const chart = `<div class="card"><h3>Net income by month</h3><svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Net income by month"><line x1="0" x2="${W}" y1="${zero}" y2="${zero}" class="gridline"/>${bars}</svg></div>`;

    return `<div class="banner ok">FY ${M.YEAR} — ${span}. Net sales ${M.usd(y.totals.netSales)}, net income ${M.usd(y.totals.netIncome)}.</div>
      ${income}<div class="grid two">${balance}<div>${checks}${chart}</div></div>`;
  }

  function viewMonthStatements() {
    if (!state.mode) return `<div class="card"><p>No books for ${M.periodLabel(state.period)} yet.</p></div>`;
    const ledger = result ? result.ledger : books.entries;
    const tb = M.trialBalance(ledger), st = M.statements(tb);
    const line = (label, amt, cls = '') => `<tr class="${cls}"><td>${label}</td><td class="r">${money(amt)}</td></tr>`;
    const get = code => (st.revenue.concat(st.expenses).find(r => r.code === code) || { amount: 0 }).amount;
    const opex = st.expenses.filter(r => !['5000', '5010', '5020', '5030', '7000'].includes(r.code));
    const note = result ? `Final — after the month-end close${locked() ? ' (locked)' : ' (not locked: blocked)'}` : 'Preliminary — before the month-end close. Run the close to post adjustments.';
    return `
      <div class="banner ${result ? 'ok' : 'info'}">${esc(note)}<span class="spacer"></span>
        <button class="btn" data-act="csv-tb">Trial balance CSV</button><button class="btn" data-act="csv-fs">Statements CSV</button></div>
      <div class="grid two">
        <div class="card"><h3>Income statement <span class="muted">${M.periodLabel(state.period)}</span></h3><table class="t fs"><tbody>
          ${line('Book sales', get('4000'))}${line('Café sales', get('4010'))}${line('Sales returns', get('4100'))}
          ${line('Net sales', st.netSales, 'sub')}
          ${line('Cost of books sold', get('5000'))}${line('Inventory shrinkage', get('5010'))}${line('Café cost of sales', get('5020'))}${line('Café waste', get('5030'))}
          ${line('Gross profit', st.grossProfit, 'sub')}
          ${opex.map(r => line(esc(r.name), r.amount)).join('')}
          ${line('Operating income', st.grossProfit - sum(opex, r => r.amount), 'sub')}
          ${line('Interest income', get('4900'))}${line('Interest expense', -get('7000'))}
          ${line('Net income', st.netIncome, 'tot')}
        </tbody></table></div>
        <div class="card"><h3>Balance sheet <span class="muted">${M.shortDate(M.periodEnd(state.period))}</span></h3><table class="t fs"><tbody>
          <tr class="hd"><td colspan="2">Assets</td></tr>${st.assets.map(r => line(esc(r.name), r.amount)).join('')}${line('Total assets', st.totalAssets, 'sub')}
          <tr class="hd"><td colspan="2">Liabilities</td></tr>${st.liabilities.map(r => line(esc(r.name), r.amount)).join('')}${line('Total liabilities', st.totalLiabilities, 'sub')}
          <tr class="hd"><td colspan="2">Equity</td></tr>${st.equity.map(r => line(esc(r.name), r.amount)).join('')}${line('Net income this month', st.netIncome)}${line('Total equity', st.totalEquity, 'sub')}
          ${line('Liabilities + equity', st.totalLiabilities + st.totalEquity, 'tot')}
          <tr class="${st.bsDiff ? 'bad-text' : 'ok-text'}"><td>Check: assets − (liabilities + equity)</td><td class="r">${money(st.bsDiff)}</td></tr>
        </tbody></table></div>
      </div>
      <div class="card"><h3>Trial balance</h3><div class="scroll"><table class="t"><thead><tr><th>Account</th><th>Name</th><th class="r">Debit</th><th class="r">Credit</th></tr></thead><tbody>
        ${tb.rows.map(r => `<tr><td class="code">${r.code}</td><td>${esc(r.name)}</td><td class="r">${r.dr ? money(r.dr) : ''}</td><td class="r">${r.cr ? money(r.cr) : ''}</td></tr>`).join('')}
        <tr class="tot"><td></td><td>Total</td><td class="r">${money(tb.totalDr)}</td><td class="r">${money(tb.totalCr)}</td></tr></tbody></table></div></div>`;
  }

  // ---------- controls ----------
  // What each control is for, in plain words: shown when a control is opened on the Controls screen.
  const CONTROL_HELP = {
    C1: {
      what: 'Every journal entry must have equal debits and credits, and so must the trial balance. It is the basic rule of double-entry bookkeeping.',
      example: 'Rent is debited $4,000 but only $3,990 is credited to cash. Every report built on those books is then off by $10.',
      how: 'Re-adds every line of every entry this month (the opening balances, your transactions and the month-end adjustments), then re-adds the trial balance. It recounts from scratch instead of trusting the check made when each entry was recorded.',
      fails: 'Critical: the close is blocked and the month is not locked.',
    },
    C2: {
      what: 'Each balance in the books must agree with outside evidence or its supporting schedule, to the cent.',
      example: 'The bank charged a $15 fee that was never recorded, so the books show $15 more cash than the bank actually holds.',
      how: 'Each close step compares two figures from different sources: cash against the bank statement, card clearing against the processor report, stock against the physical counts, prepaids and depreciation against their schedules, accruals against their calculations, and gift cards and sales tax against the transactions. Any difference that is not exactly $0.00, or any bank line the app cannot explain, fails.',
      fails: 'Critical: the close is blocked and the month is not locked.',
    },
    C3: {
      what: 'Every month-end entry that should exist must exist, exactly once.',
      example: 'The wages staff earned in the last days of the month are never accrued. The books still balance, but expenses are understated and profit looks better than it is.',
      how: 'Works out which entries should exist from the source data (one per card payout due, one depreciation entry per asset still in use, the three accruals, and so on), then counts what was actually posted. Anything missing, duplicated or unexpected fails.',
      fails: 'Critical: the close is blocked and the month is not locked.',
    },
    C4: {
      what: 'Equipment is depreciated only over its useful life, and never by more than it cost.',
      example: 'A spreadsheet formula copied past an asset\'s last month keeps charging depreciation on shelving that is already fully written off.',
      how: 'For every asset, recalculates how many months of its life were used before this month. Depreciation on a used-up asset, or accumulated depreciation above cost, fails. The old cash register has been fully depreciated since December 2024, so this control always has something to protect.',
      fails: 'Critical: the close is blocked and the month is not locked.',
    },
    C5: {
      what: 'An expense that moves sharply from last month needs a reason before the month is signed off.',
      example: 'Rent is recorded twice. Everything still balances, but rent doubles from $4,000 to $8,000.',
      how: 'Compares each expense with last month\'s actual figure (a preset figure in January). A change of more than 20% and more than $100 raises a warning; both must be true, so small accounts do not cause constant alerts. If a schedule explains the movement, such as a licence ending or an asset finishing depreciation, it is noted instead.',
      fails: 'Warning: the close is not blocked, but the movement needs a written explanation before sign-off.',
    },
    C6: {
      what: 'Assets must equal liabilities plus equity, including this month\'s profit.',
      example: 'Opening cash was carried forward $500 too high, so the balance sheet is off by $500 from the first day.',
      how: 'Builds the balance sheet from the ledger and requires assets minus liabilities and equity to be exactly $0.00.',
      fails: 'Critical: the close is blocked and the month is not locked.',
    },
    C7: {
      what: 'Key amounts are calculated twice, by separate code, and both answers must agree.',
      example: 'A bug adds $50 to the insurance amortisation. The schedule and the entry agree with each other, so only an independent calculation can spot it.',
      how: 'A second, deliberately different piece of code recalculates prepaid amortisation, depreciation, loan interest and the cash received from card payouts from the raw data, then compares each with what was posted.',
      fails: 'Critical: the close is blocked and the month is not locked.',
    },
    C8: {
      what: 'Once a month is closed, it stays exactly as it was closed.',
      example: 'A sale in last quarter\'s books is edited after the reports were sent out. The reports no longer match the books.',
      how: 'When a month closes, the app stores a fingerprint (the period seal) of every entry: numbers, dates, accounts and amounts. Changing even one cent gives a different fingerprint. Each time the month is opened, the fingerprint is recalculated and compared with the stored one.',
      fails: 'Critical: the change is reported and the month can no longer pass its close until it is reopened properly.',
    },
  };

  // The evidence behind each control's result for the month on screen.
  function controlEvidence(id, r) {
    const ev = r.evidence || {};
    const tagName = tag => tag.replace('card-settlement', 'Card payout').replace('bank-fee', 'Bank fee').replace('bank-interest', 'Bank interest')
      .replace('cafe-waste', 'Café waste').replace('shrinkage', 'Book shrinkage').replace('accrual:', 'Accrual: ')
      .replace('prepaid:ins', 'Prepaid: insurance').replace('prepaid:sw', 'Prepaid: software').replace(/^dep:(.*)$/, (m, a) => 'Depreciation: ' + ((books.assets.find(x => x.id === a) || {}).name || a));
    switch (id) {
      case 'C1': return `<p>Re-added ${r.ledger.length} entries: ${books.entries.length} recorded and ${r.adjustments.length} month-end adjustments.</p>
        ${kv([['Trial balance debits', r.tb.totalDr], ['Trial balance credits', r.tb.totalCr], ['Difference', r.tb.totalDr - r.tb.totalCr, 'tot']])}`;
      case 'C2': return `<table class="t"><thead><tr><th>Close step</th><th class="r">Difference</th><th>Result</th></tr></thead><tbody>
        ${r.steps.filter(s => s.id !== 'close').map(s => `<tr><td>${esc(s.title)}</td><td class="r">${money(s.diff)}</td><td>${s.ok ? chip('Ties', 'ok') : chip('Does not tie', 'bad')}</td></tr>`).join('')}</tbody></table>`;
      case 'C3': {
        const tags = [...new Set(Object.keys(ev.expected || {}).concat(Object.keys(ev.actual || {})))];
        return `<table class="t"><thead><tr><th>Month-end entry</th><th class="r">Should exist</th><th class="r">Posted</th><th>Result</th></tr></thead><tbody>
          ${tags.map(t => { const e = (ev.expected || {})[t] || 0, a = (ev.actual || {})[t] || 0;
            return `<tr><td>${esc(tagName(t))}</td><td class="r">${e}</td><td class="r">${a}</td><td>${e === a ? chip('Complete', 'ok') : chip(a < e ? 'Missing' : e ? 'Duplicate' : 'Unexpected', 'bad')}</td></tr>`; }).join('')}</tbody></table>`;
      }
      case 'C4': {
        const prev = M.shiftPeriod(r.period, -1);
        return `<table class="t"><thead><tr><th>Asset</th><th class="r">Life used before this month</th><th class="r">Depreciation this month</th><th>Result</th></tr></thead><tbody>
          ${books.assets.map(a => {
            const used = Math.min(Math.max(M.monthIndex(prev) - M.monthIndex(a.inService), 0), a.life);
            const dep = r.adjustments.filter(j => j.tag === 'dep:' + a.id).reduce((t, j) => t + j.lines.filter(l => l.acct === '6500').reduce((u, l) => u + l.dr - l.cr, 0), 0);
            const bad = dep > 0 && used >= a.life;
            return `<tr><td>${esc(a.name)}</td><td class="r">${used} of ${a.life} months</td><td class="r">${money(dep)}</td><td>${bad ? chip('Past its life', 'bad') : used >= a.life ? chip('Fully depreciated', 'info') : chip('Within life', 'ok')}</td></tr>`;
          }).join('')}</tbody></table>`;
      }
      case 'C5': return `<table class="t"><thead><tr><th>Expense</th><th class="r">Last month</th><th class="r">This month</th><th class="r">Change</th><th>Result</th></tr></thead><tbody>
        ${r.flux.map(x => `<tr><td>${esc(x.name)}</td><td class="r">${money(x.prior)}</td><td class="r">${money(x.cur)}</td><td class="r">${x.pct === null ? '–' : (x.pct > 0 ? '+' : '') + x.pct.toFixed(1) + '%'}</td><td>${x.status === 'OK' ? chip('Normal', 'muted') : x.status === 'Explained' ? chip('Explained', 'info') : chip('Needs explaining', 'warn')}</td></tr>`).join('')}</tbody></table>`;
      case 'C6': { const st = r.statements;
        return kv([['Total assets', st.totalAssets], ['Total liabilities', st.totalLiabilities], ['Total equity, including this month\'s profit', st.totalEquity], ['Assets minus liabilities and equity', st.bsDiff, 'tot']]); }
      case 'C7': return `<table class="t"><thead><tr><th>Amount</th><th class="r">Posted</th><th class="r">Recalculated independently</th><th>Result</th></tr></thead><tbody>
        ${(ev.shadowChecks || []).map(c => `<tr><td>${esc(c.label.charAt(0).toUpperCase() + c.label.slice(1))}</td><td class="r">${money(c.posted)}</td><td class="r">${money(c.shadow)}</td><td>${c.posted === c.shadow ? chip('Agrees', 'ok') : chip('Disagrees', 'bad')}</td></tr>`).join('')}</tbody></table>`;
      case 'C8': return state.lock
        ? kv([['Seal stored when the month closed', `<code>${esc(state.lock.inputHash)}</code>`], ['Seal recalculated now', `<code>${esc(r.lock.inputHash)}</code>`],
            ['Closed-ledger seal stored when the month closed', `<code>${esc(state.lock.ledgerHash)}</code>`],
            ['Closed-ledger seal recalculated now', `<code>${esc(r.lock.ledgerHash)}</code>`],
            ['Result', r.controlStatus.C8 === 'PASS' ? chip('Unchanged since closing', 'ok') : chip('Changed after closing', 'bad')]])
        : `<p>This month is not locked, so there is nothing to compare yet. If it closes cleanly, its seal will be <code>${esc(r.lock.inputHash)}</code>.</p>`;
      default: return '';
    }
  }

  function viewControls() {
    const r = result;
    const statusOf = id => (!r ? 'none' : r.controlStatus[id]);
    const statusChip = id => ({ none: chip('Not run', 'muted'), PASS: chip('Pass', 'ok'), WARN: chip('Warning', 'warn'), FAIL: chip('Fail', 'bad') })[statusOf(id)];
    const summary = !r
      ? `<p>The controls run when you close ${M.periodLabel(state.period)}. Close the month to see each result and the evidence behind it.</p>
         <div class="row"><button class="btn primary" data-act="tab" data-tab="close">Open the month-end close</button></div>`
      : `<p>${M.periodLabel(state.period)}: ${M.CONTROLS.filter(c => statusOf(c.id) === 'PASS').length} of 8 passed${r.counts.warn ? `, ${r.counts.warn} warning${r.counts.warn === 1 ? '' : 's'} to explain` : ''}${r.counts.crit ? `, ${r.counts.crit} critical finding${r.counts.crit === 1 ? '' : 's'}` : ''}. Open a control to see how it checks and the evidence behind its result.</p>`;
    let out = `<div class="card control-intro">
      <h3>The eight controls</h3>
      <p class="muted">After the nine close steps, eight controls re-check the finished books. Each one is built to catch a classic month-end mistake, and each checks independently of the code that made the entries.</p>
      <dl class="status-key">
        <dt>${chip('Not run', 'muted')}</dt><dd>The month has not been closed yet.</dd>
        <dt>${chip('Pass', 'ok')}</dt><dd>Nothing wrong was found.</dd>
        <dt>${chip('Warning', 'warn')}</dt><dd>Something unusual needs a written explanation; the close still goes ahead.</dd>
        <dt>${chip('Fail', 'bad')}</dt><dd>A critical problem: the close is blocked and the month is not locked.</dd>
      </dl>
      ${summary}</div>
      <div class="controls">`;
    for (const c of M.CONTROLS) {
      const h = CONTROL_HELP[c.id] || {};
      const own = r ? r.findings.filter(f => f.control === c.id) : [];
      const openByDefault = r && (statusOf(c.id) === 'FAIL' || statusOf(c.id) === 'WARN');
      out += `<details class="control ${r ? statusOf(c.id).toLowerCase() : 'none'}" ${openByDefault ? 'open' : ''}>
        <summary><span class="cid">${c.id}</span><span class="cname"><b>${esc(c.name)}</b><span class="muted">${esc(c.blocks)}</span></span>${statusChip(c.id)}</summary>
        <div class="control-body">
          <dl class="explain">
            <dt>What it checks</dt><dd>${esc(h.what)}</dd>
            <dt>Example of the mistake</dt><dd>${esc(h.example)}</dd>
            <dt>How the app checks it</dt><dd>${esc(h.how)}</dd>
            <dt>If it fails</dt><dd>${esc(h.fails)}</dd>
          </dl>
          ${r ? `<div class="evidence">
            <h5>${M.periodLabel(state.period)}: the evidence</h5>
            ${own.length ? `<ul class="plain findings">${own.map(f => `<li>${sevChip(f.severity)} <b>${esc(f.message)}</b>. ${esc(f.detail)}</li>`).join('')}</ul>` : ''}
            <div class="scroll">${controlEvidence(c.id, r)}</div>
          </div>` : `<p class="hint">Close ${M.periodLabel(state.period)} to see this control's evidence.</p>`}
        </div>
      </details>`;
    }
    out += '</div>';
    return out + guardrailLab();
  }

  // ---------- guardrail demo: plant a mistake, see what it would do, see what stops it ----------
  const FAULT_STORY = {
    unbalanced_entry: { name: 'Unbalanced entry', story: 'A supplies purchase is keyed by hand with the debit $10.00 more than the credit. It happens with manual entries and badly rounded imports.' },
    opening_typo: { name: 'Wrong opening cash', story: 'Last month\'s closing cash is carried into this month as $500.00 too much, a typo made when the new month is opened.' },
    bank_fee_missed: { name: 'Bank fee not recorded', story: 'Nobody books the bank\'s $15.00 monthly service fee. It only appears on the bank statement, so it is easy to miss.' },
    wrong_tax: { name: 'Sale taxed at the wrong rate', story: 'One day\'s book sales are charged 7% sales tax instead of 8%, for example after a till is set up wrongly.' },
    missing_accrual: { name: 'Wages accrual forgotten', story: 'The wages staff earned since the last payroll are never accrued. They will be paid next month, but they belong to this one.' },
    dead_asset: { name: 'Used-up asset still depreciating', story: "The POS terminals (written off in February) and the old cash register (written off in 2024) are both used up, but a copied formula gives them another month of depreciation." },
    double_rent: { name: 'Rent entered twice', story: 'The month\'s $4,000.00 rent payment is entered twice.' },
    tampered_amount: { name: 'Amount altered by a bug', story: 'A bug in the posting code adds $50.00 to the insurance amortisation. The schedule and the entry agree with each other, so nothing looks wrong.' },
    edited_after_lock: { name: 'Closed month edited', story: 'After the month is closed and locked, someone quietly adds $1.00 to one day\'s cash sales.' },
  };
  // Rows that tell each story; faults not listed show every figure that changed.
  const FAULT_ROWS = { unbalanced_entry: ["tbDiff", "bsDiff"], opening_typo: ["cash", "bsDiff"], wrong_tax: ["salesTax", "cash"] };
  const IMPACT_ROWS = [
    ['netIncome', 'Profit (net income)'], ['expenses', 'Total expenses'], ['cash', 'Cash in the books'],
    ['salesTax', 'Sales tax owed to the state'], ['tbDiff', 'Debits minus credits'], ['bsDiff', 'Balance sheet difference'],
  ];
  // One sentence on what the mistake would have done to the books if nobody had noticed.
  function impactSentence(id, base, bad) {
    const d = k => bad[k] - base[k];
    if (id === "opening_typo") return `The balance sheet would be out by ${M.usd(Math.abs(d("bsDiff")))} from the first day of the month, and cash in the books would be ${M.usd(Math.abs(d("cash")))} too high.`;
    if (id === 'edited_after_lock') return `The month's figures would change after its reports were produced, so what was reported no longer matches the books. Profit moves by ${M.usd(Math.abs(d('netIncome')))}.`;
    if (d('tbDiff')) return `The books would not balance: debits would exceed credits by ${M.usd(Math.abs(d('tbDiff')))}, so every report built on them is unreliable.`;
    if (d('bsDiff')) return `The balance sheet would be out by ${M.usd(Math.abs(d('bsDiff')))} from the first day of the month.`;
    if (d('salesTax')) return `The shop would owe the state ${M.usd(Math.abs(d('salesTax')))} more than its books show, a shortfall that surfaces at the next tax audit.`;
    if (d('netIncome')) return `Profit would be ${d('netIncome') > 0 ? 'overstated' : 'understated'} by ${M.usd(Math.abs(d('netIncome')))}${d('cash') ? `, and cash in the books would be ${M.usd(Math.abs(d('cash')))} too ${d('cash') > 0 ? 'high' : 'low'}` : ''}.`;
    return 'The figures would look normal, which is exactly why this mistake needs a control.';
  }
  // Which finding in the real close shows each planted mistake was caught.
  const FLAG_BY = {
    unbalanced_entry: /Entry .* does not balance|Trial balance/, opening_typo: /Balance sheet/, bank_fee_missed: /Bank reconciliation/,
    wrong_tax: /Sales tax/, missing_accrual: /wages/i, dead_asset: /./, double_rent: /^Rent/, tampered_amount: /insurance/i, edited_after_lock: /./,
  };
  const cleanState = () => ({ ...state, events: state.planted.backup.events, countOverride: state.planted.backup.countOverride });
  function guardrailLab() {
    const month = M.periodLabel(state.period);
    const pl = state.planted;
    if (!pl) {
      const can = !!state.mode;
      return `<div class="card lab"><div class="card-head"><div><h3>Guardrail demo: plant nine mistakes and watch the close flag them</h3>
          <p class="muted lab-intro">Controls only count if they catch real mistakes. This plants nine classic mistakes into your own ${month} books: some of your transactions are changed or duplicated, and a few faults are switched on in the close. Then the close runs and the controls flag them. You will see exactly what changes and confirm first, and one click puts your books back as they were.</p></div>
          <button class="btn primary" data-act="plant-open" ${can ? '' : 'disabled'}>Plant the nine mistakes</button></div>
        ${can ? '' : `<p class="hint">Record or generate ${month} first: the mistakes are planted into its transactions.</p>`}
        <ol class="lab-preview">${M.FAULTS.map(f => `<li>${esc(FAULT_STORY[f.id].name)} <span class="muted">· ${f.expect}</span></li>`).join('')}</ol></div>`;
    }
    const run = result;
    if (!run) return `<div class="card lab"><p>The planted month could not be closed. <button class="btn" data-act="plant-remove">Remove the mistakes</button></p></div>`;
    if (!ui.demo) ui.demo = M.plantedDemo(cleanState(), priorSnap);
    const base = ui.demo.results[0];
    const faults = M.FAULTS.map(f => ({
      ...f,
      flag: run.findings.find(x => x.control === f.expect && x.severity !== 'INFO' && FLAG_BY[f.id].test(x.message)) || null,
      solo: ui.demo.results.find(r => r.id === f.id),
    }));
    const pick = faults.find(x => x.id === ui.demoPick) || faults[0];
    const flagged = faults.filter(x => x.flag).length;
    const loud = run.findings.filter(x => x.severity !== 'INFO').length;
    const head = `<div class="card-head"><div><h3>Guardrail demo: nine mistakes planted in ${month}</h3>
        <p class="muted lab-intro">Your transactions were changed and the close was run with the faults switched on. Pick a mistake to see what was changed, what it would have done to your figures, and which control flagged it.</p></div>
        <button class="btn" data-act="plant-remove">Remove the mistakes</button></div>`;
    const summary = `<div class="verdict-banner ${flagged === faults.length ? 'ok' : 'bad'}"><b>${flagged} of ${faults.length} mistakes flagged</b>
      <span>The close raised ${loud} findings and is ${run.counts.crit ? 'blocked' : 'not blocked'}: ${month} ${run.counts.crit ? 'cannot be locked until the mistakes are fixed' : 'could be locked'}. Every finding is listed in the controls register above.</span></div>`;
    const list = faults.map(x => `<li><button class="lab-item ${x.id === pick.id ? 'on' : ''} ${x.flag ? 'caught' : 'missed'}" data-act="demo-pick" data-id="${x.id}" ${x.id === pick.id ? 'aria-current="true"' : ''}>
        <span class="lab-name">${esc(FAULT_STORY[x.id].name)}</span>
        <span class="lab-by">${x.flag ? `Flagged by ${x.expect}` : 'Not flagged'}</span></button></li>`).join('');
    const ctl = M.CONTROLS.find(c => c.id === pick.expect) || { name: '' };
    const solo = pick.solo.metrics;
    const rows = IMPACT_ROWS.filter(([k]) => solo[k] !== base.metrics[k] && (!FAULT_ROWS[pick.id] || FAULT_ROWS[pick.id].includes(k)));
    const table = rows.length ? `<table class="t impact"><thead><tr><th></th><th class="r">Your month</th><th class="r">With this mistake</th><th class="r">Difference</th></tr></thead><tbody>
      ${rows.map(([k, label]) => `<tr><td>${label}</td><td class="r">${money(base.metrics[k])}</td><td class="r">${money(solo[k])}</td><td class="r">${money(solo[k] - base.metrics[k])}</td></tr>`).join('')}</tbody></table>` : '';
    const others = pick.solo.also.map(id => { const c = M.CONTROLS.find(x => x.id === id); return c ? `${id} ${c.name}` : id; });
    const outcome = pick.flag && pick.flag.severity === 'CRITICAL'
      ? `<p class="outcome bad">On its own, this blocks the close: the month cannot be locked until it is fixed.</p>`
      : `<p class="outcome warn">On its own, the close is allowed with a warning: someone must explain the movement before the month is signed off.</p>`;
    const panel = `<div class="lab-panel">
      <h4>${esc(FAULT_STORY[pick.id].name)}</h4>
      <p class="lab-story">${esc(FAULT_STORY[pick.id].story)}</p>
      <h5>What is changed in your books</h5>
      <p>${esc(pl.changes[pick.id] || '')}</p>
      <h5>If nobody noticed</h5>
      <p>${esc(impactSentence(pick.id, base.metrics, solo))}</p>
      ${table ? `<div class="scroll">${table}</div>` : ''}
      <h5>What flagged it</h5>
      ${pick.flag
        ? `<p><b>${pick.expect} ${esc(ctl.name)}</b> reported: ${esc(pick.flag.message)}.${pick.flag.detail ? ` <span class="muted">${esc(pick.flag.detail)}</span>` : ''}</p>${outcome}`
        : `<p class="outcome bad">Not flagged: ${pick.expect} ${esc(ctl.name)} should have reported this.</p>`}
      ${others.length ? `<p class="hint">On its own it also trips ${esc(others.join(' and '))}. Real mistakes usually trip more than one control, which is why they are layered.</p>` : ''}
    </div>`;
    return `<div class="card lab">${head}${summary}<div class="lab-grid"><ol class="lab-list">${list}</ol>${panel}</div></div>`;
  }

  // ---------- CSV ----------
  function download(name, rows) {
    const csv = rows.map(r => r.map(v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(',')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  const dollars = c => (c / 100).toFixed(2);
  // The Excel library is ~1 MB, so it loads only when someone asks for a workbook.
  let excelJsPromise = null;
  function loadExcelJS() {
    if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
    excelJsPromise = excelJsPromise || new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/exceljs.min.js';
      s.onload = () => (window.ExcelJS ? resolve(window.ExcelJS) : reject(new Error('ExcelJS did not load')));
      s.onerror = () => { excelJsPromise = null; reject(new Error('could not load vendor/exceljs.min.js')); };
      document.head.appendChild(s);
    });
    return excelJsPromise;
  }

  // ---------- actions ----------
  function addEvent(ev) {
    state.events.push(Object.assign({ id: 'u' + state.nextId++, source: 'user' }, ev));
  }
  function commitCount(el) {
    const hint = document.getElementById('count-hint');
    if (el.value === el.defaultValue) return true; // untouched – keep whatever is in effect
    const raw = el.value.trim();
    const c = raw ? M.parseCents(raw) : null;
    if (raw && !(c >= 0)) { if (hint) hint.textContent = 'Enter the counted value like 41,250.00'; return false; }
    if (c === state.countOverride) return true;
    state.countOverride = c;
    ui.lastRun = null; ui.demo = null; save();
    if (hint) hint.textContent = c === null ? 'Using the suggested count.' : `Your count: ${M.usd(c)}. Run the close to apply it.`;
    return true;
  }
  const ACTIONS = {
    tab: b => { ui.tab = b.dataset.tab; render(); },
    generate: () => {
      const seed = parseInt(document.getElementById('seed').value, 10) || 2026;
      const g = M.generateMonth(state.period, seed, M.opening(state.period, priorSnap));
      Object.assign(state, { seed, mode: 'generated', events: g.events, shrinkBps: g.shrinkBps, cafeWasteBps: g.cafeWasteBps, countOverride: null, lock: null, nextId: 1 });
      ui.tab = 'txns';
      changed(`Generated ${g.events.length} transactions for ${M.periodLabel(state.period)}. Add your own below, edit any amount, or head to Month-End Close.`);
    },
    manual: () => {
      Object.assign(state, { mode: 'manual', events: [], shrinkBps: 50, countOverride: null, lock: null, nextId: 1 });
      ui.tab = 'txns';
      changed('Empty month started. Pick a day and a transaction, type your amount, and click Add.');
    },
    'mj-add-line': () => { (ui.manual || (ui.manual = blankManual())).lines.push({ acct: '', dr: '', cr: '' }); render(); },
    'mj-remove-line': b => { if (ui.manual && ui.manual.lines.length > 2) ui.manual.lines.splice(Number(b.dataset.i), 1); render(); },
    'mj-post': () => {
      const r = readManual();
      if (r.error) { updateManualTotals(); return; }
      addEvent(r.ev);
      ui.manual = blankManual();
      changed(`Posted a manual journal entry on ${M.shortDate(r.ev.date)} for ${M.usd(r.ev.amount)}: ${r.ev.memo}.`);
    },
    add: () => {
      const r = readBuilder();
      if (!r || r.error) { updatePreview(); return; }
      addEvent(r.ev);
      ui.draft = null;
      changed(`Added:${M.TEMPLATES[r.ev.type].label} on ${M.shortDate(r.ev.date)} for ${M.usd(r.ev.amount)}.`);
    },
    'quick-day': () => {
      const d = ui.date;
      [['book_sale', 110000, 'card'], ['book_sale', 42000, 'cash'], ['cafe_sale', 16000, 'card'], ['cafe_sale', 9000, 'cash']]
        .forEach(([type, amount, method]) => addEvent({ date: d, type, amount, method }));
      changed(`Added a typical sales day on ${M.shortDate(d)} (4 transactions). Edit any amount in the journal.`);
    },
    'quick-bills': () => {
      const s = M.SETUP, p = state.period, day = n => p + '-' + String(n).padStart(2, '0');
      const has = (type, date) => state.events.some(e => e.type === type && e.date === date);
      let added = 0;
      const put = (type, date, props) => { if (!has(type, date)) { addEvent(Object.assign({ date, type }, props)); added++; } };
      put('rent', day(1), { amount: s.rent });
      put('supplies', day(3), { amount: 28000 });
      put('interest_payment', day(5), { amount: M.monthlyInterest(s.loan) });
      const op = books.opening;
      if (op.ap > 0) put('vendor_payment', day(10), { amount: op.ap, vendor: 'Various (last month)' });
      put('utility_bill', day(12), { amount: 86000 });
      put('supplies', day(17), { amount: 28000 });
      if (op.salesTax > 0) put('sales_tax_remittance', day(20), { amount: op.salesTax });
      for (let d = M.addDays(op.lastPayroll, 14); d <= M.periodEnd(p); d = M.addDays(d, 14)) put('payroll', d, { amount: M.payrollDefault(state, d, op) });
      changed(added ? `Added ${added} usual bills and payroll runs. Change any amount with "Edit amount".` : 'The usual bills are already in the journal.');
    },
    del: b => { state.events = state.events.filter(e => e.id !== b.dataset.id); changed('Transaction deleted.'); },
    edit: b => { ui.editing = b.dataset.id; render(); const el = document.getElementById('edit-amt'); if (el) { el.focus(); el.select(); } },
    'edit-cancel': () => { ui.editing = null; render(); },
    'edit-save': b => {
      const c = M.parseCents(document.getElementById('edit-amt').value);
      if (!(c > 0)) { ui.flash = 'Enter a positive amount like 1,250.00'; render(); return; }
      const ev = state.events.find(e => e.id === b.dataset.id);
      if (ev) ev.amount = c;
      ui.editing = null;
      changed(`Amount updated to ${M.usd(c)}.`);
    },
    toggle: b => { const id = b.dataset.id; ui.open.has(id) ? ui.open.delete(id) : ui.open.add(id); render(); },
    run: () => {
      const countEl = document.querySelector('[data-chg="count"]');
      if (countEl && !commitCount(countEl)) return;
      recompute();
      const pl = state.planted;
      const res = pl ? M.runClose(books, { faults: pl.close, lock: pl.seal }) : M.runClose(books);
      if (res.counts.crit === 0 && !pl) { state.lock = res.lock; ui.lastRun = null; save(); } else ui.lastRun = res; // a month with planted mistakes is never locked
      render();
      // Automated: a successful close writes its own commentary and recommendations straight away.
      if (res.counts.crit === 0 && !pl && !(result && currentCommentary(result))) {
        if (ui.ai && ui.ai.configured) ACTIONS['commentary-ai'](null, { fallback: true });
        else ACTIONS['commentary-template']();
      }
    },
    'commentary-ai': async (b, opts = {}) => {
      if (!result || ui.commentaryBusy) return;
      const r = result, facts = M.commentaryFacts(r, books);
      ui.commentaryBusy = true; ui.commentaryError = null; render();
      try {
        const resp = await fetch('/api/commentary', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ facts }) });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.error || `Request failed (HTTP ${resp.status})`);
        state.commentary = { seal: r.lock.ledgerHash, text: data.text, source: 'groq', model: data.model, at: Date.now() };
        save();
      } catch (e) {
        if (opts.fallback) {
          state.commentary = { seal: r.lock.ledgerHash, text: M.templateCommentary(facts, M.commentaryMetrics(r, books)), source: 'template', model: null, at: Date.now() };
          save();
          ui.commentaryError = `AI unavailable (${e.message}) — showing the rule-based version instead.`;
        } else {
          ui.commentaryError = 'Could not generate commentary: ' + e.message;
        }
      }
      ui.commentaryBusy = false; render();
    },
    'commentary-template': () => {
      if (!result) return;
      state.commentary = { seal: result.lock.ledgerHash, text: M.templateCommentary(M.commentaryFacts(result, books), M.commentaryMetrics(result, books)), source: 'template', model: null, at: Date.now() };
      ui.commentaryError = null; save(); render();
    },
    'commentary-copy': async () => {
      const c = result && currentCommentary(result);
      if (!c) return;
      try { await navigator.clipboard.writeText(c.text); ui.flash = 'Commentary copied to the clipboard.'; } catch (e) { ui.flash = 'Copy failed — select the text and copy it manually.'; }
      render();
    },
    reopen: () => {
      const next = nextPeriod(state.period);
      if (next && wb.months[next] && wb.months[next].lock) {
        ui.flash = `${M.periodLabel(next)} is closed and was opened from this month's balances. Reopen ${M.periodLabel(next)} first, working back one month at a time.`;
        render(); return;
      }
      state.lock = null; state.commentary = null;
      const later = next && wb.months[next] && wb.months[next].mode;
      changed(`${M.periodLabel(state.period)} reopened. Make your changes, then run the close again.${later ? ` ${M.periodLabel(next)}'s opening balances will follow whatever this month closes at.` : ''}`);
    },
    goto: b => { goToMonth(b.dataset.period); render(); },
    'next-month': () => { const n = nextPeriod(state.period); if (n) { goToMonth(n); ui.tab = monthStatus(n) === 'Not started' ? 'overview' : ui.tab; render(); } },
    'fs-view': b => { ui.fsView = b.dataset.view; render(); },
    'fs-year': () => { ui.tab = 'fs'; ui.fsView = 'year'; render(); },

    // ---------- start fresh: erase the whole book after a confirmation ----------
    'fresh-open': () => {
      const dlg = document.getElementById('fresh-dialog');
      const months = Object.values(wb.months).filter(ms => ms.mode);
      const closedN = months.filter(ms => ms.lock).length;
      const entries = months.reduce((t, ms) => t + ms.events.length, 0);
      const what = months.length
        ? `<ul class="plain">
             <li>${months.length} month${months.length === 1 ? '' : 's'} of books, ${closedN} of them closed and locked</li>
             <li>${entries.toLocaleString('en-US')} recorded transactions, including any you typed or edited</li>
             <li>Stock counts, month-end commentary and AI recommendations</li>
           </ul>`
        : '<p>There is nothing recorded yet, so there is nothing to erase.</p>';
      dlg.innerHTML = `
        <form method="dialog" class="confirm-body">
          <h2 id="fresh-title">Start FY ${M.YEAR} from a blank book?</h2>
          <p>This erases everything saved in this browser for Quincy Bookstore:</p>
          ${what}
          <p class="confirm-note">This can't be undone. Download the Excel workbook first if you want to keep a copy.</p>
          <div class="confirm-actions">
            <button class="btn" value="cancel" autofocus>Keep my books</button>
            <button class="btn danger" type="button" data-act="fresh-confirm" ${months.length ? '' : 'disabled'}>Erase and start fresh</button>
          </div>
        </form>`;
      dlg.showModal();
    },
    'fresh-confirm': () => {
      document.getElementById('fresh-dialog').close();
      wb = { current: M.PERIODS[0], months: {} };
      cache.clear();
      state = monthState(wb.current);
      Object.assign(ui, { tab: 'overview', fsView: 'month', lastRun: null, demo: null, editing: null, confirm: null, date: null, commentaryError: null });
      ui.open.clear();
      save();
      window.scrollTo(0, 0);
      changed(`Started fresh: FY ${M.YEAR} is a blank book. Choose how to fill January.`);
    },
    'generate-year': () => {
      if (ui.confirm !== 'year') { ui.confirm = 'year'; render(); return; }
      ui.confirm = null;
      const seed = parseInt((document.getElementById('seed') || {}).value, 10) || state.seed || 2026;
      let prior = null, done = 0, stopped = null;
      wb.months = {}; cache.clear();
      for (const p of M.PERIODS) {
        const g = M.generateMonth(p, seed, M.opening(p, prior));
        const ms = Object.assign(fresh(p), { seed, mode: 'generated', events: g.events, shrinkBps: g.shrinkBps, cafeWasteBps: g.cafeWasteBps });
        wb.months[p] = ms;
        const out = M.closeMonth(ms, prior);
        if (!out.snapshot) { stopped = p; break; }
        ms.lock = out.result.lock; prior = out.snapshot; done++;
      }
      goToMonth(stopped || M.PERIODS[M.PERIODS.length - 1]);
      ui.tab = 'fs'; ui.fsView = 'year';
      changed(stopped
        ? `Closed ${done} months; ${M.periodLabel(stopped)} was blocked by a critical finding — open it to see why.`
        : `Generated and closed all 12 months of FY ${M.YEAR} (seed ${seed}). Each month opened from the previous month's close.`);
    },
    'count-reset': () => { state.countOverride = null; changed(); },
    // ---------- guardrail demo: plant the nine mistakes into this month, after a warning ----------
    'plant-open': () => {
      const month = M.periodLabel(state.period), next = nextPeriod(state.period);
      if (!state.mode || state.planted) return;
      if (locked() && next && wb.months[next] && wb.months[next].lock) {
        ui.flash = `${month} can't take planted mistakes while ${M.periodLabel(next)} is closed on top of it. Reopen ${M.periodLabel(next)} first, or try the demo on the latest month.`;
        render(); return;
      }
      const preview = M.plantFaults(state.period, state.events);
      const dlg = document.getElementById('plant-dialog');
      dlg.innerHTML = `
        <form method="dialog" class="confirm-body">
          <h2 id="plant-title">Plant nine mistakes in ${month}'s books?</h2>
          <p>This is a demonstration of the controls, and it changes your own books:</p>
          <ol class="plant-list">${M.FAULTS.map(f => `<li><b>${esc(FAULT_STORY[f.id].name)}.</b> ${esc(preview.changes[f.id])}</li>`).join('')}</ol>
          <p>Then the close runs and the controls flag the mistakes. While they are planted, ${month} cannot be closed${locked() ? `, so the month is reopened now` : ''}.</p>
          <p class="confirm-note">Your original transactions are kept. "Remove the mistakes" puts ${month} back exactly as it is now${locked() ? ', closed and locked,' : ''} and discards anything you change in the meantime.</p>
          <div class="confirm-actions">
            <button class="btn" value="cancel" autofocus>Cancel</button>
            <button class="btn danger" type="button" data-act="plant-confirm">Plant the mistakes</button>
          </div>
        </form>`;
      dlg.showModal();
    },
    'plant-confirm': () => {
      document.getElementById('plant-dialog').close();
      recompute();
      if (!books) return;
      const demo = M.plantedDemo(state, priorSnap); // the clean month, and each mistake on its own
      const pl = M.plantFaults(state.period, state.events);
      state.planted = {
        backup: { events: state.events, countOverride: state.countOverride, lock: state.lock, commentary: state.commentary || null },
        build: pl.build, close: pl.close, changes: pl.changes,
        seal: state.lock || demo.cleanLock, // the month as sealed before anyone touched it
      };
      Object.assign(state, { events: pl.events, lock: null, commentary: null });
      ui.lastRun = null; ui.demo = demo; ui.demoPick = M.FAULTS[0].id; ui.tab = 'controls';
      ui.flash = `Planted nine mistakes in ${M.periodLabel(state.period)} and ran the close. Every red finding below is a control catching one of them.`;
      save(); render();
      window.scrollTo(0, 0);
    },
    'plant-remove': () => {
      const pl = state.planted;
      if (!pl) return;
      Object.assign(state, { events: pl.backup.events, countOverride: pl.backup.countOverride, lock: pl.backup.lock, commentary: pl.backup.commentary });
      delete state.planted;
      if (!state.commentary) delete state.commentary;
      changed(`Mistakes removed. ${M.periodLabel(state.period)} is back exactly as it was${state.lock ? ', closed and locked' : ''}.`);
    },
    'demo-pick': b => {
      if (!state.planted) return;
      ui.demoPick = b.dataset.id;
      render();
      const panel = document.querySelector('.lab-panel');
      if (panel && window.matchMedia('(max-width: 900px)').matches) panel.scrollIntoView({ block: 'start' });
    },
    reset: () => {
      if (ui.confirm !== 'reset') { ui.confirm = 'reset'; render(); return; }
      ui.confirm = null; wb.months[state.period] = fresh(state.period); state = monthState(state.period); ui.tab = 'overview'; changed('Cleared. Choose how to fill the month.');
    },
    'csv-journal': () => {
      const rows = [['Entry', 'Date', 'Description', 'Source', 'Account', 'Account name', 'Debit', 'Credit']];
      for (const je of books.entries.concat(result ? result.adjustments : [])) for (const l of je.lines) rows.push([je.id, je.date, je.memo, je.source, l.acct, M.acct(l.acct).name, dollars(l.dr), dollars(l.cr)]);
      download(`journal-${state.period}.csv`, rows);
    },
    'csv-tb': () => {
      const tb = M.trialBalance(result ? result.ledger : books.entries);
      download(`trial-balance-${state.period}.csv`, [['Account', 'Name', 'Debit', 'Credit']].concat(tb.rows.map(r => [r.code, r.name, dollars(r.dr), dollars(r.cr)]), [['', 'Total', dollars(tb.totalDr), dollars(tb.totalCr)]]));
    },
    'csv-fs': () => {
      const st = M.statements(M.trialBalance(result ? result.ledger : books.entries));
      const rows = [['Statement', 'Line', 'Amount']];
      st.revenue.forEach(r => rows.push(['Income statement', r.name, dollars(r.amount)]));
      st.expenses.forEach(r => rows.push(['Income statement', r.name, dollars(-r.amount)]));
      rows.push(['Income statement', 'Net income', dollars(st.netIncome)]);
      st.assets.forEach(r => rows.push(['Balance sheet – assets', r.name, dollars(r.amount)]));
      st.liabilities.forEach(r => rows.push(['Balance sheet – liabilities', r.name, dollars(r.amount)]));
      st.equity.forEach(r => rows.push(['Balance sheet – equity', r.name, dollars(r.amount)]));
      rows.push(['Balance sheet – equity', 'Net income this month', dollars(st.netIncome)]);
      download(`statements-${state.period}.csv`, rows);
    },
    'xlsx-year': async () => {
      const { run } = closedRun(null);
      if (!run.length || ui.xlsxBusy) return;
      ui.xlsxBusy = true; render();
      try {
        const ExcelJS = await loadExcelJS();
        const wb = M.buildYearWorkbook(ExcelJS, run, M.yearStatements(run));
        const buffer = await wb.xlsx.writeBuffer();
        const last = run[run.length - 1].period;
        const name = run.length === 12 ? `Quincy-Bookstore-FY${M.YEAR}.xlsx` : `Quincy-Bookstore-FY${M.YEAR}-to-${last}.xlsx`;
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
        a.download = name; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        ui.flash = `Downloaded ${name}: Summary, Income Statement, Balance Sheet, Trial Balance, Journal and Close Log for ${run.length} closed month${run.length === 1 ? '' : 's'}.`;
      } catch (e) {
        ui.flash = 'Could not build the Excel file: ' + e.message;
      }
      ui.xlsxBusy = false; render();
    },
    'csv-year': () => {
      const y = M.yearStatements(closedRun(null).run);
      if (!y) return;
      const head = ['Line'].concat(y.months.map(m => M.periodLabel(m.period)), [`FY ${M.YEAR} total`]);
      const rows = [head].concat(yearIncomeRows(y).map(r => [r.label].concat(r.values.map(dollars), [dollars(r.total)])));
      download(`income-statement-FY${M.YEAR}.csv`, rows);
    },
  };
  const CHANGES = {
    period: el => { if (el.value !== state.period) { goToMonth(el.value); render(); } },
    btype: el => { ui.type = el.value; ui.draft = null; render(); },
    bdate: el => { // keep whatever was typed; only the day changes
      const root = document.getElementById('builder');
      ui.draft = root ? { type: ui.type, values: Object.fromEntries([...root.querySelectorAll('[name]')].map(x => [x.name, x.value])) } : null;
      ui.date = el.value; render();
    },
    filter: el => { ui.filter = el.value; render(); },
    source: el => { ui.source = el.value; render(); },
    // Saved without re-rendering: a re-render here fires on blur, i.e. in the middle of a click on
    // another button (e.g. Run close), replacing that button under the pointer and swallowing the click.
    count: el => { commitCount(el); },
  };

  document.addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    if (!['reset', 'generate-year'].includes(b.dataset.act)) ui.confirm = null; // two-click confirmations
    ACTIONS[b.dataset.act] && ACTIONS[b.dataset.act](b);
  });
  document.addEventListener('change', e => { const t = e.target; if (t.dataset && t.dataset.chg && CHANGES[t.dataset.chg]) CHANGES[t.dataset.chg](t); });
  document.addEventListener('input', e => {
    const t = e.target;
    if (t.dataset && (t.dataset.mj || t.dataset.mjLine)) { // manual entry: keep what was typed, refresh the totals
      const mj = ui.manual || (ui.manual = blankManual());
      if (t.dataset.mj) mj[t.dataset.mj] = t.value;
      else mj.lines[Number(t.dataset.mjLine)][t.dataset.mjField] = t.value;
      updateManualTotals();
      return;
    }
    if (t.closest && t.closest('#builder')) updatePreview();
  });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    if (e.target.id === 'edit-amt') document.querySelector('[data-act="edit-save"]')?.click();
    else if (e.target.closest && e.target.closest('#builder') && e.target.tagName === 'INPUT') ACTIONS.add();
  });

  render();
  fetch('/api/ai-status').then(r => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
    .then(s => { ui.ai = s; })
    .catch(() => { ui.ai = { configured: false, offline: true }; })
    .finally(render);
})();

# Bookstore Month-End Close Automation

A fictional bookstore, **Quincy Bookstore**. It records a month of transactions,
then **closes the books automatically**: it reconciles, posts adjusting entries,
produces financial statements and proves the result with eight controls.

Runs entirely in the browser. No build step, no dependencies. All money is held as
integer cents, and every journal entry must balance before it posts.

## Run it

```bash
node serve.js
```

Then open http://localhost:5173.

## Workflow

1. **Record the month.** Pick one or both:
   - **Generate**: a seeded, realistic month (daily book and café sales, returns,
     gift cards, publisher invoices, payroll, rent, bills). The same seed always gives
     the same month.
   - **Enter it yourself**: pick a day and a common transaction, type your own
     amount, and see the journal entry it creates before adding it. Any amount can be
     edited later, including generated ones. Beyond daily trading there are owner
     contributions and drawings, loan repayments, insurance or software renewals (which
     join the prepaid schedule and amortise in later months), returns to a publisher for
     credit, and write-offs of damaged stock.
   - **Manual journal entry**: for anything the list doesn't cover. Pick accounts line
     by line and type debits and credits; a running difference shows until they are
     equal. A description and a reason (the evidence) are required, the entry posts only
     when balanced, and it is marked **Manual** in the journal. Control accounts (card
     clearing, prepaids, accumulated depreciation, accruals, gift cards, sales tax,
     retained earnings) are not offered, because only their own transactions and the
     close may move them.
2. **Receive the month-end documents**: a bank statement, a card processor report and
   physical stock counts of books and café stock. All are derived from the month's activity, with
   realistic timing differences, a bank fee, shrinkage and café waste. The book count can be
   typed in by hand.
3. **Run the close.** Nine steps run in order, and each one must tie out:

   | # | Step | What it posts |
   |---|------|---------------|
   | 1 | Card processor settlements | Payouts net of 2.5% fees; unpaid card sales stay in clearing |
   | 2 | Bank reconciliation | Auto-matches bank lines to the books; books the fee and interest; lists items in transit |
   | 3 | Stock counts: books & café | Book shrinkage and café waste against the physical counts |
   | 4 | Prepaid amortization | Insurance and annual software |
   | 5 | Depreciation | Straight-line; stops at end of life |
   | 6 | Accruals | Wages since the last payroll, unbilled utilities, loan interest on the balance still owed |
   | 7 | Gift card liability | Sold − redeemed must equal the ledger |
   | 8 | Sales tax | 8% of taxable sales must equal the ledger |
   | 9 | Statements & lock | Trial balance, P&L, balance sheet; the period is sealed with a fingerprint |

4. **Prove it.** Eight controls check the result. Any CRITICAL finding blocks the
   close, and the month is not locked.

   | ID | Control | Catches |
   |----|---------|---------|
   | C1 | Balanced entries | Debits ≠ credits |
   | C2 | Reconciliations tie | Bank, card, inventory, schedules, gift cards or sales tax off |
   | C3 | Completeness | Month-end entry missing, duplicated or unexpected |
   | C4 | Asset-life guard | Fully depreciated asset still depreciating |
   | C5 | Fluctuation review | Expense moved >20% and >$100 vs last month (a warning) |
   | C6 | Balance sheet | Assets ≠ liabilities + equity |
   | C7 | Shadow recompute | An amount in the posting path disagrees with an independent recompute |
   | C8 | Period lock | A closed month was edited |

**Guardrail demo** (on the Controls tab): after a warning that lists every change, it plants
9 classic mistakes into your own month. Some of your transactions are changed or duplicated, and a
few faults are switched on in the opening and the close. Then it runs the close, so the controls
flag them in the real register. Planted transactions are tagged **Planted** in the journal, and a
month with planted mistakes can never be locked. For each mistake the demo shows what was changed,
what it would have done to your figures on its own, and which control flagged it. **Remove the
mistakes** restores the month exactly as it was, including its lock and seal.
(`python -m close_engine demo` still runs the original version on a separate generated copy.)

## Python engine

The accounting engine also exists in Python (`close_engine/`), producing **exactly the same results** as
the browser app: identical ledgers, trial balances and period seals in all 12 months.

```bash
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt

.venv\Scripts\python -m close_engine year --excel fy2026.xlsx   # close all 12 months, export to Excel
.venv\Scripts\python -m close_engine month --period 2026-03     # one month's close report
.venv\Scripts\python -m close_engine demo --period 2026-06      # plant 9 mistakes, show each caught
.venv\Scripts\python -m pytest                                  # 85 tests
node --test tests/test_lock.cjs                                 # period-lock tests on the browser engine
```

The same workbook is available in the browser: **Financial Statements → FY 2026 year to date → Download Excel**
builds it from exactly what is on screen (including your own transactions and edits). `js/excel.js` is the
browser twin of `close_engine/excel.py`, using ExcelJS served from `vendor/` (loaded only when you click).
`tests/test_excel_parity.py` builds both for the generated year and checks every cell of every sheet matches;
it needs Node and `npm install` (it is skipped otherwise).

- **Excel export**: Summary, Income Statement (12 months + FY total), Balance Sheet (1 Jan vs latest close),
  Trial Balance, Journal (every line of every entry) and Close Log. Totals and checks are live Excel formulas.
- **Tests**: parity with the JavaScript engine (from `tests/golden_fy2026.json`), double-entry rules,
  the month chain and close calendar, the guardrail demo in every month, and the Excel formulas.
- `tests/test_new_transactions.py` runs three chained months with the hand-entered transactions in
  `tests/extras_events.json` (owner, loan, renewals, returns, write-offs, manual entries) and checks
  both engines seal identical ledgers; it also checks control accounts are refused in manual entries.
- If you change the JavaScript engine, regenerate the references with
  `node tools/export_golden.js 2026 > tests/golden_fy2026.json` and
  `node tools/export_extras.js > tests/golden_extras.json`, and make the Python side match.

| Python module | Mirrors |
|---|---|
| `close_engine/core.py` | `js/core.js`: money, dates, seeded RNG, accounts, setup, schedules |
| `close_engine/books.py` | `js/books.js`: templates, generator, opening balances, ledger, documents |
| `close_engine/close.py` | `js/close.js`: nine close steps, controls, roll-forward, year, guardrail demo |
| `close_engine/excel.py` | `js/excel.js`: the six-sheet Excel workbook |
| `close_engine/cli.py` | Command line (Python only) |

## The financial year (FY 2026)

The books cover **January–December 2026**. January opens from the store's starting balances;
every later month opens from the **previous month's close**: cash, stock, payables, accruals (auto-reversed on
day 1), gift cards, card payouts still in transit, and checks or deposits the bank hasn't cleared yet.

- A month can start only after the previous month is closed, and a month can be reopened only if the
  month after it is still open, as in a real close calendar.
- **Generate & close FY 2026** builds all 12 months in order, closing and locking each one.
- **Financial Statements → FY 2026 year to date** shows a 12-column income statement with a full-year total,
  the balance sheet at 1 January vs the latest close, and year checks (equity roll-forward, balanced
  closing balance sheet, unbroken month chain, every month passing its controls).
- The fluctuation control (C5) now compares each month with the **actual** previous month.

## AI month-end commentary (Groq)

After a successful close, the Month-End Close tab offers a **Month-end commentary** card:
a short management summary written by an LLM on Groq from the closed figures.

- **Setup:** copy `.env.example` to `.env`, put your key in `GROQ_API_KEY`, then restart `node serve.js`.
  The key stays on the server; the browser never sees it. `GROQ_MODEL` defaults to `openai/gpt-oss-120b`.
- **Facts only:** the browser sends pre-formatted facts (statements, reconciliations, close results,
  expense changes). The prompt tells the model to copy numbers exactly and never compute new ones.
- **Number check:** every number in the reply is compared with the facts. Anything not found is
  highlighted, with a warning to review before sharing.
  The check confirms each number *exists* in the close; a person still confirms it is attached to the right label.
- **No key?** "Use template (no AI)" builds the same four-section summary deterministically.

## Deploy to Vercel

The whole app runs in the visitor's browser, so Vercel serves it as static files. The AI commentary
runs as two Vercel functions, `api/ai-status.js` and `api/commentary.js`, which do what `serve.js`
does locally. Both use `lib/ai.js`, so the prompt and the checks live in one place.

1. Import the GitHub repo in Vercel. Framework preset: **Other**. No build command or output directory is needed.
2. In **Settings → Environment Variables**, add `GROQ_API_KEY` (and optionally `GROQ_MODEL`), then redeploy.
3. Without a key the app still works; commentary falls back to the built-in template.

Each visitor's books are saved in their own browser. `.vercelignore` keeps the Python engine, tests
and tools out of the deployment. The commentary endpoint only accepts JSON from the site's own pages,
but anyone using the site spends your Groq quota, so use a free-tier key with no card attached.

## Files

| File | Purpose |
|------|---------|
| `js/core.js` | Money (cents), dates, seeded RNG, chart of accounts, store setup, schedules |
| `js/books.js` | Transaction templates, month generator, opening balances, ledger, month-end documents |
| `js/close.js` | The nine close steps, statements, controls, shadow recompute, fault injection |
| `js/ui.js` | Dashboard |
| `js/commentary.js` | Commentary facts, number check, template fallback |
| `serve.js` | Local server: serves the app and proxies commentary requests to Groq |
| `lib/ai.js` | The CFO prompt and the Groq call, shared by `serve.js` and the Vercel functions |
| `api/` | Vercel functions for the AI commentary |

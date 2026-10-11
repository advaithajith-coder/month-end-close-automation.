# CLAUDE.md

Guide for Claude Code working in this repository. Keep it short and current: if you learn
something non-obvious about this project, add it here.

## What this is

Quincy Bookstore month-end close: a fictional bookstore records a month of transactions, then
closes the books automatically (reconciliations, adjusting entries, financial statements, eight
controls, period lock). Live at https://month-end-close-automation-lo3m.vercel.app.

The accounting engine exists **twice and must stay identical**:
- **Browser app** (the product): plain JavaScript, no build step, no framework.
- **Python port** (`close_engine/`): same results, plus CLI and Excel export. Tests prove parity.

## Commands

```bash
node serve.js                                   # http://localhost:5173 (also proxies AI commentary)
python -m pytest                                # Python tests (parity, ledger, controls, Excel)
node --test tests/test_lock.cjs                 # period-lock tests on the browser engine
npm install                                     # only needed for tests/test_excel_parity.py (ExcelJS)
python -m close_engine year --excel fy2026.xlsx # close all 12 months to Excel
```

Python setup: `python -m venv .venv` then `.venv\Scripts\python -m pip install -r requirements.txt`.
CI (`.github/workflows/ci.yml`) runs `pytest` and `test_lock.cjs` on every PR; keep it green.

## Layout

| Browser (JS) | Python twin | Contents |
|---|---|---|
| `js/core.js` | `close_engine/core.py` | money (cents), dates, seeded RNG, accounts, setup, schedules |
| `js/books.js` | `close_engine/books.py` | transaction templates, month generator, opening balances, ledger |
| `js/close.js` | `close_engine/close.py` | nine close steps, statements, controls C1–C8, guardrail demo |
| `js/excel.js` | `close_engine/excel.py` | six-sheet Excel workbook (ExcelJS from `vendor/`) |
| `js/ui.js`, `js/commentary.js` | — | dashboard UI (state in `localStorage`), AI commentary facts + number check |

- `index.html` loads the scripts in order with plain `<script>` tags; modules attach to the global `window.MEC`.
- `serve.js` (local) and `api/*.js` (Vercel functions) both use `lib/ai.js` for the Groq prompt/call.
- `tools/` regenerates golden files; `tests/` holds Python tests plus `test_lock.cjs`.

## Rules that matter

- **Money is integer cents** everywhere (JS and Python). Never floats for amounts.
- **Every journal entry must balance** before it posts. Control accounts are never offered for manual entries.
- **Parity:** if you change engine logic in `js/`, make the same change in `close_engine/`, then regenerate references and run the tests:
  `node tools/export_golden.js 2026 > tests/golden_fy2026.json` and `node tools/export_extras.js > tests/golden_extras.json`.
- The same seed must always generate the same month (seeded RNG); don't introduce `Math.random()` / unseeded randomness in the engine.
- AI commentary: the model only copies numbers from the facts; every number in the reply is checked. Keep `GROQ_API_KEY` server-side only (`serve.js`, `api/`), never in browser code.
- No build step and no framework in the browser app; keep it dependency-free (ExcelJS is vendored and lazy-loaded).
- `.vercelignore` keeps Python, tests and tools out of the deploy; update it if you add such files.
- Never commit `.env` or generated `*.xlsx`.

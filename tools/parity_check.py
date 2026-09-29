"""Print a month-by-month comparison of the Python engine against the JavaScript golden file.

    python tools/parity_check.py
"""
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from close_engine import close_year, year_statements  # noqa: E402
from close_engine.close import acct_sum  # noqa: E402

golden = json.loads((pathlib.Path(__file__).resolve().parents[1] / "tests" / "golden_fy2026.json").read_text(encoding="utf-8"))
closed = close_year(golden["seed"])
bad = 0
for c, gm in zip(closed, golden["months"]):
    r = c["result"]
    st = r["statements"]
    mine = {
        "events": len(c["books"]["events"]), "adjustments": len(r["adjustments"]), "verdict": r["verdict"],
        "netIncome": st["netIncome"], "netSales": st["netSales"], "cash": acct_sum(r["ledger"], "1000"),
        "bankClosing": c["books"]["docs"]["bank"]["closing"], "inputHash": r["lock"]["inputHash"], "ledgerHash": r["lock"]["ledgerHash"],
        "findings": [f"{f['control']} {f['severity']} {f['message']}" for f in r["findings"]],
    }
    diffs = {k: (v, gm[k]) for k, v in mine.items() if v != gm[k]}
    if {x["code"]: x["net"] for x in r["tb"]["rows"]} != gm["trialBalance"]:
        diffs["trialBalance"] = "differs"
    print(c["period"], "MATCH" if not diffs else diffs)
    bad += bool(diffs)
y = year_statements(closed)
print("FY net income", y["totals"]["netIncome"], "golden", golden["year"]["netIncome"], "| equity check", y["equityCheck"])
print("months with differences:", bad)
sys.exit(1 if bad else 0)

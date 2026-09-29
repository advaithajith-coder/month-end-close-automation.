"""Owner contributions and drawings, loan repayments, prepaid renewals, publisher returns, stock
write-offs and manual journal entries: both engines must treat them identically, to the cent."""
import json

import pytest

from close_engine import generate_month, opening
from close_engine.books import build_books
from close_engine.close import close_month
from close_engine.core import CONTROL_ACCOUNTS

from conftest import ROOT

SPEC = json.loads((ROOT / "tests" / "extras_events.json").read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def golden_extras() -> dict:
    """Results of the JavaScript engine for the same inputs (written by tools/export_extras.js)."""
    return json.loads((ROOT / "tests" / "golden_extras.json").read_text(encoding="utf-8"))


def month_state(p: str, prior: dict | None) -> dict:
    g = generate_month(p, SPEC["seed"], opening(p, prior))
    extras = [{"id": f"u{i + 1}", "source": "user", **e} for i, e in enumerate(SPEC["extras"].get(p, []))]
    return {"period": p, "seed": SPEC["seed"], "events": g["events"] + extras, "shrinkBps": g["shrinkBps"],
            "cafeWasteBps": g["cafeWasteBps"], "countOverride": None}


@pytest.fixture(scope="module")
def closed_extras() -> list[dict]:
    out, prior = [], None
    for p in SPEC["periods"]:
        c = close_month(month_state(p, prior), prior)
        out.append(c)
        prior = c["snapshot"]
    return out


@pytest.mark.parametrize("i", range(len(SPEC["periods"])), ids=SPEC["periods"])
def test_matches_javascript(closed_extras, golden_extras, i):
    c, g = closed_extras[i], golden_extras["months"][i]
    r = c["result"]
    accrual = next((j for j in r["adjustments"] if j["tag"] == "accrual:interest"), None)
    assert r["verdict"] == g["verdict"]
    assert [f"{f['control']} {f['severity']} {f['message']}" for f in r["findings"]] == g["findings"]
    assert r["statements"]["netIncome"] == g["netIncome"]
    assert r["statements"]["totalAssets"] == g["totalAssets"]
    assert (accrual["lines"][0]["dr"] if accrual else 0) == g["interestAccrued"]
    assert [pp["id"] for pp in c["snapshot"]["prepaids"]] == g["prepaidsCarried"]
    assert {x["code"]: x["net"] for x in r["tb"]["rows"]} == g["trialBalance"]
    assert r["lock"]["inputHash"] == g["inputHash"]
    assert r["lock"]["ledgerHash"] == g["ledgerHash"]


def test_interest_follows_the_loan_balance(closed_extras):
    """$50,000 at 6% is $250 a month; after the $10,000 January repayment, February accrues $200."""
    interest = [next(j for j in c["result"]["adjustments"] if j["tag"] == "accrual:interest")["lines"][0]["dr"] for c in closed_extras]
    assert interest == [25000, 20000, 20000]


def test_renewal_joins_the_prepaid_schedule(closed_extras):
    jan = closed_extras[0]["result"]
    tags = {j["tag"]: j["lines"][0]["dr"] for j in jan["adjustments"]}
    assert tags["prepaid:pp-u3"] == 20000  # $2,400 over 12 months, starting this month
    feb = closed_extras[1]["result"]
    assert not any(j["tag"] == "prepaid:pp-u2" for j in feb["adjustments"])  # insurance cover starts next month
    mar = {j["tag"]: j["lines"][0]["dr"] for j in closed_extras[2]["result"]["adjustments"]}
    assert mar["prepaid:pp-u2"] == 60000  # $3,600 over 6 months


def test_drawings_reduce_equity_not_profit(closed_extras):
    feb = closed_extras[1]["result"]
    tb = {x["code"]: x["net"] for x in feb["tb"]["rows"]}
    assert tb["3200"] == 200000
    assert feb["statements"]["bsDiff"] == 0


def test_manual_entry_is_marked_and_balanced(closed_extras):
    je = next(j for j in closed_extras[0]["result"]["ledger"] if j.get("type") == "manual")
    assert je["memo"] == "Manual: Emergency plumber for the café sink"
    assert je["event"]["reason"] == "Invoice RP-118 paid by debit card"
    assert sum(l["dr"] for l in je["lines"]) == sum(l["cr"] for l in je["lines"]) == 12550


@pytest.mark.parametrize("acct", CONTROL_ACCOUNTS)
def test_manual_entry_cannot_touch_a_control_account(acct):
    ev = {"id": "u1", "date": "2026-01-10", "type": "manual", "memo": "Plug", "reason": "none", "amount": 100,
          "lines": [{"acct": acct, "dr": 100, "cr": 0}, {"acct": "1000", "dr": 0, "cr": 100}]}
    with pytest.raises(ValueError, match="control account"):
        build_books({"period": "2026-01", "events": [ev]})


def test_unbalanced_manual_entry_is_rejected():
    ev = {"id": "u1", "date": "2026-01-10", "type": "manual", "memo": "Typo", "reason": "none", "amount": 100,
          "lines": [{"acct": "6700", "dr": 100, "cr": 0}, {"acct": "1000", "dr": 0, "cr": 90}]}
    with pytest.raises(ValueError, match="Unbalanced"):
        build_books({"period": "2026-01", "events": [ev]})

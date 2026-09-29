"""The financial year: months chain, equity rolls forward, and the close calendar rules hold."""
import pytest

from close_engine import close_month, generate_month, opening
from close_engine.close import acct_sum


def test_equity_rolls_forward_to_the_cent(year):
    assert year["equityCheck"] == 0
    assert year["openingEquity"] + year["totals"]["netIncome"] == year["closing"]["totalEquity"]
    assert year["closing"]["bsDiff"] == 0


def test_each_month_opens_where_the_previous_one_closed(closed_year):
    for prev, cur in zip(closed_year, closed_year[1:]):
        opening_lines = next(j for j in cur["books"]["entries"] if j["source"] == "opening")["lines"]
        opened = {l["acct"]: l["dr"] - l["cr"] for l in opening_lines}
        assert opened == {k: v for k, v in prev["snapshot"]["balances"].items() if v}
        # cash carried forward exactly
        assert opened["1000"] == acct_sum(prev["result"]["ledger"], "1000")
        # the bank statement opens at last month's bank closing balance
        assert cur["books"]["docs"]["bank"]["opening"] == prev["books"]["docs"]["bank"]["closing"]


def test_profit_moves_into_retained_earnings(closed_year):
    jan, feb = closed_year[0], closed_year[1]
    re_jan = next(r["net"] for r in jan["result"]["tb"]["rows"] if r["code"] == "3100")
    assert feb["snapshot"]["balances"]["3100"] - jan["snapshot"]["balances"]["3100"] == -feb["result"]["statements"]["netIncome"]
    assert jan["snapshot"]["balances"]["3100"] == re_jan - jan["result"]["statements"]["netIncome"]


def test_a_month_cannot_open_from_the_wrong_close(closed_year):
    with pytest.raises(ValueError, match="must open from"):
        opening("2026-05", closed_year[1]["snapshot"])  # February's close cannot open May


def test_a_blocked_month_produces_no_snapshot(closed_year):
    """A critical finding blocks the close, so there is nothing to roll forward."""
    prior = closed_year[1]["snapshot"]
    g = generate_month("2026-03", 2026, opening("2026-03", prior))
    state = {"period": "2026-03", "seed": 2026, "events": g["events"], "shrinkBps": g["shrinkBps"], "cafeWasteBps": g["cafeWasteBps"]}
    out = close_month(state, prior, faults={"dropWagesAccrual": True})
    assert out["result"]["verdict"] == "BLOCKED"
    assert out["snapshot"] is None


def test_editing_a_locked_month_is_detected(closed_year):
    march = closed_year[2]
    state = dict(march["books"]["state"])
    state["events"] = [dict(e) for e in state["events"]]
    state["events"][5]["amount"] += 1  # one cent
    out = close_month({k: v for k, v in state.items() if k != "prior"}, state["prior"], lock=march["result"]["lock"])
    assert any(f["control"] == "C8" and f["severity"] == "CRITICAL" for f in out["result"]["findings"])

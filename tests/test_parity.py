"""The Python engine must reproduce the browser (JavaScript) engine exactly, to the cent."""
import pytest

from close_engine import PERIODS
from close_engine.close import acct_sum


def test_twelve_months_closed(closed_year, golden):
    assert [c["period"] for c in closed_year] == [m["period"] for m in golden["months"]] == PERIODS


@pytest.mark.parametrize("i", range(12), ids=PERIODS)
def test_month_matches_javascript(closed_year, golden, i):
    c, g = closed_year[i], golden["months"][i]
    r = c["result"]
    st = r["statements"]
    assert len(c["books"]["events"]) == g["events"]
    assert len(r["adjustments"]) == g["adjustments"]
    assert r["verdict"] == g["verdict"]
    assert st["netSales"] == g["netSales"]
    assert st["grossProfit"] == g["grossProfit"]
    assert st["netIncome"] == g["netIncome"]
    assert st["totalAssets"] == g["totalAssets"]
    assert acct_sum(r["ledger"], "1000") == g["cash"]
    assert c["books"]["docs"]["bank"]["closing"] == g["bankClosing"]
    assert {x["code"]: x["net"] for x in r["tb"]["rows"]} == g["trialBalance"]
    assert [f"{f['control']} {f['severity']} {f['message']}" for f in r["findings"]] == g["findings"]


@pytest.mark.parametrize("i", range(12), ids=PERIODS)
def test_ledgers_are_byte_identical(closed_year, golden, i):
    """Same period seal = the same entries, dates, accounts and amounts in the same order."""
    lock = closed_year[i]["result"]["lock"]
    assert lock["inputHash"] == golden["months"][i]["inputHash"]
    assert lock["ledgerHash"] == golden["months"][i]["ledgerHash"]


def test_year_totals_match_javascript(year, golden):
    g = golden["year"]
    assert year["totals"]["netSales"] == g["netSales"]
    assert year["totals"]["grossProfit"] == g["grossProfit"]
    assert year["totals"]["netIncome"] == g["netIncome"] == 662836  # $6,628.36
    assert year["openingEquity"] == g["openingEquity"]
    assert year["closing"]["totalEquity"] == g["closingEquity"]

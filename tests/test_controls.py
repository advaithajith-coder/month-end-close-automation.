"""The guardrail demo: a clean month has no findings, and each planted mistake is caught by its control."""
import pytest

from close_engine import PERIODS, run_guardrail_demo
from close_engine.books import build_books, generate_month
from close_engine.close import close_month, run_close


@pytest.mark.parametrize("change", ["unchanged", "count", "cafe_waste", "period"])
def test_lock_checks_closed_ledger(change):
    state = {"period": "2026-01", "seed": 2026, **generate_month("2026-01", 2026)}
    books = build_books(state)
    original = run_close(books)
    lock = dict(original["lock"])
    if change == "count":
        state["countOverride"] = books["docs"]["count"]["value"] + 10000
    elif change == "cafe_waste":
        state["cafeWasteBps"] += 100
    elif change == "period":
        lock["period"] = "2026-02"
    out = close_month(state, None, lock=lock)
    result = out["result"]
    assert result["lock"]["inputHash"] == original["lock"]["inputHash"]
    if change == "unchanged":
        assert result["controlStatus"]["C8"] == "PASS"
        assert out["snapshot"] is not None
    else:
        assert result["controlStatus"]["C8"] == "FAIL"
        assert out["snapshot"] is None
    if change in ("count", "cafe_waste"):
        assert result["lock"]["ledgerHash"] != original["lock"]["ledgerHash"]


@pytest.mark.parametrize("period", PERIODS)
def test_all_guardrails_hold(period, golden):
    d = run_guardrail_demo(period, 2026)
    failed = [r["id"] for r in d["results"] if not r["pass"]]
    assert not failed, f"{period}: not caught {failed}"
    assert d["allHeld"] == next(x["allHeld"] for x in golden["demos"] if x["period"] == period)


def test_each_fault_is_caught_by_the_intended_control():
    d = run_guardrail_demo("2026-03", 2026)
    caught = {r["id"]: r["caught"]["control"] for r in d["results"] if r["caught"]}
    assert caught == {
        "unbalanced_entry": "C1", "opening_typo": "C6", "bank_fee_missed": "C2", "wrong_tax": "C2",
        "missing_accrual": "C3", "dead_asset": "C4", "double_rent": "C5", "tampered_amount": "C7",
        "edited_after_lock": "C8",
    }

"""Double-entry rules: every entry balances, unbalanced input is refused, statements tie."""
import pytest

from close_engine import build_books, generate_month
from close_engine.books import TEMPLATES
from close_engine.core import fmt, line_total, pct, usd


def test_pct_rounds_half_away_from_zero():
    assert pct(1250, 800) == 100          # 8% of $12.50 = $1.00
    assert pct(1256, 800) == 100          # 100.48c -> 100
    assert pct(1257, 800) == 101          # 100.56c -> 101
    assert pct(1250 * 5, 100) == 63       # 62.5c -> 63 (half up)
    assert pct(-6250, 100) == -63         # symmetric for negatives


def test_money_formatting():
    assert fmt(123456789) == "1,234,567.89"
    assert fmt(-26782) == "(267.82)"
    assert usd(-26782) == "-$267.82"


def test_book_sale_entry():
    lines = TEMPLATES["book_sale"]["lines"]({"id": "t", "date": "2026-03-07", "type": "book_sale", "amount": 100000, "method": "card"})
    assert {(l["acct"], l["dr"], l["cr"]) for l in lines} == {
        ("1100", 108000, 0), ("4000", 0, 100000), ("2100", 0, 8000), ("5000", 60000, 0), ("1200", 0, 60000)}


def test_cafe_sale_records_its_cost():
    lines = TEMPLATES["cafe_sale"]["lines"]({"id": "t", "date": "2026-03-07", "type": "cafe_sale", "amount": 100000, "method": "cash"})
    assert ("5020", 30000, 0) in {(l["acct"], l["dr"], l["cr"]) for l in lines}
    assert line_total(lines, "dr") == line_total(lines, "cr") == 138000


def test_every_entry_in_the_year_balances(closed_year):
    for c in closed_year:
        for je in c["result"]["ledger"]:
            assert line_total(je["lines"], "dr") == line_total(je["lines"], "cr"), (c["period"], je["id"])
        tb = c["result"]["tb"]
        assert tb["totalDr"] == tb["totalCr"]
        assert c["result"]["statements"]["bsDiff"] == 0


def test_unbalanced_entry_is_refused(monkeypatch):
    broken = dict(TEMPLATES["rent"], lines=lambda e: [{"acct": "6100", "dr": e["amount"], "cr": 0}, {"acct": "1000", "dr": 0, "cr": e["amount"] - 1}])
    monkeypatch.setitem(TEMPLATES, "rent", broken)
    g = generate_month("2026-03", 2026)
    with pytest.raises(ValueError, match="Unbalanced entry from rent"):
        build_books({"period": "2026-03", "seed": 2026, "events": g["events"], "shrinkBps": g["shrinkBps"]})

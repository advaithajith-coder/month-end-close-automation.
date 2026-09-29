"""Core helpers: money in integer cents, dates, seeded RNG, fingerprints, chart of accounts,
store setup and schedules.

Ported from js/core.js. Every calculation here must match the JavaScript engine to the cent
(tests/test_parity.py checks this), so integer arithmetic and 32-bit behaviour are reproduced exactly.
"""
from __future__ import annotations

import calendar
import datetime as dt
from typing import Any

MASK32 = 0xFFFFFFFF

# ---------- money: always integer cents ----------

def fmt(cents: int) -> str:
    """1234567 -> '12,345.67'; negatives in accounting brackets."""
    a = abs(cents)
    s = f"{a // 100:,}.{a % 100:02d}"
    return f"({s})" if cents < 0 else s


def usd(cents: int) -> str:
    return ("-$" if cents < 0 else "$") + fmt(abs(cents))


def pct(cents: int, bps: int) -> int:
    """cents x basis points, rounded half away from zero, integer-exact."""
    r = (abs(cents) * bps + 5000) // 10000
    return -r if cents < 0 else r


def round_half_up(numerator: int, denominator: int) -> int:
    """Math.round(n / d) for non-negative integers, without floating point."""
    q, rem = divmod(numerator, denominator)
    return q + (1 if rem * 2 >= denominator else 0)


Line = dict[str, Any]


def dr(acct: str, amount: int) -> Line:
    return {"acct": acct, "dr": amount, "cr": 0}


def cr(acct: str, amount: int) -> Line:
    return {"acct": acct, "dr": 0, "cr": amount}


def line(acct: str, signed: int) -> Line:
    return dr(acct, signed) if signed >= 0 else cr(acct, -signed)


def line_total(lines: list[Line], side: str) -> int:
    return sum(l[side] for l in lines)


# ---------- dates (ISO strings) ----------

def parse_period(p: str) -> tuple[int, int]:
    y, m = p.split("-")
    return int(y), int(m)


def days_in_month(p: str) -> int:
    y, m = parse_period(p)
    return calendar.monthrange(y, m)[1]


def period_start(p: str) -> str:
    return p + "-01"


def period_end(p: str) -> str:
    return f"{p}-{days_in_month(p):02d}"


def period_days(p: str) -> list[str]:
    return [f"{p}-{d:02d}" for d in range(1, days_in_month(p) + 1)]


def add_days(iso: str, n: int) -> str:
    return (dt.date.fromisoformat(iso) + dt.timedelta(days=n)).isoformat()


def day_diff(frm: str, to: str) -> int:
    return (dt.date.fromisoformat(to) - dt.date.fromisoformat(frm)).days


def weekday(iso: str) -> int:
    """0 = Sunday ... 6 = Saturday (JavaScript's getUTCDay)."""
    return (dt.date.fromisoformat(iso).weekday() + 1) % 7


def month_index(p: str) -> int:
    y, m = parse_period(p)
    return y * 12 + (m - 1)


def shift_period(p: str, n: int) -> str:
    i = month_index(p) + n
    return f"{i // 12}-{i % 12 + 1:02d}"


def period_label(p: str) -> str:
    y, m = parse_period(p)
    return f"{calendar.month_name[m]} {y}"


def short_date(iso: str) -> str:
    d = dt.date.fromisoformat(iso)
    return f"{calendar.month_abbr[d.month]} {d.day}"


# ---------- seeded RNG (mulberry32) + fingerprints ----------

def _imul(a: int, b: int) -> int:
    return ((a & MASK32) * (b & MASK32)) & MASK32


class Rng:
    """mulberry32, bit-for-bit identical to the JavaScript version (unsigned 32-bit state)."""

    def __init__(self, seed: int):
        self.a = seed & MASK32

    def next(self) -> float:
        self.a = (self.a + 0x6D2B79F5) & MASK32
        a = self.a
        t = _imul(a ^ (a >> 15), 1 | a)
        t = ((t + _imul(t ^ (t >> 7), 61 | t)) & MASK32) ^ t
        return ((t ^ (t >> 14)) & MASK32) / 4294967296

    def int(self, lo: int, hi: int) -> int:
        return lo + int(self.next() * (hi - lo + 1))

    def chance(self, p: float) -> bool:
        return self.next() < p

    def pick(self, items: list):
        return items[int(self.next() * len(items))]


def hash32(s: str) -> int:
    """FNV-1a, 32-bit."""
    h = 0x811C9DC5
    for ch in s:
        h ^= ord(ch)
        h = _imul(h, 0x01000193)
    return h


def fingerprint(s: str) -> str:
    """64-bit fingerprint (two FNV-style lanes) used to seal a closed period. Tamper-evident, not cryptographic."""
    h1, h2 = 0x811C9DC5, 0x9E3779B9
    for ch in s:
        c = ord(ch)
        h1 ^= c
        h1 = _imul(h1, 0x01000193)
        h2 ^= c
        h2 = _imul(h2, 0x5BD1E995)
        h2 ^= h2 >> 13
    return f"{h1:08x}{h2:08x}"


# ---------- chart of accounts ----------
# type: A asset, L liability, E equity, R revenue, X expense
ACCOUNTS: list[dict[str, str]] = [
    {"code": c, "name": n, "type": t}
    for c, n, t in [
        ("1000", "Cash – Bank", "A"), ("1100", "Card Clearing", "A"), ("1200", "Inventory", "A"), ("1210", "Café Stock", "A"),
        ("1300", "Prepaid Insurance", "A"), ("1310", "Prepaid Software", "A"),
        ("1500", "Store Fixtures & Equipment", "A"), ("1510", "Accumulated Depreciation", "A"),
        ("2000", "Accounts Payable", "L"), ("2100", "Sales Tax Payable", "L"), ("2200", "Accrued Wages", "L"),
        ("2210", "Accrued Utilities", "L"), ("2220", "Accrued Interest", "L"), ("2300", "Gift Card Liability", "L"),
        ("2500", "Bank Loan", "L"),
        ("3000", "Owner's Capital", "E"), ("3100", "Retained Earnings", "E"), ("3200", "Owner's Drawings", "E"),
        ("4000", "Book Sales", "R"), ("4010", "Café Sales", "R"), ("4100", "Sales Returns", "R"), ("4900", "Interest Income", "R"),
        ("5000", "Cost of Goods Sold", "X"), ("5010", "Inventory Shrinkage", "X"), ("5020", "Café Cost of Sales", "X"), ("5030", "Café Waste", "X"),
        ("6000", "Wages", "X"), ("6100", "Rent", "X"), ("6200", "Utilities", "X"), ("6300", "Card Processing Fees", "X"),
        ("6400", "Insurance", "X"), ("6410", "Software", "X"), ("6500", "Depreciation", "X"), ("6600", "Bank Fees", "X"),
        ("6700", "Supplies", "X"), ("7000", "Interest Expense", "X"),
    ]
]
_BY_CODE = {a["code"]: a for a in ACCOUNTS}


def acct(code: str) -> dict[str, str]:
    return _BY_CODE.get(code, {"code": code, "name": f"Unknown {code}", "type": "?"})


# ---------- the fictional store ----------
SETUP: dict[str, Any] = {
    "company": "Quincy Bookstore",
    "taxBps": 800,          # 8% sales tax
    "cardFeeBps": 250,      # 2.5% card processing fee
    "costBps": 6000,        # books cost 60% of the shelf price
    "cafeCostBps": 3000,    # café ingredients and cups cost 30% of the menu price
    "cafeVendor": "Riverside Coffee Co.",
    "dailyWage": 43000,     # $430 of staff wages earned per day
    "rent": 400000,
    "utilityEstimate": 85000,
    "bankFee": 1500,
    "bankInterestBps": 1,
    "loan": {"principal": 5000000, "rateBps": 600},
    "vendors": ["Northwind Publishing", "Bluebird Press", "Harbor Books Distribution", "Lantern House"],
    "prepaids": [
        {"id": "ins", "name": "Store insurance policy", "asset": "1300", "expense": "6400", "total": 720000, "start": "2026-01", "months": 12},
        {"id": "sw", "name": "POS & inventory software (annual)", "asset": "1310", "expense": "6410", "total": 180000, "start": "2025-10", "months": 12},
    ],
    # depreciation starts the month after the asset is placed in service
    "assets": [
        {"id": "shelves", "name": "Bookshelves & store fixtures", "cost": 3600000, "inService": "2023-04", "life": 84},
        {"id": "pos", "name": "POS terminals", "cost": 480000, "inService": "2023-02", "life": 36},
        {"id": "espresso", "name": "Café espresso machine", "cost": 900000, "inService": "2025-06", "life": 60},
        {"id": "register", "name": "Old cash register", "cost": 120000, "inService": "2021-12", "life": 36},  # fully depreciated since Dec 2024
    ],
    "opening": {"cash": 2800000, "inventory": 4200000, "cafeStock": 120000, "ap": 1240000, "salesTax": 396000,
                "giftCards": 120000, "ownerCapital": 3000000, "cardClearing": [118000, 131500]},
    # last month's actuals for the fluctuation review in January (schedule-driven lines are derived per period)
    "baselineFixed": {"5000": 2400000, "5010": 20000, "5020": 250000, "5030": 3500, "6000": 1290000, "6100": 400000,
                      "6200": 86000, "6300": 92000, "6600": 1500, "6700": 56000, "7000": 25000},
}

# Financial year = calendar 2026. January opens from the setup; later months open from the previous close.
YEAR = 2026
PERIODS = [shift_period("2026-01", i) for i in range(12)]


# ---------- schedules (primary implementation; the shadow recompute lives in close.py) ----------

def prepaid_amort(pp: dict, p: str) -> int:
    i = month_index(p) - month_index(pp["start"])
    if i < 0 or i >= pp["months"]:
        return 0
    base = pp["total"] // pp["months"]
    return pp["total"] - base * (pp["months"] - 1) if i == pp["months"] - 1 else base


def prepaid_amort_through(pp: dict, p: str) -> int:
    i = month_index(p) - month_index(pp["start"])
    if i < 0:
        return 0
    if i >= pp["months"] - 1:
        return pp["total"]
    return pp["total"] // pp["months"] * (i + 1)


def depreciation(a: dict, p: str) -> int:
    i = month_index(p) - (month_index(a["inService"]) + 1)
    if i < 0 or i >= a["life"]:
        return 0
    base = a["cost"] // a["life"]
    return a["cost"] - base * (a["life"] - 1) if i == a["life"] - 1 else base


def depreciation_through(a: dict, p: str) -> int:
    i = month_index(p) - (month_index(a["inService"]) + 1)
    if i < 0:
        return 0
    if i >= a["life"] - 1:
        return a["cost"]
    return a["cost"] // a["life"] * (i + 1)


def monthly_interest(loan: dict) -> int:
    return (loan["principal"] * loan["rateBps"] + 60000) // 120000


def loan_interest(balance: int) -> int:
    """Interest for a month on whatever the loan balance actually is (it falls as principal is repaid)."""
    return monthly_interest({"principal": max(0, balance), "rateBps": SETUP["loan"]["rateBps"]})


# Control accounts: kept right by their own transactions and the close, so a manual journal entry
# may not touch them (the close would flag the difference anyway). Retained earnings moves only at close.
CONTROL_ACCOUNTS = ("1100", "1300", "1310", "1510", "2100", "2200", "2210", "2220", "2300", "3100")


def baseline(p: str) -> dict[str, int]:
    prev = shift_period(p, -1)
    b = dict(SETUP["baselineFixed"])
    for pp in SETUP["prepaids"]:
        b[pp["expense"]] = b.get(pp["expense"], 0) + prepaid_amort(pp, prev)
    b["6500"] = sum(depreciation(a, prev) for a in SETUP["assets"])
    return b

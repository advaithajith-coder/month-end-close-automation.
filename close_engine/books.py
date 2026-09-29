"""Recording the month: transaction templates, the generator, opening balances, building the ledger,
and the outside documents (bank statement, card processor report, stock counts).

Ported from js/books.js.
"""
from __future__ import annotations

from typing import Any, Callable

from .core import (CONTROL_ACCOUNTS, SETUP, Rng, add_days, cr, day_diff, depreciation_through, dr, hash32, line, line_total,
                   monthly_interest, pct, period_days, period_end, period_label, period_start,
                   prepaid_amort_through, round_half_up, shift_period, weekday, month_index)

Event = dict[str, Any]


def _method_acct(e: Event) -> str:
    return "1100" if e.get("method") == "card" else "1000"


def _tax(e: Event) -> int:
    bps = e.get("taxBps")
    return pct(e["amount"], SETUP["taxBps"] if bps is None else bps)


def _cost(e: Event) -> int:
    return pct(e["amount"], SETUP["costBps"])


def _cafe_cost(e: Event) -> int:
    return pct(e["amount"], SETUP["cafeCostBps"])


def _t(label: str, describe: Callable[[Event], str], lines: Callable[[Event], list]) -> dict:
    return {"label": label, "describe": describe, "lines": lines}


# Every template produces a balanced journal entry from a few simple inputs.
TEMPLATES: dict[str, dict] = {
    "book_sale": _t("Book sales (day total)", lambda e: f"Book sales – {e['method']}", lambda e: [
        dr(_method_acct(e), e["amount"] + _tax(e)), cr("4000", e["amount"]), cr("2100", _tax(e)),
        dr("5000", _cost(e)), cr("1200", _cost(e))]),
    "cafe_sale": _t("Café sales (day total)", lambda e: f"Café sales – {e['method']}", lambda e: [
        dr(_method_acct(e), e["amount"] + _tax(e)), cr("4010", e["amount"]), cr("2100", _tax(e)),
        dr("5020", _cafe_cost(e)), cr("1210", _cafe_cost(e))]),
    "sale_return": _t("Customer return", lambda e: f"Customer return – refunded by {e['method']}", lambda e: [
        dr("4100", e["amount"]), dr("2100", _tax(e)), cr(_method_acct(e), e["amount"] + _tax(e)),
        dr("1200", _cost(e)), cr("5000", _cost(e))]),
    "giftcard_sold": _t("Gift card sold", lambda e: f"Gift card sold – {e['method']}", lambda e: [
        dr(_method_acct(e), e["amount"]), cr("2300", e["amount"])]),
    "giftcard_redeemed": _t("Gift card redeemed for books", lambda e: "Gift card redeemed for books", lambda e: [
        dr("2300", e["amount"] + _tax(e)), cr("4000", e["amount"]), cr("2100", _tax(e)),
        dr("5000", _cost(e)), cr("1200", _cost(e))]),
    "inventory_purchase": _t("Buy books from publisher (on account)", lambda e: f"Books purchased on account – {e['vendor']}",
                             lambda e: [dr("1200", e["amount"]), cr("2000", e["amount"])]),
    "cafe_purchase": _t("Buy café stock (on account)", lambda e: f"Café stock purchased on account – {SETUP['cafeVendor']}",
                        lambda e: [dr("1210", e["amount"]), cr("2000", e["amount"])]),
    "vendor_payment": _t("Pay supplier (check)", lambda e: f"Check to {e['vendor']}",
                         lambda e: [dr("2000", e["amount"]), cr("1000", e["amount"])]),
    "supplies": _t("Store supplies (debit card)", lambda e: "Store supplies – bags, receipt rolls, cleaning",
                   lambda e: [dr("6700", e["amount"]), cr("1000", e["amount"])]),
    "equipment_purchase": _t("Buy equipment (debit card)", lambda e: f"Equipment purchased – {e.get('name')}",
                             lambda e: [dr("1500", e["amount"]), cr("1000", e["amount"])]),
    "payroll": _t("Payroll (direct deposit)", lambda e: "Payroll – staff wages",
                  lambda e: [dr("6000", e["amount"]), cr("1000", e["amount"])]),
    "rent": _t("Store rent", lambda e: "Rent – landlord ACH", lambda e: [dr("6100", e["amount"]), cr("1000", e["amount"])]),
    "utility_bill": _t("Utility bill (last month's usage)", lambda e: "Utilities – power & water (autopay)",
                       lambda e: [dr("6200", e["amount"]), cr("1000", e["amount"])]),
    "interest_payment": _t("Loan interest payment", lambda e: "Bank loan – monthly interest",
                           lambda e: [dr("7000", e["amount"]), cr("1000", e["amount"])]),
    "sales_tax_remittance": _t("Pay last month's sales tax", lambda e: "Sales tax remitted to the state",
                               lambda e: [dr("2100", e["amount"]), cr("1000", e["amount"])]),
    # owner, loan, renewals and stock adjustments
    "owner_contribution": _t("Owner puts money into the business", lambda e: "Owner's contribution – deposited to the bank",
                             lambda e: [dr("1000", e["amount"]), cr("3000", e["amount"])]),
    "owner_drawing": _t("Owner takes money out (drawings)", lambda e: "Owner's drawings – withdrawn from the bank",
                        lambda e: [dr("3200", e["amount"]), cr("1000", e["amount"])]),
    "loan_repayment": _t("Repay part of the bank loan", lambda e: "Bank loan – principal repayment",
                         lambda e: [dr("2500", e["amount"]), cr("1000", e["amount"])]),
    "prepaid_purchase": _t("Renew insurance or software (paid in advance)",
                           lambda e: f"{'Software licence' if e['kind'] == 'software' else 'Insurance'} renewal – {e['months']} months paid in advance",
                           lambda e: [dr("1310" if e["kind"] == "software" else "1300", e["amount"]), cr("1000", e["amount"])]),
    "publisher_return": _t("Return books to a publisher (credit note)", lambda e: f"Books returned to {e['vendor']} for credit",
                           lambda e: [dr("2000", e["amount"]), cr("1200", e["amount"])]),
    "stock_writeoff": _t("Write off damaged stock", lambda e: f"Stock written off – {e['reason']}",
                         lambda e: [dr("5010", e["amount"]), cr("1200", e["amount"])]),
    # anything else: a manual journal entry, lines typed by the user
    "manual": _t("Manual journal entry", lambda e: f"Manual: {e['memo']}",
                 lambda e: [{"acct": l["acct"], "dr": l["dr"], "cr": l["cr"]} for l in e["lines"]]),
}


def prepaid_from_event(e: Event) -> dict:
    """A renewal paid in advance joins the prepaid schedule and is amortised like the original policies."""
    sw = e["kind"] == "software"
    return {"id": f"pp-{e['id']}", "name": "Software licence renewal" if sw else "Insurance renewal",
            "asset": "1310" if sw else "1300", "expense": "6410" if sw else "6400", "total": e["amount"],
            "start": e["date"][:7] if e.get("starts") == "this" else shift_period(e["date"][:7], 1),
            "months": e.get("months") or 12}

# How each cash transaction shows up on the bank statement: description + days until it clears.
_BANK = {
    "book_sale": ("Cash deposit", 1), "cafe_sale": ("Cash deposit", 1), "giftcard_sold": ("Cash deposit", 1),
    "sale_return": ("Register refund adjustment", 1), "vendor_payment": (None, None),
    "payroll": ("Payroll direct deposit", 0), "rent": ("ACH – landlord rent", 0), "utility_bill": ("ACH – city power & water", 0),
    "interest_payment": ("Loan interest debit", 0), "sales_tax_remittance": ("State sales tax e-payment", 1),
    "supplies": ("Debit card purchase", 1), "equipment_purchase": ("Debit card purchase", 1),
    "owner_contribution": ("Owner deposit", 1), "owner_drawing": ("Owner withdrawal", 0), "loan_repayment": ("Loan principal repayment", 0),
    "prepaid_purchase": ("Debit card purchase", 1), "manual": ("Bank transfer", 0),
}


def bank_info(e: Event, seed: int) -> tuple[str, int]:
    desc, lag = _BANK.get(e["type"], ("Bank transaction", 0))
    if lag is None:  # checks clear 3-6 days later, chosen by a hash so it is repeatable
        return f"Check paid – {e.get('vendor') or 'vendor'}", 3 + hash32(f"{e['id']}:{seed}") % 4
    return desc, lag


def opening(period: str, prior: dict | None = None) -> dict:
    """Opening balances. With `prior` (last month's closing snapshot) the month opens exactly where
    last month closed; without it, balances are derived from the store setup."""
    prev = shift_period(period, -1)
    prev_end = period_end(prev)
    if prior is not None:
        if prior["period"] != prev:
            raise ValueError(f"{period_label(period)} must open from {period_label(prev)}'s close")
        b = dict(prior["balances"])
        return {
            "balances": b, "lines": [line(k, b[k]) for k in sorted(b) if b[k] != 0], "prevEnd": prev_end,
            "lastPayroll": prior["lastPayroll"],
            "accruedWages": -b.get("2200", 0), "accruedUtilities": -b.get("2210", 0), "accruedInterest": -b.get("2220", 0),
            "cardRows": [dict(x) for x in prior["cardRows"]],
            "ap": -b.get("2000", 0), "salesTax": -b.get("2100", 0), "giftCards": -b.get("2300", 0),
            "bankOpening": prior["bankClosing"],
            "bankOutstanding": [dict(x) for x in prior["bankOutstanding"]],
            "bankCarried": [dict(x) for x in prior["bankAfterPeriod"]],
            "extraAssets": [dict(a) for a in prior["assets"]],
            "extraPrepaids": [dict(pp) for pp in prior.get("prepaids", [])],
            "expenseBaseline": dict(prior["expenses"]),
            "fromPrior": True,
        }

    s = SETUP
    last_payroll = add_days(prev_end, -3)
    accrued_wages = s["dailyWage"] * day_diff(last_payroll, prev_end)
    interest = monthly_interest(s["loan"])
    card_rows = [{"saleDate": add_days(prev_end, -1), "gross": s["opening"]["cardClearing"][0]},
                 {"saleDate": prev_end, "gross": s["opening"]["cardClearing"][1]}]
    b: dict[str, int] = {}

    def put(a: str, v: int) -> None:
        b[a] = b.get(a, 0) + v

    put("1000", s["opening"]["cash"])
    put("1100", sum(x["gross"] for x in card_rows))
    put("1200", s["opening"]["inventory"])
    put("1210", s["opening"]["cafeStock"])
    for pp in s["prepaids"]:
        put(pp["asset"], pp["total"] - prepaid_amort_through(pp, prev))
    for a in s["assets"]:
        put("1500", a["cost"])
        put("1510", -depreciation_through(a, prev))
    put("2000", -s["opening"]["ap"]); put("2100", -s["opening"]["salesTax"]); put("2200", -accrued_wages)
    put("2210", -s["utilityEstimate"]); put("2220", -interest); put("2300", -s["opening"]["giftCards"])
    put("2500", -s["loan"]["principal"]); put("3000", -s["opening"]["ownerCapital"])
    put("3100", -sum(b.values()))  # retained earnings balances the books
    return {
        "balances": b, "lines": [line(k, b[k]) for k in sorted(b) if b[k] != 0], "prevEnd": prev_end,
        "lastPayroll": last_payroll, "accruedWages": accrued_wages, "accruedUtilities": s["utilityEstimate"],
        "accruedInterest": interest, "cardRows": card_rows,
        "ap": s["opening"]["ap"], "salesTax": s["opening"]["salesTax"], "giftCards": s["opening"]["giftCards"],
        "bankOpening": s["opening"]["cash"], "bankOutstanding": [], "bankCarried": [], "extraAssets": [], "extraPrepaids": [],
        "expenseBaseline": None, "fromPrior": False,
    }


def payroll_default(events: list[Event], date: str, op: dict) -> int:
    """Wages earned since the previous payroll, for a payroll on `date`."""
    prior = sorted(e["date"] for e in events if e["type"] == "payroll" and e["date"] < date)
    frm = prior[-1] if prior else op["lastPayroll"]
    return max(0, day_diff(frm, date)) * SETUP["dailyWage"]


def generate_month(period: str, seed: int, op: dict | None = None) -> dict:
    """A realistic, seeded month of activity. Same seed + same opening = same month, in both engines."""
    op = op or opening(period)
    r = Rng(seed * 7919 + month_index(period))
    s = SETUP
    days = period_days(period)
    end = days[-1]
    ev: list[Event] = []

    def add(date: str, type_: str, **props: Any) -> None:
        ev.append({"id": f"g{len(ev) + 1}", "date": date, "type": type_, "source": "generated", **props})

    gift, last_pay = op["giftCards"], op["lastPayroll"]
    purchases: list[dict] = []
    for d in days:
        dom, wd = int(d[8:]), weekday(d)
        mult = 14 if wd in (0, 6) else 10  # weekends are busier
        if dom == 1:
            add(d, "rent", amount=s["rent"])
        if dom in (3, 17):
            add(d, "supplies", amount=r.int(26000, 30000))
        if dom == 5:
            add(d, "interest_payment", amount=monthly_interest(s["loan"]))
        if dom == 10 and op["ap"] > 0:
            add(d, "vendor_payment", amount=op["ap"], vendor="Various (last month)")
        if dom == 12:
            add(d, "utility_bill", amount=r.int(80000, 92000))
        if dom == 20 and op["salesTax"] > 0:
            add(d, "sales_tax_remittance", amount=op["salesTax"])
        if wd == 1:
            amount, vendor = r.int(520000, 620000), s["vendors"][len(purchases) % len(s["vendors"])]
            add(d, "inventory_purchase", amount=amount, vendor=vendor)
            purchases.append({"amount": amount, "vendor": vendor})
        if wd == 4:
            add(d, "cafe_purchase", amount=r.int(52000, 64000))
        if day_diff(last_pay, d) == 14:
            add(d, "payroll", amount=14 * s["dailyWage"])
            last_pay = d
        book = round_half_up(r.int(95000, 140000) * mult, 10)
        book_card = pct(book, 7200)
        add(d, "book_sale", amount=book_card, method="card")
        add(d, "book_sale", amount=book - book_card, method="cash")
        cafe = round_half_up(r.int(18000, 32000) * mult, 10)
        cafe_card = pct(cafe, 6000)
        add(d, "cafe_sale", amount=cafe_card, method="card")
        add(d, "cafe_sale", amount=cafe - cafe_card, method="cash")
        if r.chance(0.25):
            amount = r.int(1500, 6000)
            add(d, "sale_return", amount=amount, method="card" if r.chance(0.7) else "cash")
        if r.chance(0.2):
            amount = r.pick([2500, 5000]) * r.int(1, 3)
            add(d, "giftcard_sold", amount=amount, method="card")
            gift += amount
        if r.chance(0.15):
            amount = r.int(1500, 4500)
            tax = pct(amount, s["taxBps"])
            if amount + tax <= gift:
                add(d, "giftcard_redeemed", amount=amount)
                gift -= amount + tax
    # pay the first publisher invoice late in the month: the check won't clear before month end
    if purchases:
        add(add_days(end, -2), "vendor_payment", amount=purchases[0]["amount"], vendor=purchases[0]["vendor"])
    ev.sort(key=lambda e: e["date"])  # stable, like JavaScript's sort
    return {"events": ev, "shrinkBps": r.int(30, 60), "cafeWasteBps": r.int(150, 350)}


def build_books(state: dict, hooks: dict | None = None) -> dict:
    """Turn a month's inputs (events) into a ledger. `hooks` are used only by the fault-injection demo."""
    hooks = hooks or {}
    p = state["period"]
    op = opening(p, state.get("prior"))
    start = period_start(p)
    entries: list[dict] = []

    def post(je: dict) -> dict:
        je["id"] = f"JE-{len(entries) + 1:04d}"
        entries.append(je)
        return je

    open_lines = [dict(l) for l in op["lines"]]
    if hooks.get("openingCashTypo"):
        next(l for l in open_lines if l["acct"] == "1000")["dr"] += hooks["openingCashTypo"]
    post({"date": start, "memo": f"Opening balances carried forward from {period_label(shift_period(p, -1))}",
          "source": "opening", "type": "opening", "lines": open_lines})
    reversal = [dr("2200", op["accruedWages"]), cr("6000", op["accruedWages"]),
                dr("2210", op["accruedUtilities"]), cr("6200", op["accruedUtilities"]),
                dr("2220", op["accruedInterest"]), cr("7000", op["accruedInterest"])]
    post({"date": start, "memo": "Auto-reverse last month's accruals", "source": "system", "type": "reversal",
          "lines": [l for l in reversal if l["dr"] or l["cr"]]})

    events = [dict(e) for e in state["events"]]
    if hooks.get("events"):
        events = hooks["events"](events)
    events.sort(key=lambda e: e["date"])
    assets = [dict(a) for a in SETUP["assets"]] + [dict(a) for a in op["extraAssets"]]  # + equipment from earlier months
    prepaids = [dict(pp) for pp in SETUP["prepaids"]] + [dict(pp) for pp in op["extraPrepaids"]]  # + renewals from earlier months
    for e in events:
        t = TEMPLATES.get(e["type"])
        if not t:
            continue
        lines = t["lines"](e)
        if e.get("unbalance"):
            lines[0]["dr"] += e["unbalance"]  # fault injection only – real inputs always balance
        elif line_total(lines, "dr") != line_total(lines, "cr"):
            raise ValueError(f"Unbalanced entry from {e['type']}")
        if e["type"] == "manual" and any(l["acct"] in CONTROL_ACCOUNTS for l in lines):
            raise ValueError("A manual journal entry cannot post to a control account")
        post({"date": e["date"], "memo": t["describe"](e), "source": e.get("source", "user"), "type": e["type"],
              "eventId": e["id"], "event": e, "lines": lines})
        if e["type"] == "equipment_purchase":
            assets.append({"id": f"eq-{e['id']}", "name": e.get("name") or "New equipment", "cost": e["amount"],
                           "inService": e["date"][:7], "life": e.get("life") or 60})
        if e["type"] == "prepaid_purchase":
            prepaids.append(prepaid_from_event(e))
    books = {"period": p, "state": state, "opening": op, "entries": entries, "events": events,
             "assets": assets, "prepaids": prepaids}
    books["docs"] = build_docs(books)
    return books


def _acct_net(entries: list[dict], acct: str) -> int:
    return sum(l["dr"] - l["cr"] for je in entries for l in je["lines"] if l["acct"] == acct)


def build_docs(books: dict) -> dict:
    """Documents that arrive from outside the store at month end."""
    s, p, state, op = SETUP, books["period"], books["state"], books["opening"]
    end = period_end(p)
    seed = state.get("seed") or 2026

    # card processor report: one payout per sales day, two days later, less the fee
    by_day: dict[str, int] = {}
    for je in books["entries"]:
        if je["source"] == "opening":
            continue
        for l in je["lines"]:
            if l["acct"] == "1100":
                by_day[je["date"]] = by_day.get(je["date"], 0) + l["dr"] - l["cr"]
    processor = [dict(x) for x in op["cardRows"]] + [{"saleDate": d, "gross": by_day[d]} for d in sorted(by_day)]
    processor = [r for r in processor if r["gross"] != 0]
    for r in processor:
        r["fee"] = pct(r["gross"], s["cardFeeBps"]) if r["gross"] > 0 else 0
        r["net"] = r["gross"] - r["fee"]
        r["settleDate"] = add_days(r["saleDate"], 2)

    # bank statement: every cash movement clears after a realistic delay, plus bank-only items
    all_lines: list[dict] = []
    for je in books["entries"]:
        if not je.get("event"):
            continue
        cash = sum(l["dr"] - l["cr"] for l in je["lines"] if l["acct"] == "1000")
        if not cash:
            continue
        desc, lag = bank_info(je["event"], seed)
        all_lines.append({"date": add_days(je["date"], lag), "desc": desc, "amount": cash})
    for r in processor:
        all_lines.append({"date": r["settleDate"], "desc": "Card processor deposit", "amount": r["net"]})
    for c in op["bankCarried"]:  # last month's checks and deposits that the bank clears this month
        all_lines.append(dict(c))
    all_lines.append({"date": end, "desc": "Monthly service fee", "amount": -s["bankFee"]})
    all_lines.append({"date": end, "desc": "Interest earned", "amount": pct(op["bankOpening"], s["bankInterestBps"])})
    all_lines.sort(key=lambda l: l["date"])
    lines = [l for l in all_lines if l["date"] <= end]
    bank_open = op["bankOpening"]
    closing = bank_open + sum(l["amount"] for l in lines)

    # stock counts
    book_inv = _acct_net(books["entries"], "1200")
    shrink_bps = state.get("shrinkBps")
    shrink_bps = 50 if shrink_bps is None else shrink_bps
    override = state.get("countOverride") is not None
    count = state["countOverride"] if override else book_inv - pct(book_inv, shrink_bps)
    cafe_book = _acct_net(books["entries"], "1210")
    waste_bps = state.get("cafeWasteBps")
    waste_bps = 250 if waste_bps is None else waste_bps
    cafe_count = cafe_book - pct(max(0, cafe_book), waste_bps)

    return {
        "processor": processor,
        "cafeCount": {"book": cafe_book, "value": cafe_count, "wasteBps": waste_bps},
        # card payouts after month end are re-created next month from the processor report, so they are not carried
        "bank": {"opening": bank_open, "closing": closing, "lines": lines,
                 "afterPeriod": [l for l in all_lines if l["date"] > end and l["desc"] != "Card processor deposit"]},
        "count": {"book": book_inv, "value": count, "shrinkBps": shrink_bps, "override": override},
    }

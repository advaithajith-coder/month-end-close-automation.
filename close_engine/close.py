"""The automated month-end close: nine steps, financial statements, eight controls, an independent
shadow recompute, the roll-forward into next month, year statements and the fault-injection demo.

Ported from js/close.js.
"""
from __future__ import annotations

import copy
from typing import Any, Callable

from .books import build_books, generate_month, opening
from .core import (ACCOUNTS, PERIODS, SETUP, acct, baseline, cr, day_diff, depreciation, depreciation_through, dr,
                   fingerprint, line, line_total, loan_interest, month_index, pct, period_end, period_label, prepaid_amort,
                   prepaid_amort_through, round_half_up, shift_period, short_date, usd)


def acct_sum(entries: list[dict], code: str) -> int:
    return sum(l["dr"] - l["cr"] for je in entries for l in je["lines"] if l["acct"] == code)


def _serialize(entries: list[dict]) -> str:
    return "\n".join(f"{je['id']}|{je['date']}|" + ",".join(f"{l['acct']}:{l['dr']}:{l['cr']}" for l in je["lines"]) for je in entries)


def run_close(books: dict, faults: dict | None = None, lock: dict | None = None) -> dict:
    f = faults or {}
    s, p = SETUP, books["period"]
    end, prev = period_end(p), shift_period(p, -1)
    ledger = list(books["entries"])
    adjustments: list[dict] = []

    def post(step: str, je: dict) -> dict:
        je["id"] = f"ADJ-{len(adjustments) + 1:03d}"
        je["source"], je["step"] = "close", step
        je.setdefault("date", end)
        je["lines"] = [l for l in je["lines"] if l["dr"] != 0 or l["cr"] != 0]
        ledger.append(je)
        adjustments.append(je)
        return je

    def bal(code: str) -> int:
        return acct_sum(ledger, code)

    steps: list[dict] = []

    # 1 — card processor settlements
    rows = [dict(r, posted=r["settleDate"] <= end) for r in books["docs"]["processor"]]
    for r in rows:
        if r["posted"]:
            post("card", {"date": r["settleDate"], "tag": "card-settlement", "memo": f"Card settlement – sales of {short_date(r['saleDate'])}",
                          "lines": [line("1000", r["net"]), line("6300", r["fee"]), line("1100", -r["gross"])]})
    in_transit = sum(r["gross"] for r in rows if not r["posted"])
    settled = [r for r in rows if r["posted"]]
    steps.append({"id": "card", "title": "Card processor settlements", "diff": bal("1100") - in_transit,
                  "summary": f"{len(settled)} payouts booked: {usd(sum(r['net'] for r in settled))} deposited after "
                             f"{usd(sum(r['fee'] for r in settled))} in fees. {usd(in_transit)} of card sales still in transit.",
                  "detail": {"rows": rows, "inTransit": in_transit}})

    # 2 — bank reconciliation (last month's uncleared items are still waiting to hit the bank)
    book_items = [dict(x, jeId="b/f", matched=False, broughtForward=True) for x in books["opening"]["bankOutstanding"]]
    for je in ledger:
        if je["source"] == "opening":
            continue
        amt = sum(l["dr"] - l["cr"] for l in je["lines"] if l["acct"] == "1000")
        if amt:
            book_items.append({"date": je["date"], "amount": amt, "memo": je["memo"], "jeId": je["id"], "matched": False})
    bank_lines = [dict(l, matched=False) for l in books["docs"]["bank"]["lines"]]
    for bl in bank_lines:
        best = None
        for bi in book_items:
            if bi["matched"] or bi["amount"] != bl["amount"] or bi["date"] > bl["date"] or day_diff(bi["date"], bl["date"]) > 10:
                continue
            if best is None or bi["date"] < best["date"]:
                best = bi
        if best is not None:
            best["matched"] = bl["matched"] = True
    bank_only = [l for l in bank_lines if not l["matched"]]
    unexplained = []
    for bl in bank_only:
        if "fee" in bl["desc"].lower():
            if not f.get("skipBankFee"):
                post("bank", {"tag": "bank-fee", "memo": "Bank service fee per statement", "lines": [dr("6600", -bl["amount"]), cr("1000", -bl["amount"])]})
                bl["booked"] = True
        elif "interest" in bl["desc"].lower():
            post("bank", {"tag": "bank-interest", "memo": "Interest earned per statement", "lines": [dr("1000", bl["amount"]), cr("4900", bl["amount"])]})
            bl["booked"] = True
        else:
            unexplained.append(bl)
    outstanding = [b for b in book_items if not b["matched"]]
    dit = sum(b["amount"] for b in outstanding if b["amount"] > 0)
    oc = sum(b["amount"] for b in outstanding if b["amount"] < 0)
    bank_end = books["docs"]["bank"]["closing"]
    adjusted_bank, book_cash = bank_end + dit + oc, bal("1000")
    steps.append({"id": "bank", "title": "Bank reconciliation", "diff": adjusted_bank - book_cash, "exceptions": unexplained,
                  "summary": f"Matched {len(bank_lines) - len(bank_only)} of {len(bank_lines)} bank lines automatically. "
                             f"Booked {sum(1 for b in bank_only if b.get('booked'))} bank-only items; {len(outstanding)} items still in transit.",
                  "detail": {"bankEnd": bank_end, "dit": dit, "oc": oc, "adjustedBank": adjusted_bank, "bookCash": book_cash,
                             "outstanding": outstanding, "bankOnly": bank_only}})

    # 3 — stock counts: books (shrinkage) and café stock (waste)
    book, count = bal("1200"), books["docs"]["count"]["value"]
    shrink = book - count
    if shrink:
        post("inventory", {"tag": "shrinkage", "memo": "Inventory shrinkage per physical count" if shrink > 0 else "Inventory overage per physical count",
                           "lines": [line("5010", shrink), line("1200", -shrink)]})
    cafe_book, cafe_count = bal("1210"), books["docs"]["cafeCount"]["value"]
    waste = cafe_book - cafe_count
    if waste:
        post("inventory", {"tag": "cafe-waste", "memo": "Café stock waste and spoilage per count", "lines": [line("5030", waste), line("1210", -waste)]})
    steps.append({"id": "inventory", "title": "Stock counts: books & café", "diff": (bal("1200") - count) + (bal("1210") - cafe_count),
                  "summary": f"Books: records {usd(book)}, shelf count {usd(count)}, shrinkage {usd(shrink)} "
                             f"({shrink * 100 / book if book else 0:.2f}%). "
                             f"Café: records {usd(cafe_book)}, count {usd(cafe_count)}, waste {usd(waste)}.",
                  "detail": {"book": book, "count": count, "shrink": shrink, "cafeBook": cafe_book, "cafeCount": cafe_count, "waste": waste}})

    # 4 — prepaid amortization
    prepaid_rows = []
    for pp in books["prepaids"]:
        opening_bal = pp["total"] - prepaid_amort_through(pp, prev)
        amt = prepaid_amort(pp, p)
        if f.get("tamperPrepaid") and pp["id"] == "ins" and amt:
            amt += 5000
        if amt:
            post("prepaids", {"tag": f"prepaid:{pp['id']}", "memo": f"Amortize {pp['name']}", "lines": [dr(pp["expense"], amt), cr(pp["asset"], amt)]})
        prepaid_rows.append(dict(pp, opening=opening_bal, amort=amt, closing=opening_bal - amt))
    diff = sum(bal(a) - sum(r["closing"] for r in prepaid_rows if r["asset"] == a) for a in dict.fromkeys(r["asset"] for r in prepaid_rows))
    steps.append({"id": "prepaids", "title": "Prepaid amortization", "diff": diff,
                  "summary": f"Expensed {usd(sum(r['amort'] for r in prepaid_rows))} of prepaid costs across {sum(1 for r in prepaid_rows if r['amort'])} items.",
                  "detail": {"rows": prepaid_rows}})

    # 5 — depreciation
    dep_rows = []
    for a in books["assets"]:
        opening_acc = depreciation_through(a, prev)
        amt = depreciation(a, p)
        if f.get("deadAssetDepreciates") and opening_acc >= a["cost"]:
            amt = a["cost"] // a["life"]
        if amt:
            post("depreciation", {"tag": f"dep:{a['id']}", "memo": f"Depreciation – {a['name']}", "lines": [dr("6500", amt), cr("1510", amt)]})
        dep_rows.append(dict(a, opening=opening_acc, amt=amt, closing=opening_acc + amt, nbv=a["cost"] - opening_acc - amt))
    steps.append({"id": "depreciation", "title": "Depreciation", "diff": -bal("1510") - sum(r["closing"] for r in dep_rows),
                  "summary": f"Depreciation of {usd(sum(r['amt'] for r in dep_rows))} on {sum(1 for r in dep_rows if r['amt'])} of {len(dep_rows)} assets.",
                  "detail": {"rows": dep_rows}})

    # 6 — accruals
    pays = sorted(e["date"] for e in books["events"] if e["type"] == "payroll" and e["date"] <= end)
    last_pay = pays[-1] if pays else books["opening"]["lastPayroll"]
    days = max(0, day_diff(last_pay, end))
    loan_balance = max(0, -books["opening"]["balances"].get("2500", 0))  # interest runs on the balance owed at the start of the month
    items = [
        {"key": "wages", "name": "Wages earned since last payroll", "amount": days * s["dailyWage"], "exp": "6000", "liab": "2200",
         "basis": f"{days} days × {usd(s['dailyWage'])}/day (last payroll {short_date(last_pay)})"},
        {"key": "utilities", "name": "Unbilled utilities", "amount": s["utilityEstimate"], "exp": "6200", "liab": "2210",
         "basis": "Estimate – this month's bill arrives next month"},
        {"key": "interest", "name": "Loan interest", "amount": loan_interest(loan_balance), "exp": "7000", "liab": "2220",
         "basis": f"{usd(loan_balance)} loan balance × {s['loan']['rateBps'] / 100:g}% ÷ 12"},
    ]
    for it in items:
        it["posted"] = it["amount"] > 0 and not (f.get("dropWagesAccrual") and it["key"] == "wages")
        if it["posted"]:
            post("accruals", {"tag": f"accrual:{it['key']}", "memo": f"Accrue {it['name'].lower()}", "lines": [dr(it["exp"], it["amount"]), cr(it["liab"], it["amount"])]})
        it["gl"] = -bal(it["liab"])
    steps.append({"id": "accruals", "title": "Accruals", "diff": sum(it["gl"] - it["amount"] for it in items),
                  "summary": f"Accrued {usd(sum(i['amount'] for i in items if i['posted']))} of expenses incurred but not yet paid.",
                  "detail": {"items": items}})

    # 7 — gift card liability
    sold = sum(e["amount"] for e in books["events"] if e["type"] == "giftcard_sold")
    redeemed = sum(e["amount"] + pct(e["amount"], s["taxBps"]) for e in books["events"] if e["type"] == "giftcard_redeemed")
    gift_open = books["opening"]["giftCards"]
    expected = gift_open + sold - redeemed
    steps.append({"id": "giftcards", "title": "Gift card liability", "diff": -bal("2300") - expected,
                  "summary": f"Opening {usd(gift_open)} + sold {usd(sold)} − redeemed {usd(redeemed)} = {usd(expected)} still owed to customers.",
                  "detail": {"opening": gift_open, "sold": sold, "redeemed": redeemed, "expected": expected}})

    # 8 — sales tax
    taxable = collected = 0
    for e in books["events"]:
        sign = 1 if e["type"] in ("book_sale", "cafe_sale", "giftcard_redeemed") else -1 if e["type"] == "sale_return" else 0
        if sign:
            taxable += sign * e["amount"]
            collected += sign * pct(e["amount"], s["taxBps"])
    remitted = sum(e["amount"] for e in books["events"] if e["type"] == "sales_tax_remittance")
    tax_open = books["opening"]["salesTax"]
    expected = tax_open + collected - remitted
    steps.append({"id": "salestax", "title": "Sales tax", "diff": -bal("2100") - expected,
                  "summary": f"8% on {usd(taxable)} of net taxable sales = {usd(collected)} collected; {usd(expected)} owed to the state next month.",
                  "detail": {"opening": tax_open, "taxable": taxable, "collected": collected, "remitted": remitted, "expected": expected}})

    # 9 — statements + lock
    tb = trial_balance(ledger)
    st = statements(tb)
    seal = {"period": p, "inputHash": fingerprint(_serialize(books["entries"])), "ledgerHash": fingerprint(_serialize(ledger))}
    steps.append({"id": "close", "title": "Financial statements & period lock", "diff": st["bsDiff"],
                  "summary": f"Net income {usd(st['netIncome'])}. Balance sheet {'balances' if st['bsDiff'] == 0 else 'is OUT of balance'}. Period seal {seal['inputHash']}.",
                  "detail": {"lock": seal}})
    for i, stp in enumerate(steps):
        stp["n"] = i + 1
        stp["entries"] = [j for j in adjustments if j["step"] == stp["id"]]
        stp["ok"] = stp["diff"] == 0 and not stp.get("exceptions")

    res = {"period": p, "ledger": ledger, "adjustments": adjustments, "steps": steps, "tb": tb, "statements": st, "lock": seal}
    ctl = run_controls(books, res, lock)
    res.update(findings=ctl["findings"], flux=ctl["flux"], controlStatus=ctl["status"])
    crit = sum(1 for x in res["findings"] if x["severity"] == "CRITICAL")
    warn = sum(1 for x in res["findings"] if x["severity"] == "WARN")
    res["verdict"] = "BLOCKED" if crit else "CLOSED WITH WARNINGS" if warn else "CLOSED CLEAN"
    res["counts"] = {"crit": crit, "warn": warn}
    return res


def trial_balance(ledger: list[dict]) -> dict:
    totals: dict[str, list[int]] = {}
    for je in ledger:
        for l in je["lines"]:
            t = totals.setdefault(l["acct"], [0, 0])
            t[0] += l["dr"]
            t[1] += l["cr"]
    rows = []
    for a in ACCOUNTS:
        if a["code"] in totals:
            net = totals[a["code"]][0] - totals[a["code"]][1]
            rows.append(dict(a, net=net, dr=max(net, 0), cr=max(-net, 0)))
    return {"rows": rows, "totalDr": sum(r["dr"] for r in rows), "totalCr": sum(r["cr"] for r in rows)}


def statements(tb: dict) -> dict:
    net = {r["code"]: r["net"] for r in tb["rows"]}
    of = lambda t: [r for r in tb["rows"] if r["type"] == t]
    revenue = [dict(r, amount=-r["net"]) for r in of("R")]
    expenses = [dict(r, amount=r["net"]) for r in of("X")]
    total_revenue, total_expenses = sum(r["amount"] for r in revenue), sum(r["amount"] for r in expenses)
    net_income = total_revenue - total_expenses
    net_sales = -(net.get("4000", 0) + net.get("4010", 0) + net.get("4100", 0))
    cogs = sum(net.get(c, 0) for c in ("5000", "5010", "5020", "5030"))  # books + shrinkage + café + waste
    assets = [dict(r, amount=r["net"]) for r in of("A")]
    liabilities = [dict(r, amount=-r["net"]) for r in of("L")]
    equity = [dict(r, amount=-r["net"]) for r in of("E")]
    total_assets, total_liabilities = sum(r["amount"] for r in assets), sum(r["amount"] for r in liabilities)
    total_equity = sum(r["amount"] for r in equity) + net_income
    return {"revenue": revenue, "expenses": expenses, "totalRevenue": total_revenue, "totalExpenses": total_expenses,
            "netIncome": net_income, "netSales": net_sales, "cogs": cogs, "grossProfit": net_sales - cogs,
            "assets": assets, "liabilities": liabilities, "equity": equity, "totalAssets": total_assets,
            "totalLiabilities": total_liabilities, "totalEquity": total_equity,
            "bsDiff": total_assets - total_liabilities - total_equity}


# ---------- independent shadow recompute (deliberately different code from the posting path) ----------

def _straight_line(total: int, count: int, k: int) -> int:
    if k < 0 or k >= count:
        return 0
    per, left = total // count, total
    for _ in range(k):
        left -= per
    return left if k == count - 1 else per


def shadow_prepaid(pp: dict, p: str) -> int:
    return _straight_line(pp["total"], pp["months"], month_index(p) - month_index(pp["start"]))


def shadow_dep(a: dict, p: str) -> int:
    return _straight_line(a["cost"], a["life"], month_index(p) - month_index(a["inService"]) - 1)


def shadow_interest(loan: dict) -> int:
    return round_half_up(loan["principal"] * loan["rateBps"], 12 * 10000)


CONTROLS = [
    ("C1", "Balanced entries", "An entry — or the trial balance — where debits do not equal credits."),
    ("C2", "Reconciliations tie", "A bank, card, stock, prepaid, asset, accrual, gift-card or sales-tax balance that does not agree with its support."),
    ("C3", "Completeness", "A month-end entry that was forgotten, posted twice, or should not exist."),
    ("C4", "Asset-life guard", "A fully depreciated asset that keeps depreciating, or depreciation beyond cost."),
    ("C5", "Fluctuation review", "An expense that moves more than 20% and more than $100 versus last month without an explanation."),
    ("C6", "Balance sheet balances", "Assets not equal to Liabilities + Equity."),
    ("C7", "Shadow recompute", "A wrong amount in the posting path — every close amount is recomputed independently."),
    ("C8", "Period lock", "A closed month quietly edited after it was locked."),
]


def run_controls(books: dict, res: dict, lock: dict | None = None) -> dict:
    s, p = SETUP, books["period"]
    end, prev = period_end(p), shift_period(p, -1)
    findings: list[dict] = []

    def add(control: str, severity: str, message: str, detail: str = "") -> None:
        findings.append({"control": control, "severity": severity, "message": message, "detail": detail})

    posted = lambda tag: [j for j in res["adjustments"] if j.get("tag") == tag]
    posted_to = lambda tag, code: sum(l["dr"] - l["cr"] for j in posted(tag) for l in j["lines"] if l["acct"] == code)

    # C1 balanced entries
    for je in res["ledger"]:
        d, c = line_total(je["lines"], "dr"), line_total(je["lines"], "cr")
        if d != c:
            add("C1", "CRITICAL", f"Entry {je['id']} does not balance", f"{je['memo']}: debits {usd(d)} vs credits {usd(c)}")
    if res["tb"]["totalDr"] != res["tb"]["totalCr"]:
        add("C1", "CRITICAL", "Trial balance does not balance", f"Debits {usd(res['tb']['totalDr'])} vs credits {usd(res['tb']['totalCr'])}")

    # C2 reconciliations tie
    for stp in res["steps"]:
        if stp["id"] == "close":
            continue
        if stp["diff"] != 0:
            add("C2", "CRITICAL", f"{stp['title']} does not tie", f"Unexplained difference of {usd(stp['diff'])} between the ledger and the support.")
        for x in stp.get("exceptions", []):
            add("C2", "CRITICAL", "Unexplained bank statement line", f"{x['date']} {x['desc']} {usd(x['amount'])}")

    # C3 completeness — expected entries derived independently from the sub-ledgers and documents
    expected: dict[str, int] = {}
    exp = lambda tag: expected.__setitem__(tag, expected.get(tag, 0) + 1)
    for r in books["docs"]["processor"]:
        if r["settleDate"] <= end:
            exp("card-settlement")
    for l in books["docs"]["bank"]["lines"]:
        if "service fee" in l["desc"].lower():
            exp("bank-fee")
        elif "interest earned" in l["desc"].lower():
            exp("bank-interest")
    if books["docs"]["count"]["value"] != books["docs"]["count"]["book"]:
        exp("shrinkage")
    if books["docs"]["cafeCount"]["value"] != books["docs"]["cafeCount"]["book"]:
        exp("cafe-waste")
    for pp in books["prepaids"]:
        if shadow_prepaid(pp, p) > 0:
            exp(f"prepaid:{pp['id']}")
    for a in books["assets"]:
        if shadow_dep(a, p) > 0:
            exp(f"dep:{a['id']}")
    pays = sorted(e["date"] for e in books["events"] if e["type"] == "payroll")
    if day_diff(pays[-1] if pays else books["opening"]["lastPayroll"], end) > 0:
        exp("accrual:wages")
    exp("accrual:utilities")
    if loan_interest(-books["opening"]["balances"].get("2500", 0)) > 0:  # no loan left, no interest to accrue
        exp("accrual:interest")
    actual: dict[str, int] = {}
    for j in res["adjustments"]:
        actual[j["tag"]] = actual.get(j["tag"], 0) + 1
    nice = lambda tag: tag.replace("accrual:", "accrual – ").replace("prepaid:", "prepaid – ").replace("dep:", "depreciation – ")
    for tag, e in expected.items():
        a = actual.get(tag, 0)
        if a < e:
            add("C3", "CRITICAL", f"Missing month-end entry: {nice(tag)}", f"Expected {e}, found {a}.")
        if a > e:
            add("C3", "CRITICAL", f"Duplicate month-end entry: {nice(tag)}", f"Expected {e}, found {a}.")
    for tag in actual:
        if tag not in expected:
            add("C3", "CRITICAL", f"Unexpected month-end entry: {nice(tag)}", "Nothing in the sub-ledgers calls for this entry.")

    # C4 asset-life guard
    for a in books["assets"]:
        dep = posted_to(f"dep:{a['id']}", "6500")
        months_used = min(max(month_index(prev) - month_index(a["inService"]), 0), a["life"])
        opening_acc = (a["cost"] if months_used >= a["life"] else a["cost"] // a["life"] * months_used) if month_index(prev) > month_index(a["inService"]) else 0
        if dep > 0 and months_used >= a["life"]:
            add("C4", "CRITICAL", f"Fully depreciated asset still depreciating: {a['name']}", f"{months_used} of {a['life']} months already used; {usd(dep)} posted this month.")
        if opening_acc + dep > a["cost"]:
            add("C4", "CRITICAL", f"Accumulated depreciation exceeds cost: {a['name']}", f"{usd(opening_acc + dep)} vs cost {usd(a['cost'])}.")

    # C5 fluctuation review vs last month (actual when last month was closed here, else the preset baseline)
    base = books["opening"]["expenseBaseline"] or baseline(p)
    flux = []
    schedule_expected = {
        "6400": sum(shadow_prepaid(x, p) for x in books["prepaids"] if x["expense"] == "6400"),
        "6410": sum(shadow_prepaid(x, p) for x in books["prepaids"] if x["expense"] == "6410"),
        "6500": sum(shadow_dep(a, p) for a in books["assets"]),
    }
    for a in (x for x in ACCOUNTS if x["type"] == "X"):
        cur, prior = acct_sum(res["ledger"], a["code"]), base.get(a["code"], 0)
        delta = cur - prior
        big = abs(delta) > 10000 and (prior == 0 or abs(delta) * 100 > 20 * abs(prior))
        status = "OK"
        if big:
            pct_change = None if prior == 0 else delta * 100 / prior
            if a["code"] in schedule_expected and cur == schedule_expected[a["code"]]:
                status = "Explained"
                change = "from zero" if pct_change is None else f"{pct_change:.0f}%"
                add("C5", "INFO", f"{a['name']} moved {change} — explained by its schedule", "A prepaid ended/started or an asset finished/started depreciating.")
            else:
                status = "Review"
                change = "from zero" if pct_change is None else f"{pct_change:+.0f}%"
                add("C5", "WARN", f"{a['name']} moved {change} vs last month",
                    f"{usd(prior)} → {usd(cur)} ({'+' if delta > 0 else ''}{usd(delta)}). Needs an explanation.")
        if cur or prior:
            flux.append({"code": a["code"], "name": a["name"], "prior": prior, "cur": cur, "delta": delta, "status": status})

    # C6 balance sheet
    if res["statements"]["bsDiff"] != 0:
        add("C6", "CRITICAL", "Balance sheet does not balance", f"Assets − (Liabilities + Equity) = {usd(res['statements']['bsDiff'])}")

    # C7 shadow recompute
    def check(label: str, posted_amt: int, shadow_amt: int) -> None:
        if posted_amt != shadow_amt:
            add("C7", "CRITICAL", f"Shadow recompute disagrees: {label}", f"Posted {usd(posted_amt)}, independent recompute {usd(shadow_amt)}.")
    for pp in books["prepaids"]:
        check(pp["name"], posted_to(f"prepaid:{pp['id']}", pp["expense"]), shadow_prepaid(pp, p))
    for a in books["assets"]:
        check(f"depreciation – {a['name']}", posted_to(f"dep:{a['id']}", "6500"), shadow_dep(a, p))
    check("loan interest accrual", posted_to("accrual:interest", "7000"), shadow_interest({"principal": max(0, -books["opening"]["balances"].get("2500", 0)), "rateBps": s["loan"]["rateBps"]}))
    check("card settlement cash", posted_to("card-settlement", "1000"),
          sum(r["gross"] - (round_half_up(r["gross"] * s["cardFeeBps"], 10000) if r["gross"] > 0 else 0)
              for r in books["docs"]["processor"] if r["settleDate"] <= end))

    # C8 period lock
    if lock and any(lock.get(key) != res["lock"][key] for key in ("period", "inputHash", "ledgerHash")):
        add("C8", "CRITICAL", "Closed period was changed after it was locked",
            f"Sealed period {lock.get('period')}, current {p}. Sealed input {lock.get('inputHash')}, current {res['lock']['inputHash']}. "
            f"Sealed ledger {lock.get('ledgerHash')}, current {res['lock']['ledgerHash']}.")

    order = {"CRITICAL": 0, "WARN": 1, "INFO": 2}
    findings.sort(key=lambda x: (order[x["severity"]], x["control"]))
    status = {}
    for cid, _, _ in CONTROLS:
        fs = [x for x in findings if x["control"] == cid]
        status[cid] = "FAIL" if any(x["severity"] == "CRITICAL" for x in fs) else "WARN" if any(x["severity"] == "WARN" for x in fs) else "PASS"
    return {"findings": findings, "flux": flux, "status": status}


# ---------- roll-forward and the year ----------

def closing_snapshot(books: dict, res: dict) -> dict:
    """Everything the next month needs to open exactly where this month closed."""
    end = period_end(books["period"])
    balances = {r["code"]: r["net"] for r in res["tb"]["rows"] if r["type"] in "ALE" and r["net"]}
    balances["3100"] = balances.get("3100", 0) - res["statements"]["netIncome"]  # profit moves into retained earnings
    pays = sorted(e["date"] for e in books["events"] if e["type"] == "payroll" and e["date"] <= end)
    bank = next(s for s in res["steps"] if s["id"] == "bank")["detail"]
    return {
        "period": books["period"], "balances": balances,
        "lastPayroll": pays[-1] if pays else books["opening"]["lastPayroll"],
        "cardRows": [{"saleDate": r["saleDate"], "gross": r["gross"]} for r in books["docs"]["processor"] if r["settleDate"] > end],
        "bankClosing": books["docs"]["bank"]["closing"],
        "bankOutstanding": [{"date": o["date"], "amount": o["amount"],
                             "memo": o["memo"] if o.get("broughtForward") else f"{o['memo']} (from {period_label(books['period'])})"}
                            for o in bank["outstanding"]],
        "bankAfterPeriod": [dict(l) for l in books["docs"]["bank"]["afterPeriod"]],
        "assets": [dict(a) for a in books["assets"] if a["id"].startswith("eq-")],
        "prepaids": [dict(pp) for pp in books["prepaids"] if pp["id"].startswith("pp-")],  # renewals keep amortising next month
        "expenses": {r["code"]: r["net"] for r in res["tb"]["rows"] if r["type"] == "X"},
    }


def close_month(month_state: dict, prior: dict | None, faults: dict | None = None, lock: dict | None = None) -> dict:
    """Build and close one month on top of the previous month's closing snapshot."""
    books = build_books({**month_state, "prior": prior})
    result = run_close(books, faults, lock)
    return {"books": books, "result": result, "snapshot": closing_snapshot(books, result) if result["counts"]["crit"] == 0 else None}


def close_year(seed: int = 2026) -> list[dict]:
    """Generate and close every month of the year in order, each opening from the previous close.
    Stops at the first month blocked by a critical finding."""
    closed, prior = [], None
    for p in PERIODS:
        g = generate_month(p, seed, opening(p, prior))
        month_state = {"period": p, "seed": seed, "events": g["events"], "shrinkBps": g["shrinkBps"],
                       "cafeWasteBps": g["cafeWasteBps"], "countOverride": None}
        out = close_month(month_state, prior)
        closed.append({"period": p, **out})
        if out["snapshot"] is None:
            break
        prior = out["snapshot"]
    return closed


YEAR_LINES = ["4000", "4010", "4100", "5000", "5010", "5020", "5030", "6000", "6100", "6200", "6300",
              "6400", "6410", "6500", "6600", "6700", "4900", "7000"]


def year_statements(closed: list[dict]) -> dict | None:
    """Year-to-date statements from a run of consecutive closed months."""
    closed = [c for c in closed if c["result"]["counts"]["crit"] == 0]
    if not closed:
        return None
    months = []
    for c in closed:
        st = c["result"]["statements"]
        amounts = {r["code"]: r["amount"] for r in st["revenue"] + st["expenses"]}
        months.append({"period": c["period"], "st": st, "lines": {code: amounts.get(code, 0) for code in YEAR_LINES}})
    total = lambda key: sum(key(m) for m in months)
    opening_st = statements(trial_balance([j for j in closed[0]["books"]["entries"] if j["source"] == "opening"]))
    closing_st = closed[-1]["result"]["statements"]
    ytd_ni = total(lambda m: m["st"]["netIncome"])
    return {
        "months": months,
        "totals": {"lines": {c: total(lambda m, c=c: m["lines"][c]) for c in YEAR_LINES},
                   "netSales": total(lambda m: m["st"]["netSales"]), "cogs": total(lambda m: m["st"]["cogs"]),
                   "grossProfit": total(lambda m: m["st"]["grossProfit"]), "netIncome": ytd_ni},
        "opening": opening_st, "closing": closing_st, "openingEquity": opening_st["totalEquity"],
        "equityCheck": opening_st["totalEquity"] + ytd_ni - closing_st["totalEquity"],  # must be 0
        "firstPeriod": closed[0]["period"], "lastPeriod": closed[-1]["period"],
    }


# ---------- fault-injection demo ----------

def _add_unbalanced(ev: list) -> list:
    ev.append({"id": "fx1", "date": ev[len(ev) // 2]["date"], "type": "supplies", "source": "generated", "amount": 12345, "unbalance": 1000})
    return ev


def _wrong_tax(ev: list) -> list:
    next(x for x in ev if x["type"] == "book_sale")["taxBps"] = 700
    return ev


def _double_rent(ev: list) -> list:
    r = next(x for x in ev if x["type"] == "rent")
    ev.append(dict(r, id="fx2"))
    return ev


FAULTS: list[dict[str, Any]] = [
    {"id": "unbalanced_entry", "label": "An unbalanced journal entry slips into the books", "expect": "C1", "build": {"events": _add_unbalanced}},
    {"id": "opening_typo", "label": "Opening cash keyed in $500 too high", "expect": "C6", "build": {"openingCashTypo": 50000}},
    {"id": "bank_fee_missed", "label": "The bank's service fee is never booked", "expect": "C2", "close": {"skipBankFee": True}},
    {"id": "wrong_tax", "label": "A sale is taxed at 7% instead of 8%", "expect": "C2", "build": {"events": _wrong_tax}},
    {"id": "missing_accrual", "label": "The month-end wages accrual is forgotten", "expect": "C3", "close": {"dropWagesAccrual": True}},
    {"id": "dead_asset", "label": "A fully depreciated asset keeps depreciating", "expect": "C4", "close": {"deadAssetDepreciates": True}},
    {"id": "double_rent", "label": "Rent is recorded twice", "expect": "C5", "build": {"events": _double_rent}},
    {"id": "tampered_amount", "label": "An amortization amount is altered in the posting path", "expect": "C7", "close": {"tamperPrepaid": True}},
    {"id": "edited_after_lock", "label": "A closed month is edited after it was locked", "expect": "C8", "afterLock": True},
]


def run_guardrail_demo(period: str, seed: int = 2026) -> dict:
    """Plant each classic mistake into a clean generated month and check the intended control catches it."""
    g = generate_month(period, seed)
    state = {"period": period, "seed": seed, "events": g["events"], "shrinkBps": g["shrinkBps"],
             "cafeWasteBps": g["cafeWasteBps"], "countOverride": None}
    base = run_close(build_books(state))
    loud = lambda r: [x for x in r["findings"] if x["severity"] != "INFO"]
    results = [{"id": "baseline", "label": "Baseline – clean generated month, no fault", "expect": "—",
                "pass": not loud(base), "caught": None, "also": sorted({x["control"] for x in loud(base)})}]
    for fx in FAULTS:
        if fx.get("afterLock"):
            first_date = state["events"][0]["date"]
            edited_events = [dict(e, amount=e["amount"] + 100) if e["type"] == "book_sale" and e["date"] == first_date and e.get("method") == "cash" else e
                             for e in state["events"]]
            res = run_close(build_books(dict(state, events=edited_events)), lock=base["lock"])
        else:
            res = run_close(build_books(copy.deepcopy(state), fx.get("build")), faults=fx.get("close"))
        hit = next((x for x in res["findings"] if x["control"] == fx["expect"]
                    and (x["severity"] == "CRITICAL" or (fx["expect"] == "C5" and x["severity"] == "WARN"))), None)
        results.append({"id": fx["id"], "label": fx["label"], "expect": fx["expect"], "pass": hit is not None, "caught": hit,
                        "also": sorted({x["control"] for x in loud(res)} - {fx["expect"]}), "verdict": res["verdict"]})
    return {"period": period, "seed": seed, "results": results, "allHeld": all(r["pass"] for r in results)}

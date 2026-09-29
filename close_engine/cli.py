"""Command line for the close engine.

    python -m close_engine year  [--seed 2026] [--excel fy2026.xlsx]
    python -m close_engine month --period 2026-03 [--seed 2026]
    python -m close_engine demo  [--period 2026-06] [--seed 2026]

Exit code is non-zero when a month is blocked or a guardrail fails, so it can gate a pipeline.
"""
from __future__ import annotations

import argparse
import sys

from .close import CONTROLS, acct_sum, close_year, run_guardrail_demo, year_statements
from .core import PERIODS, SETUP, YEAR, fmt, period_label, usd


def _rule(width: int = 78) -> str:
    return "-" * width


def cmd_year(args: argparse.Namespace) -> int:
    closed = close_year(args.seed)
    ys = year_statements(closed)
    print(f"{SETUP['company']} – FY {YEAR} (seed {args.seed})")
    print(_rule())
    print(f"{'Month':<16}{'Verdict':<22}{'Net sales':>14}{'Net income':>14}{'Cash':>14}")
    for c in closed:
        r = c["result"]
        print(f"{period_label(c['period']):<16}{r['verdict']:<22}{fmt(r['statements']['netSales']):>14}"
              f"{fmt(r['statements']['netIncome']):>14}{fmt(acct_sum(r['ledger'], '1000')):>14}")
    print(_rule())
    if ys:
        t = ys["totals"]
        print(f"{'FY total':<38}{fmt(t['netSales']):>14}{fmt(t['netIncome']):>14}")
        print(f"Gross profit {usd(t['grossProfit'])} ({t['grossProfit'] * 100 / t['netSales']:.1f}% of sales)")
        print()
        print("Year checks")
        ok = lambda b: "PASS" if b else "FAIL"
        print(f"  {ok(ys['equityCheck'] == 0)}  equity rolls forward: {usd(ys['openingEquity'])} + {usd(t['netIncome'])} "
              f"- {usd(ys['closing']['totalEquity'])} = {usd(ys['equityCheck'])}")
        print(f"  {ok(ys['closing']['bsDiff'] == 0)}  closing balance sheet balances")
        print(f"  {ok(len(closed) == len(PERIODS))}  {len(closed)} of {len(PERIODS)} months closed in an unbroken chain")
        warn_months = [period_label(c['period']) for c in closed if c['result']['counts']['warn']]
        print(f"  {ok(all(c['result']['counts']['crit'] == 0 for c in closed))}  every month passed its controls"
              + (f" (warnings to explain: {', '.join(warn_months)})" if warn_months else ""))
    if args.excel and ys:
        from .excel import export_year  # openpyxl is only needed for the export
        print(f"\nExcel workbook written: {export_year(closed, ys, args.excel)}")
    blocked = any(c["result"]["counts"]["crit"] for c in closed) or len(closed) < len(PERIODS)
    return 1 if blocked else 0


def cmd_month(args: argparse.Namespace) -> int:
    if args.period not in PERIODS:
        print(f"Period must be one of {PERIODS[0]} … {PERIODS[-1]}", file=sys.stderr)
        return 2
    closed = close_year(args.seed)
    match = next((c for c in closed if c["period"] == args.period), None)
    if match is None:
        print(f"{period_label(args.period)} could not start: an earlier month was blocked.", file=sys.stderr)
        return 1
    r = match["result"]
    st = r["statements"]
    print(f"{SETUP['company']} – month-end close, {period_label(args.period)}")
    print(_rule())
    for stp in r["steps"]:
        print(f"{stp['n']}. {stp['title']:<38}{'Tied' if stp['ok'] else 'EXCEPTION'}")
        print(f"   {stp['summary']}")
    print(_rule())
    print(f"Net sales {usd(st['netSales'])} · gross profit {usd(st['grossProfit'])} · net income {usd(st['netIncome'])}")
    print(f"Total assets {usd(st['totalAssets'])} · balance sheet difference {usd(st['bsDiff'])}")
    print(f"Adjusting entries posted: {len(r['adjustments'])} · period seal {r['lock']['inputHash']}")
    print()
    print("Controls")
    for cid, name, _ in CONTROLS:
        print(f"  {cid} {name:<26}{r['controlStatus'][cid]}")
    for fnd in r["findings"]:
        print(f"  - {fnd['severity']:<8}{fnd['control']}  {fnd['message']}. {fnd['detail']}")
    print()
    print(f"Verdict: {r['verdict']}")
    return 1 if r["counts"]["crit"] else 0


def cmd_demo(args: argparse.Namespace) -> int:
    d = run_guardrail_demo(args.period, args.seed)
    print(f"Guardrail demo – {period_label(args.period)} (seed {args.seed})")
    print(_rule())
    for x in d["results"]:
        caught = x["caught"]["message"] if x["caught"] else ("no findings" if x["id"] == "baseline" else "NOT CAUGHT")
        status = "PASS" if x["pass"] else "FAIL"
        print(f"  {status}  {x['label']:<56} -> {x['expect']:<3} {caught}")
    print(_rule())
    print("ALL GUARDRAILS HELD" if d["allHeld"] else "A GUARDRAIL FAILED")
    return 0 if d["allHeld"] else 1


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):  # the Windows console defaults to a code page without "–" or "×"
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(prog="close_engine", description="Quincy Bookstore – automated month-end close")
    sub = parser.add_subparsers(dest="command", required=True)
    p_year = sub.add_parser("year", help="generate and close all 12 months, print the year, optionally export Excel")
    p_year.add_argument("--seed", type=int, default=2026)
    p_year.add_argument("--excel", metavar="PATH", help="write the year to an Excel workbook")
    p_year.set_defaults(func=cmd_year)
    p_month = sub.add_parser("month", help="print one month's close report")
    p_month.add_argument("--period", required=True, help="e.g. 2026-03")
    p_month.add_argument("--seed", type=int, default=2026)
    p_month.set_defaults(func=cmd_month)
    p_demo = sub.add_parser("demo", help="plant nine classic mistakes and show each one caught")
    p_demo.add_argument("--period", default="2026-03")
    p_demo.add_argument("--seed", type=int, default=2026)
    p_demo.set_defaults(func=cmd_demo)
    args = parser.parse_args(argv)
    return args.func(args)

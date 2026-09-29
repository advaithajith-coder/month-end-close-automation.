import json
import pathlib
import sys

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from close_engine import close_year, year_statements  # noqa: E402


@pytest.fixture(scope="session")
def golden() -> dict:
    """Results of the JavaScript engine for FY 2026 (written by tools/export_golden.js)."""
    return json.loads((ROOT / "tests" / "golden_fy2026.json").read_text(encoding="utf-8"))


@pytest.fixture(scope="session")
def closed_year() -> list[dict]:
    return close_year(2026)


@pytest.fixture(scope="session")
def year(closed_year) -> dict:
    return year_statements(closed_year)

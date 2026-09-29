"""The browser's Excel export (js/excel.js) and the Python export must produce the same workbook:
same sheets, same cells, same values, same formulas, same number formats.

Needs Node and the exceljs package (npm install); skipped otherwise.
"""
import pathlib
import shutil
import subprocess

import pytest

openpyxl = pytest.importorskip("openpyxl")
from close_engine.excel import export_year  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[1]


@pytest.fixture(scope="module")
def both(closed_year, year, tmp_path_factory):
    node = shutil.which("node")
    if not node or not (ROOT / "node_modules" / "exceljs").exists():
        pytest.skip("node and the exceljs package are needed (run npm install)")
    tmp = tmp_path_factory.mktemp("parity")
    js_path, py_path = tmp / "browser.xlsx", tmp / "python.xlsx"
    subprocess.run([node, str(ROOT / "tools" / "export_xlsx.js"), str(js_path), "2026"], check=True, cwd=ROOT, capture_output=True)
    export_year(closed_year, year, str(py_path))
    return openpyxl.load_workbook(js_path), openpyxl.load_workbook(py_path)


def test_same_sheets(both):
    js, py = both
    assert js.sheetnames == py.sheetnames


@pytest.mark.parametrize("sheet", ["Summary", "Income Statement", "Balance Sheet", "Trial Balance", "Journal", "Close Log"])
def test_every_cell_matches(both, sheet):
    js, py = both[0][sheet], both[1][sheet]
    rows, cols = max(js.max_row, py.max_row), max(js.max_column, py.max_column)
    mismatches = []
    for r in range(1, rows + 1):
        for c in range(1, cols + 1):
            a, b = js.cell(row=r, column=c), py.cell(row=r, column=c)
            if a.value != b.value:
                mismatches.append((a.coordinate, a.value, b.value))
            elif a.value is not None and isinstance(a.value, (int, float)) and a.number_format != b.number_format:
                mismatches.append((a.coordinate, a.number_format, b.number_format))
    assert not mismatches, f"{len(mismatches)} cells differ, first: {mismatches[:5]}"

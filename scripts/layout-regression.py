#!/usr/bin/env python3
"""
Automated layout regression check for the test-paper generator.

Renders a sample paper (tests/fixtures/sample-paper.json) in a headless
Chromium against the running dev server and asserts, for BOTH the 1-column and
2-column layouts at desktop / tablet / mobile breakpoints:

  1. no diagram exceeds its physical millimetre cap (45mm question, 34mm option)
  2. no diagram overflows its container
  3. no option grid (.options) is split across a column or page break
  4. the millimetre caps scale proportionally with the A4 sheet on every
     breakpoint (the sheet is zoomed, never reflowed narrower)

It then prints the paper to a real A4 PDF and verifies no image is clipped by a
page boundary.

Usage:  python3 scripts/layout-regression.py [--url http://localhost:8080]
Exit code 0 = all checks passed, 1 = regression detected.
"""

import argparse
import asyncio
import base64
import io
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parent.parent
FIXTURE_DIR = ROOT / "tests" / "fixtures"


MM = 3.779527559  # CSS px per mm at 96dpi
Q_CAP = 45.0
OPT_CAP = 34.0
TOL = 0.6  # mm rounding tolerance
BREAKPOINTS = [("desktop", 1280, 1800), ("tablet", 834, 1112), ("mobile", 390, 844)]


def make_diagram(w: int, h: int) -> str:
    """Deterministic placeholder diagram as a data URL (no binary fixtures)."""
    img = Image.new("RGB", (w, h), "white")
    d = ImageDraw.Draw(img)
    d.rectangle([2, 2, w - 3, h - 3], outline="black", width=3)
    d.line([2, 2, w - 3, h - 3], fill="black", width=3)
    d.line([2, h - 3, w - 3, 2], fill="black", width=3)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def build_paper() -> list:
    """Sample paper covering every layout hazard: tall/wide/square diagrams,
    display math, truth tables with captions, and long wrapping text."""
    tall = make_diagram(400, 800)
    wide = make_diagram(900, 300)
    square = make_diagram(600, 600)
    rows = []
    for i in range(1, 31):
        m = i % 4
        if m == 0:
            q = {"text": f"Which Newman projection is staggered? (Q{i})", "image": tall}
            o = {k: {"text": "", "image": square} for k in "ABCD"}
        elif m == 1:
            q = {
                "text": (
                    f"The bulk modulus of a liquid is $3\\times10^{{10}}$ Nm$^{{-2}}$ "
                    f"for case {i}. Find the pressure required."
                )
            }
            o = {k: {"text": f"${i}\\times10^{{3}}$"} for k in "ABCD"}
        elif m == 2:
            q = {"text": f"Match the truth tables for statement {i}."}
            o = {
                k: {
                    "text": (
                        f"<table><caption>Table ({k})</caption>"
                        "<tr><th>P</th><th>Q</th></tr>"
                        "<tr><td>T</td><td>F</td></tr></table>"
                    )
                }
                for k in "ABCD"
            }
        else:
            q = {"text": f"Identify the structure shown (Q{i}).", "image": wide}
            o = {
                k: {"text": f"Option {k} text that is reasonably long to test wrapping."}
                for k in "ABCD"
            }
        rows.append(
            {"qno": i, "subject": "Chemistry", "question": q, "options": o, "answer": "A"}
        )
    return rows


MEASURE = """() => {
  const MM = 3.779527559;
  const paper = document.querySelector('.paper');
  const paperW = paper.getBoundingClientRect().width / MM;
  const scale = paperW / 190; // sheet is pinned to a 190mm A4 text column

  const imgs = [...document.querySelectorAll('.paper img')].map((el) => {
    const r = el.getBoundingClientRect();
    const p = el.parentElement.getBoundingClientRect();
    return {
      opt: !!el.closest('.option'),
      w: r.width / MM / scale,
      h: r.height / MM / scale,
      overflow: r.width > p.width + 1,
    };
  });

  // An option grid is "split" when its own rows land in different columns /
  // pages: detect by comparing each .option's column band against its grid.
  const splits = [...document.querySelectorAll('.paper .options')].filter((ul) => {
    const kids = [...ul.querySelectorAll(':scope > .option')];
    if (kids.length < 2) return false;
    const lefts = kids.map((k) => Math.round(k.getBoundingClientRect().left));
    const tops = kids.map((k) => k.getBoundingClientRect().top);
    const uniqueLefts = [...new Set(lefts)].sort((a, b) => a - b);
    // more than 4 distinct x-origins, or a vertical jump backwards, means the
    // grid was fragmented across a column break
    const jumpedBack = tops.some((t, i) => i > 0 && t < tops[i - 1] - 2);
    return uniqueLefts.length > 4 || jumpedBack;
  }).length;

  return {
    count: imgs.length,
    overCap: imgs.filter((i) => (i.opt ? Math.max(i.w, i.h) > 34.6 : Math.max(i.w, i.h) > 45.6)).length,
    overflowing: imgs.filter((i) => i.overflow).length,
    qMax: +Math.max(...imgs.filter((i) => !i.opt).map((i) => Math.max(i.w, i.h))).toFixed(1),
    optMax: +Math.max(...imgs.filter((i) => i.opt).map((i) => Math.max(i.w, i.h))).toFixed(1),
    splitOptionGrids: splits,
    columnCount: getComputedStyle(document.querySelector('.two-col')).columnCount,
    paperMm: +paperW.toFixed(1),
  };
}"""


class Report:
    def __init__(self):
        self.failures = []

    def check(self, ok: bool, label: str, detail: str = ""):
        print(f"  {'PASS' if ok else 'FAIL'}  {label}{(' — ' + detail) if detail else ''}")
        if not ok:
            self.failures.append(f"{label}{(' — ' + detail) if detail else ''}")


async def run(url: str) -> int:
    data = json.loads(FIXTURE.read_text()) if FIXTURE.exists() else build_paper()
    report = Report()

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True)
        context = await browser.new_context(viewport={"width": 1280, "height": 1800})
        page = await context.new_page()
        await page.goto(url, wait_until="networkidle")
        await page.locator("textarea").first.fill(json.dumps(data))
        await page.wait_for_timeout(2500)

        for layout, value in (("2 columns", "2"), ("1 column", "1")):
            await page.select_option("select", value)
            await page.wait_for_timeout(1500)
            for label, w, h in BREAKPOINTS:
                await page.set_viewport_size({"width": w, "height": h})
                await page.wait_for_timeout(900)
                m = await page.evaluate(MEASURE)
                print(f"\n[{layout} / {label}] {m}")
                report.check(m["count"] > 0, f"{layout}/{label}: diagrams rendered")
                report.check(
                    m["overCap"] == 0,
                    f"{layout}/{label}: no diagram over its mm cap",
                    f"{m['overCap']} over cap",
                )
                report.check(
                    m["overflowing"] == 0,
                    f"{layout}/{label}: no diagram overflows its container",
                    f"{m['overflowing']} overflowing",
                )
                report.check(
                    m["splitOptionGrids"] == 0,
                    f"{layout}/{label}: no option grid split across a break",
                    f"{m['splitOptionGrids']} split",
                )
                report.check(
                    abs(m["qMax"] - Q_CAP) <= TOL and abs(m["optMax"] - OPT_CAP) <= TOL,
                    f"{layout}/{label}: mm caps consistent across breakpoints",
                    f"question {m['qMax']}mm (exp {Q_CAP}), option {m['optMax']}mm (exp {OPT_CAP})",
                )

        # Real A4 print pass — page-break integrity.
        await page.set_viewport_size({"width": 1280, "height": 1800})
        await page.wait_for_timeout(800)
        pdf = await page.pdf(
            format="A4",
            margin={"top": "12mm", "bottom": "12mm", "left": "10mm", "right": "10mm"},
            print_background=True,
        )
        await browser.close()

    print("\n[print / A4]")
    try:
        import fitz  # PyMuPDF
    except ImportError:
        print("  SKIP  PyMuPDF not installed — page-break check skipped")
        return finish(report)

    doc = fitz.open(stream=pdf, filetype="pdf")
    pt = 72 / 25.4
    clipped = oversize = 0
    for pg in doc:
        top, bottom = 12 * pt, pg.rect.height - 12 * pt
        for im in pg.get_image_info():
            x0, y0, x1, y1 = im["bbox"]
            if y0 < top - 1 or y1 > bottom + 1:
                clipped += 1
            if (x1 - x0) / pt > Q_CAP + TOL or (y1 - y0) / pt > Q_CAP + TOL:
                oversize += 1
    print(f"  pages={doc.page_count}")
    report.check(clipped == 0, "print: no diagram clipped by a page break", f"{clipped} clipped")
    report.check(oversize == 0, "print: no diagram over 45mm in the PDF", f"{oversize} oversize")
    return finish(report)


def finish(report: Report) -> int:
    print()
    if report.failures:
        print(f"REGRESSION: {len(report.failures)} check(s) failed")
        for f in report.failures:
            print(f"  - {f}")
        return 1
    print("All layout regression checks passed.")
    return 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:8080")
    ap.add_argument("--write-fixture", action="store_true", help="regenerate the sample JSON")
    args = ap.parse_args()
    if args.write_fixture:
        FIXTURE.parent.mkdir(parents=True, exist_ok=True)
        FIXTURE.write_text(json.dumps(build_paper()))
        print(f"wrote {FIXTURE}")
        sys.exit(0)
    sys.exit(asyncio.run(run(args.url)))

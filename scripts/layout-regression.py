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


def _table(caption: str, rows: int, cols: int) -> str:
    head = "".join(f"<th>C{c + 1}</th>" for c in range(cols))
    body = "".join(
        "<tr>" + "".join(f"<td>{(r * cols + c) % 2 and 'T' or 'F'}</td>" for c in range(cols)) + "</tr>"
        for r in range(rows)
    )
    return f"<table><caption>{caption}</caption><tr>{head}</tr>{body}</table>"


def build_long_tables() -> list:
    """EXTREME: very long / very wide tables in both the stem and the options.
    Targets vertical text collapse, cell nowrap, caption attachment and
    break-inside behaviour when a single block is taller than a column."""
    rows = []
    for i in range(1, 17):
        tall_rows = 6 + (i % 4) * 8  # up to 30 data rows — taller than one column
        cols = 3 + (i % 4)  # up to 6 columns — wider than one column
        q = {
            "text": (
                f"Study the data set below and answer part {i}. "
                + _table(f"Data Set ({i})", tall_rows, cols)
            )
        }
        if i % 2:
            o = {k: {"text": _table(f"Table ({k})", 4 + (i % 3) * 6, 2)} for k in "ABCD"}
        else:
            o = {k: {"text": f"Row {k} only, all others rejected"} for k in "ABCD"}
        rows.append(
            {"qno": i, "subject": "Physics", "question": q, "options": o, "answer": "B"}
        )
    return rows


def build_many_diagrams() -> list:
    """EXTREME: long uninterrupted runs of diagram questions with hostile
    aspect ratios (panoramic, skyscraper, tiny, huge) plus diagram options —
    the worst case for page-break gaps and mm-cap leaks."""
    shapes = {
        "panorama": make_diagram(1800, 200),
        "skyscraper": make_diagram(200, 1800),
        "huge": make_diagram(2400, 2400),
        "tiny": make_diagram(48, 48),
        "portrait": make_diagram(500, 900),
        "landscape": make_diagram(900, 500),
    }
    names = list(shapes)
    rows = []
    for i in range(1, 25):  # 24 consecutive image questions, no text-only relief
        stem = shapes[names[i % len(names)]]
        opt = shapes[names[(i + 3) % len(names)]]
        q = {"text": f"Identify the species in the diagram (Q{i}).", "image": stem}
        o = {k: {"text": "", "image": opt} for k in "ABCD"}
        rows.append(
            {"qno": i, "subject": "Chemistry", "question": q, "options": o, "answer": "C"}
        )
    return rows


def build_math_heavy() -> list:
    """EXTREME: math-only paper mixing inline math, long display equations,
    matrices, integrals and nested fractions with occasional inline diagrams."""
    inline_img = make_diagram(700, 420)
    long_eq = (
        r"$$\int_{0}^{\infty}\frac{x^{n-1}}{e^{x}-1}\,dx"
        r"=\Gamma(n)\zeta(n)=\sum_{k=1}^{\infty}\frac{\Gamma(n)}{k^{n}}"
        r"\quad\text{for }\Re(n)>1$$"
    )
    matrix = (
        r"$$\begin{bmatrix} a_{11} & a_{12} & a_{13} \\ "
        r"a_{21} & a_{22} & a_{23} \\ a_{31} & a_{32} & a_{33}\end{bmatrix}"
        r"\begin{bmatrix} x \\ y \\ z\end{bmatrix}="
        r"\begin{bmatrix} \lambda x \\ \lambda y \\ \lambda z\end{bmatrix}$$"
    )
    nested = r"$\cfrac{1}{1+\cfrac{1}{1+\cfrac{1}{1+\cfrac{1}{1+x}}}}$"
    rows = []
    for i in range(1, 25):
        m = i % 4
        if m == 0:
            q = {"text": f"Evaluate the following integral (Q{i}). {long_eq}"}
            o = {k: {"text": rf"$\Gamma({i})\zeta({i})/{ord(k) - 64}$"} for k in "ABCD"}
        elif m == 1:
            q = {"text": f"Solve the eigenvalue problem (Q{i}). {matrix}"}
            o = {k: {"text": matrix} for k in "ABCD"}  # display matrices as options
        elif m == 2:
            q = {"text": f"Simplify the continued fraction {nested} for case {i}."}
            o = {k: {"text": nested} for k in "ABCD"}
        else:
            q = {
                "text": (
                    f"Given the field shown, compute $\\oint \\vec E\\cdot d\\vec A$ (Q{i})."
                ),
                "image": inline_img,
            }
            o = {
                k: {"text": rf"$\dfrac{{q_{{{i}}}}}{{{ord(k) - 64}\varepsilon_0}}$"}
                for k in "ABCD"
            }
        rows.append(
            {"qno": i, "subject": "Mathematics", "question": q, "options": o, "answer": "D"}
        )
    return rows


FIXTURES = {
    "sample": ("sample-paper.json", build_paper),
    "long-tables": ("stress-long-tables.json", build_long_tables),
    "many-diagrams": ("stress-many-diagrams.json", build_many_diagrams),
    "math-heavy": ("stress-math-heavy.json", build_math_heavy),
}





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

  // Extreme tables / display math must not spill outside the text column and
  // must never collapse to one character per line.
  const wide = [...document.querySelectorAll('.paper table, .paper .katex-display')];
  const overflowingBlocks = wide.filter((el) => {
    const r = el.getBoundingClientRect();
    const host = el.closest('.qtext, .opt-text, .question');
    return host ? r.right > host.getBoundingClientRect().right + 1.5 : false;
  }).length;
  const collapsedCells = [...document.querySelectorAll('.paper table td, .paper table th, .paper table caption')]
    .filter((td) => {
      const t = (td.textContent || '').trim();
      const r = td.getBoundingClientRect();
      // >2 chars rendered in a box narrower than ~1.6 chars wide = vertical text
      return t.length > 2 && r.height > r.width * 2.5;
    }).length;

  const q = imgs.filter((i) => !i.opt).map((i) => Math.max(i.w, i.h));
  const o = imgs.filter((i) => i.opt).map((i) => Math.max(i.w, i.h));

  return {
    count: imgs.length,
    overCap: imgs.filter((i) => (i.opt ? Math.max(i.w, i.h) > 34.6 : Math.max(i.w, i.h) > 45.6)).length,
    overflowing: imgs.filter((i) => i.overflow).length,
    qMax: q.length ? +Math.max(...q).toFixed(1) : null,
    optMax: o.length ? +Math.max(...o).toFixed(1) : null,
    splitOptionGrids: splits,
    overflowingBlocks,
    collapsedCells,
    tables: document.querySelectorAll('.paper table').length,
    mathBlocks: document.querySelectorAll('.paper .katex').length,
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


def load_fixture(name: str) -> list:
    filename, builder = FIXTURES[name]
    path = FIXTURE_DIR / filename
    return json.loads(path.read_text()) if path.exists() else builder()


async def check_fixture(page, name: str, report: Report) -> bytes:
    data = load_fixture(name)
    print(f"\n=================== fixture: {name} ({len(data)} questions) ===================")
    await page.set_viewport_size({"width": 1280, "height": 1800})
    await page.locator("textarea").first.fill(json.dumps(data))
    await page.wait_for_timeout(3000)

    for layout, value in (("2col", "2"), ("1col", "1")):
        await page.select_option("select", value)
        await page.wait_for_timeout(1500)
        for label, w, h in BREAKPOINTS:
            await page.set_viewport_size({"width": w, "height": h})
            await page.wait_for_timeout(900)
            m = await page.evaluate(MEASURE)
            tag = f"{name}/{layout}/{label}"
            print(f"\n[{tag}] {m}")
            report.check(
                m["count"] > 0 or m["tables"] > 0 or m["mathBlocks"] > 0,
                f"{tag}: content rendered",
            )
            report.check(m["overCap"] == 0, f"{tag}: no diagram over its mm cap", f"{m['overCap']} over")
            report.check(
                m["overflowing"] == 0,
                f"{tag}: no diagram overflows its container",
                f"{m['overflowing']} overflowing",
            )
            report.check(
                m["splitOptionGrids"] == 0,
                f"{tag}: no option grid split across a break",
                f"{m['splitOptionGrids']} split",
            )
            report.check(
                m["overflowingBlocks"] == 0,
                f"{tag}: no table/display-math spills out of its column",
                f"{m['overflowingBlocks']} spilling",
            )
            report.check(
                m["collapsedCells"] == 0,
                f"{tag}: no table cell collapsed to vertical text",
                f"{m['collapsedCells']} collapsed",
            )
            if m["qMax"] is not None:
                report.check(
                    abs(m["qMax"] - Q_CAP) <= TOL,
                    f"{tag}: question diagrams hit the 45mm cap exactly",
                    f"{m['qMax']}mm",
                )
            if m["optMax"] is not None:
                report.check(
                    abs(m["optMax"] - OPT_CAP) <= TOL,
                    f"{tag}: option diagrams hit the 34mm cap exactly",
                    f"{m['optMax']}mm",
                )

    await page.set_viewport_size({"width": 1280, "height": 1800})
    await page.wait_for_timeout(800)
    return await page.pdf(
        format="A4",
        margin={"top": "12mm", "bottom": "12mm", "left": "10mm", "right": "10mm"},
        print_background=True,
    )


def check_pdf(pdf: bytes, name: str, report: Report) -> None:
    try:
        import fitz  # PyMuPDF
    except ImportError:
        print(f"  SKIP  {name}: PyMuPDF not installed — page-break check skipped")
        return
    doc = fitz.open(stream=pdf, filetype="pdf")
    pt = 72 / 25.4
    clipped = oversize = text_out = 0
    for pg in doc:
        top, bottom = 12 * pt, pg.rect.height - 12 * pt
        for im in pg.get_image_info():
            x0, y0, x1, y1 = im["bbox"]
            if y0 < top - 1 or y1 > bottom + 1:
                clipped += 1
            if (x1 - x0) / pt > Q_CAP + TOL or (y1 - y0) / pt > Q_CAP + TOL:
                oversize += 1
        # Text/table content (long tables, display math) must also stay inside
        # the printable band — a row straddling the margin means a torn table.
        for b in pg.get_text("blocks"):
            if b[1] < top - 2 or b[3] > bottom + 2:
                text_out += 1
    print(f"\n[{name}/print] pages={doc.page_count}")
    report.check(clipped == 0, f"{name}/print: no diagram clipped by a page break", f"{clipped} clipped")
    report.check(oversize == 0, f"{name}/print: no diagram over 45mm on paper", f"{oversize} oversize")
    report.check(
        text_out == 0,
        f"{name}/print: no text/table block crosses the page margin",
        f"{text_out} blocks outside the printable area",
    )



async def run(url: str, names: list) -> int:
    report = Report()
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True)
        context = await browser.new_context(viewport={"width": 1280, "height": 1800})
        page = await context.new_page()
        await page.goto(url, wait_until="networkidle")
        pdfs = {}
        for name in names:
            pdfs[name] = await check_fixture(page, name, report)
        await browser.close()
    for name, pdf in pdfs.items():
        check_pdf(pdf, name, report)
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
    ap.add_argument(
        "--fixtures",
        default="all",
        help="comma-separated subset of: " + ", ".join(FIXTURES) + " (default: all)",
    )
    ap.add_argument("--write-fixtures", action="store_true", help="regenerate fixture JSON files")
    args = ap.parse_args()

    if args.write_fixtures:
        FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
        for key, (filename, builder) in FIXTURES.items():
            (FIXTURE_DIR / filename).write_text(json.dumps(builder()))
            print(f"wrote {FIXTURE_DIR / filename}")
        sys.exit(0)

    selected = list(FIXTURES) if args.fixtures == "all" else args.fixtures.split(",")
    unknown = [n for n in selected if n not in FIXTURES]
    if unknown:
        sys.exit(f"unknown fixture(s): {', '.join(unknown)}")
    sys.exit(asyncio.run(run(args.url, selected)))


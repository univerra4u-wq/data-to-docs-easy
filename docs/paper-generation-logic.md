# Paper Generation Logic — JSON → Two-Column A4 PDF

This document explains, in full detail, how this project turns a questions
JSON file into a clean, gap-minimized, two-column A4 exam paper. It is grounded
in the actual source in `src/routes/index.tsx` and `src/styles.css`, so it can
be used as a prompt or reference to reproduce the system in another stack.

---

## 1. Overview — the core philosophy

**We do not "generate" a PDF. We render HTML so precisely that the browser's
own print engine produces the final PDF.**

This is the single most important decision. It means:

- No PDF library (no jsPDF, pdfmake, PDFKit).
- The on-screen preview and the printed PDF come from **the same layout pass**,
  so they can never disagree — what you see is exactly what prints.
- All layout intelligence lives in **CSS**, not JavaScript. JS never measures a
  single element height.

The PDF is produced by `window.print()` (line 355 of `index.tsx`). The browser
opens its print dialog and the user saves as PDF. The `@media print` CSS
overrides hide the editor UI and emit only the `.paper` content at A4 size.

---

## 2. The 7-stage pipeline

### Stage 1 — Validate before render (Zod)

File: `src/routes/index.tsx`, lines 29–50.

`paperSchema` is a Zod array of `questionSchema`. Before any HTML is built, the
JSON is parsed and validated (`validate()`, lines 219–244). If validation fails:

- `items` stays `null`.
- Errors are collected (path + message, capped at 30) and shown in the UI.
- `canPrint = !!items && errors.length === 0` (line 332) keeps the print button
  disabled.

This guarantees the renderer only ever sees well-formed data, so no null checks
are needed downstream.

**Why it matters for layout:** a malformed question (missing options, wrong
types) would break the template fill or the math renderer. Validation is the
gate that keeps the layout stable.

### Stage 2 — Group by subject, preserve order

`groupBySubject()` (lines 194–203):

```ts
function groupBySubject(items: QItem[]) {
  const order: string[] = [];
  const map = new Map<string, QItem[]>();
  for (const it of items) {
    const sub = it.subject || "Questions";
    if (!map.has(sub)) { map.set(sub, []); order.push(sub); }
    map.get(sub)!.push(it);
  }
  return order.map((s) => ({ subject: s, items: map.get(s)! }));
}
```

- Questions are bucketed by `subject` into a `Map`.
- An `order[]` array records first-seen order.
- The render maps over `order`, so subjects appear in JSON order and questions
  within each subject stay in their original sequence.

**Order is never rearranged to fill gaps.** This is deliberate — an exam
paper's question sequence is sacred. A small gap at the bottom of a column is
the correct trade-off vs. splitting or reordering questions.

### Stage 3 — Template fill (no eval)

`fillTemplate()` (lines 187–191):

```ts
function fillTemplate(tpl: string, tokens: Record<string, string>): string {
  return tpl.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (_m, key) =>
    Object.prototype.hasOwnProperty.call(tokens, key) ? tokens[key] : ""
  );
}
```

A single regex replaces `{{token}}` placeholders. No `eval`, no `Function` —
just `String.replace`. The header, question, and option templates are
user-editable HTML strings (lines 77–105). This decouples **structure** (the
template) from **data** (the JSON).

### Stage 4 — Math + safe HTML

`renderMath()` (lines 135–184) and `sanitizeInlineHtml()` (lines 120–133).

Each text field is scanned for three delimiter types:

| Delimiter | Mode |
|-----------|------|
| `\(` … `\)` | inline math |
| `\[` … `\]` | display (block) math |
| `$` … `$` | inline math |

The string is split into alternating `text` / `math` segments:

- **text segments** → `sanitizeInlineHtml()`: escapes *everything* (`&`, `<`,
  `>`), then re-enables only a whitelist of inline tags
  (`span, sub, sup, b, i, em, strong, br, u, small`) by un-escaping just those
  tags. So `<span style="opacity:0.5">` renders as HTML, but `<script>` shows as
  literal text.
- **math segments** → `katex.renderToString()` with these options:
  - `output: "htmlAndMathml"` — visual HTML plus a hidden MathML layer (better
    copy-paste + accessibility).
  - `trust: true` — allows commands like `\url`, `\href`.
  - `strict: "ignore"` — does not choke on non-standard LaTeX.
  - `throwOnError: false` — a bad equation shows the raw source instead of
    crashing the whole render.

### Stage 5 — Emit ONE flat flow

`buildQuestionsHtml()` (lines 288–323). This is the **alignment secret**.

The output is a single nested structure:

```html
<div class="paper">
  <header class="paper-header">…</header>          ← header, NOT columned
  <section class="subject-section">
    <h2 class="subject-heading">Physics</h2>
    <div class="two-col">                          ← column-count starts HERE
      <div class="question">Q1…</div>
      <div class="question">Q2…</div>
      …all questions as flat siblings…
    </div>
  </section>
  …
</div>
```

Critically: **there is no per-page container.** All questions of a subject are
flat siblings inside one `.two-col`. The browser's fragmentation engine
measures each `.question` block, fills column 1 top-to-bottom, overflows into
column 2, then overflows onto page 2. JavaScript never computes a single
height.

### Stage 6 — CSS does the layout + print

`src/styles.css` carries the entire layout. See the rule table in section 4.

### Stage 7 — PDF = `window.print()`

Line 355 of `index.tsx`. No PDF library. The same HTML/CSS that renders the
on-screen preview is what the browser paginates into A4. Preview and PDF share
one layout pass, so they cannot disagree.

---

## 3. The alignment mechanics — why two columns come out clean

The two-column balance comes from **CSS multi-column fragmentation**, which
works in three internal passes:

### Pass 1 — Measure
The browser lays out the full content as if it were one infinitely tall
column, measuring each `.question` block's height.

### Pass 2 — Fragment
The browser walks the block list, accumulating heights, and breaks at
`break-inside: avoid` boundaries. When the next block won't fit in the
remaining column space, it moves the **whole block** to the next column.

### Pass 3 — Balance
For paged media the default is `column-fill: auto`, which fills column 1 fully
before starting column 2. This is what you want for an exam paper (vs.
`column-fill: balance`, which would equalize column heights and leave big
gaps mid-page).

### Why gaps are correct (and rare)
A gap appears at the bottom of a column only when a question is too tall to
fit and `break-inside: avoid` forces it to the next column. That gap is the
**correct** trade-off — the alternative (splitting the question across columns
or pages) is worse for a test paper. The order is preserved exactly because CSS
columns flow in document order.

### What reduces gaps
- Shorter question text / fewer lines.
- Slightly smaller font size or line spacing.
- Splitting a long question into (a) and (b) parts.
- Smaller images.

But the order always stays exactly as in the JSON.

---

## 4. The CSS rule table

All rules live in `src/styles.css`. Each is intentional and load-bearing.

| Rule | Line(s) | Effect |
|---|---|---|
| `.two-col { column-count: 2; column-gap: 8mm; }` | 221–224 | Newspaper flow — content auto-balances across 2 columns |
| `.question { break-inside: avoid; page-break-inside: avoid; }` | 226–230 | A question + its options never split across columns/pages |
| `.qrow { display: flex; gap: 4px; }` | 232 | Number + text stay on one row |
| `.qnum { font-weight: 700; min-width: 18px; }` | 233 | Fixed-width gutter for the question number |
| `.qtext { flex: 1; text-align: justify; }` | 234 | Question body justifies and fills remaining width |
| `.qimage img { max-width: 100% }` | 236–237 | Question images shrink to fit the column |
| `.options { display: grid; grid-template-columns: 1fr 1fr; }` | 239–246 | The MCQ options form a 2×2 grid (independent of the column flow) |
| `.opt-img { display: block; max-width: 100% }` | 250 | Option images never overflow |
| `.katex-display { overflow-x: auto; max-width: 100% }` | 260–261 | Wide equations scroll inside the column instead of breaking layout |
| `.qtext, .opt-text { overflow-wrap: anywhere; word-break: normal; }` | 262 | Long tokens wrap instead of pushing the column wide |
| `.katex .katex-mathml { position: absolute; clip: rect(1px,1px,1px,1px); … }` | 264–265 | MathML is hidden from sighted users but kept for screen readers |
| `@page { size: A4; margin: 12mm 10mm; }` | 268 | The exact printable area |
| `@media print { .no-print { display: none !important; } }` | 270 | Editor UI vanishes; only `.paper` prints |
| `@media print { .paper { font-size: 9.5pt; } }` | 272 | Slightly tighter text on the printed page |

---

## 5. KaTeX configuration (why each option matters)

From `renderMath()`, lines 172–178:

```ts
katex.renderToString(p.value, {
  throwOnError: false,
  displayMode: !!p.display,
  output: "htmlAndMathml",
  strict: "ignore",
  trust: true,
});
```

| Option | Value | Why |
|---|---|---|
| `output` | `"htmlAndMathml"` | Emits visual HTML **and** a hidden MathML layer. MathML gives better copy-paste (selectable math) and accessibility, while the HTML layer is what actually paints. CSS hides the MathML from sighted users (line 264). |
| `trust` | `true` | Allows commands that load resources or are normally flagged, e.g. `\url`, `\href`. Question banks use these freely; without `trust` they would error. |
| `strict` | `"ignore"` | KaTeX's strict mode rejects non-standard LaTeX. `"ignore"` lets questionable but common syntax render instead of throwing. |
| `throwOnError` | `false` | If an equation is genuinely unparseable, show the raw source rather than throwing — one bad formula never breaks the whole paper. |
| `displayMode` | `!!p.display` | `true` for `\[ \]` (block, centered, larger); `false` for `\( \)` and `$ $` (inline). |

### `sanitizeInlineHtml` — the safe whitelist

Lines 120–133. The flow is:

1. `escapeHtml()` escapes **everything** (`&` → `&`, `<` → `<`, `>` → `>`).
2. A regex re-enables only the tags in `ALLOWED_TAGS` (`span, sub, sup, b, i,
   em, strong, br, u, small`) by un-escaping just those tags and decoding their
   quoted attributes.

So `<span style="opacity:0.5">text</span>` renders as real HTML, but
`<script>` or `<img onerror=...>` shows as literal escaped text. This lets
question authors use light inline formatting without opening an XSS hole.

---

## 6. The 7 integration rules (in order)

To reproduce this layout in any React stack, implement these in this exact
sequence and test in Chrome's print preview after each step. When a gap or
split appears, you'll know which step introduced it.

1. **Validate with Zod** before building any HTML — block rendering on invalid
   data.
2. **Group by subject, preserve JSON order** — never reorder to fill gaps.
3. **Emit one flat `.two-col` per subject** with questions as direct siblings.
4. **`column-count: 2`** + `column-gap` on the question container (not flex /
   grid).
5. **`break-inside: avoid`** (with all 3 vendor prefixes:
   `break-inside`, `-webkit-column-break-inside`, `page-break-inside`) on each
   `.question`.
6. **Options use a 2×2 CSS grid**; images and KaTeX display blocks get
   `max-width: 100%` + `overflow-x: auto`.
7. **`@page { size: A4 }`** + `@media print` to hide the editor UI, then
   `window.print()`.

---

## 7. Known caveats

### What works reliably
- Two-column flow with atomic questions.
- 2×2 MCQ option grid.
- Standard LaTeX (fractions, powers, roots, integrals, Greek letters, matrices).
- Images scaling to column width.
- A4 page breaks.

### What can still vary

1. **Browser-specific print rendering.** Chrome renders `column-count` +
   `break-inside` best. Firefox and Safari sometimes leave larger gaps or
   handle `column-fill` differently. **Always test in Chrome.**
2. **Very tall questions** (a huge image or a tall matrix) can exceed a full
   column/page height. `break-inside: avoid` can't help if the block itself is
   taller than a page — it will overflow. Constrain images with
   `max-height` if needed.
3. **Font loading timing.** KaTeX fonts must be loaded before `print()` or
   equations may render with fallback glyphs in the PDF. Awaiting
   `document.fonts.ready` before enabling the print button removes this risk.
4. **Infinite scroll containers in print.** The preview uses `.preview-frame`
   with `overflow: auto`. The `@media print` block must release that
   (`overflow: visible`) or printed pages get clipped.
5. **Vendor prefixes.** Older Safari needs `-webkit-column-break-inside:
   avoid` in addition to the standard property.
6. **Non-Latin / emoji glyphs.** The serif paper font may not cover every
   glyph; rare characters can render as tofu. Use a Unicode font fallback if
   needed.
7. **Backgrounds and colors.** Some browsers skip background colors in print
   by default. The user must enable "Background graphics" in the print dialog,
   or you set `-webkit-print-color-adjust: exact`.

### For deterministic, commercial-grade output
Skip `window.print()` and render the same HTML server-side with headless
Chrome via **Puppeteer or Playwright**:

```ts
await page.pdf({ format: "A4", printBackground: true, margin: { /* match @page */ } });
```

This produces identical PDFs regardless of the user's browser or OS, and
removes the "Background graphics" and font-timing caveats. The HTML/CSS
templates stay exactly the same — only the print trigger changes.

---

## File reference

| File | Role |
|---|---|
| `src/routes/index.tsx` | Validation (Zod), template engine, math rendering, the React UI, and `window.print()` |
| `src/styles.css` | All paper layout, two-column flow, options grid, KaTeX overflow, and `@media print` / `@page A4` |

### Key functions in `index.tsx`
- `paperSchema` / `questionSchema` (lines 29–50) — Zod validation.
- `sanitizeInlineHtml` (lines 120–133) — escape-all-then-reallow-whitelist.
- `renderMath` (lines 135–184) — split text/math, run KaTeX.
- `fillTemplate` (lines 187–191) — `{{token}}` replace.
- `groupBySubject` (lines 194–203) — order-preserving grouping.
- `buildQuestionsHtml` (lines 288–323) — the flat `.two-col` flow.
- `window.print()` (line 355) — the PDF trigger.

## Automated layout regression checks

`scripts/layout-regression.py` renders `tests/fixtures/sample-paper.json`
(30 questions: tall/wide/square diagrams, display math, captioned truth
tables, long wrapping text) in headless Chromium against the dev server and
asserts, for both the 1-column and 2-column layouts at desktop (1280),
tablet (834) and mobile (390):

- every diagram stays within its physical cap (45mm question, 34mm option)
- no diagram overflows its container
- no `.options` grid is fragmented across a column/page break
- millimetre caps stay proportional at every breakpoint (the A4 sheet is
  zoomed, never reflowed narrower)

It then prints a real A4 PDF and verifies no image is clipped by a page
boundary and none exceeds 45mm on paper.

```bash
python3 scripts/layout-regression.py                 # exit 0 = clean
python3 scripts/layout-regression.py --url http://localhost:8080
python3 scripts/layout-regression.py --write-fixture # regenerate sample JSON
```

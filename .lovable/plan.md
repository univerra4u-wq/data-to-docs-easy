## Goal
Save the complete logic behind the JSON → two-column A4 paper generator as a permanent markdown file in the project, so it's documented and reusable (e.g. as a prompt for another Claude session).

## What to create
**File:** `docs/paper-generation-logic.md` (new)

A single self-contained document covering the full pipeline, grounded in the actual code in `src/routes/index.tsx` and `src/styles.css`:

1. **Overview** — the core philosophy (render HTML precisely, let the browser's print engine make the PDF; no PDF library).
2. **The 7-stage pipeline** — Validate (Zod) → Group by subject (order-preserving) → Template fill (`{{token}}` replace) → Math + safe HTML (`renderMath`/`sanitizeInlineHtml`) → One flat flow of `.question` siblings → CSS multi-column + fragmentation layout → `window.print()`.
3. **The alignment mechanics** — why CSS `column-count: 2` + `break-inside: avoid` produces clean two-column flow without JavaScript height math; the three internal passes (measure → fragment → balance); why `column-fill: auto` (paged default) fills col 1 fully before col 2; why small gaps at column bottoms are correct vs. splitting questions.
4. **The CSS rule table** — each rule in `styles.css`, the exact line, and what it does (`column-count`, `break-inside`, options grid, image/KaTeX overflow, `@page A4`, `@media print`).
5. **KaTeX configuration** — `output: "htmlAndMathml"`, `trust: true`, `strict: "ignore"`, `throwOnError: false`, and why each matters; how `sanitizeInlineHtml` allows a safe inline-HTML whitelist while escaping everything else.
6. **The 7 integration rules in order** — the checklist to reproduce this in any React stack.
7. **Known caveats** — browser variance (Chrome best), the remaining ~5% edge cases, and the Puppeteer option for deterministic server-side PDF.

## Out of scope
- No code changes to `index.tsx` or `styles.css`.
- No new dependencies.
- This is a documentation-only addition.

## Verification
- Confirm the file is written and readable.
- Confirm it accurately references the real functions/line numbers in the current source.
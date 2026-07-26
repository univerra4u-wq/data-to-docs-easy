## Goal

Turn the full 339-line `docs/paper-generation-logic.md` into a clean, readable PDF you can download and share.

## What gets produced

A single file at `/mnt/documents/paper-generation-logic.pdf` — the complete document, nothing trimmed:

- Title page-style heading, then all 12+ sections in order
- Proper heading hierarchy (H1/H2/H3) with consistent spacing
- Code blocks (the `ts` / `css` snippets) in a monospaced, light-shaded box that never overflows the page width — long lines wrap instead of clipping
- The CSS rule table rendered as a real bordered table
- Bullet and numbered lists preserved
- Inline `code` spans in monospace
- Page numbers in the footer, A4 page size, 20mm margins
- A Unicode-capable font registered so arrows/em-dashes/`→` in the doc render instead of showing as boxes

## How

1. Read the markdown source in full.
2. Build a one-off Python script under `/tmp` that parses the markdown (headings, paragraphs, fenced code, tables, lists) and lays it out with ReportLab Platypus.
3. Register DejaVu Sans + DejaVu Sans Mono via fontconfig so non-ASCII characters are safe.
4. Write the PDF to `/mnt/documents/`.

## Quality check before delivery

Convert every page to an image with `pdftoppm` and inspect each one, looking for: clipped code lines, overflowing table columns, orphaned headings at page bottoms, black-box glyphs, and blank pages. Fix the script and re-run until a full pass is clean, then report what was found and fixed.

## Notes

- No app code changes — this is a document export only. The website and generator behavior stay exactly as they are.
- If you'd also like a "Download this doc as PDF" button inside the app itself, say so and I'll add that as a follow-up.

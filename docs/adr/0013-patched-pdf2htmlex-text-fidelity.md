# ADR 0013 — Patch pdf2htmlEX for Text-Layer Fidelity

**Status**: Superseded by [ADR 0015](0015-retire-pdf2htmlex.md) (pdf2htmlEX retired 2026-11-11)
**Date**: 2026-10-20
**Supersedes**: the "zero patches to pdf2htmlEX source" clause of [ADR 0011](0011-native-arm64-pdf2htmlex.md)

## Context

Reading Shannon's 1948 paper (a dvips PDF from 1998) showed two defects that
recur across a large class of PDFs:

1. **Doubled letters.** Some letters were drawn twice, a pixel or two apart,
   as faint grey copies beside the real ones ("f(x, y, t) of tẃo ṡpace").
2. **Misplaced selection.** Selecting a paragraph painted each line's
   highlight half a line too high, over the lower half of the line above,
   hiding that text.

Both come from pdf2htmlEX, not the overlay.

**Doubled letters: covered-text index drift.** pdf2htmlEX draws a glyph either
into the page raster or as HTML text. With `--correct-text-visibility` (on by
default), the HTML pass records, per character in drawing order, whether the
character is covered, and the background pass draws exactly the covered ones,
looking them up by the same running index. `HTMLRenderer::drawString` gives
every character an index, Type 3 glyphs included. The Splash background
renderer counted only `drawChar` calls, and poppler never calls `drawChar` for
a Type 3 glyph; it calls `beginType3Char` and runs the glyph's content stream.
After each Type 3 glyph on a page the background read the covered flag one
slot behind, so it drew ordinary letters that the HTML also showed. Typical
victims are TeX PDFs made with dvips and bitmap (PK) fonts, where every math
symbol is a Type 3 glyph: 1.6% of Shannon's glyphs, 3.1% of hashcash.pdf, 9%
of a 1992 exam, 14% of a synthetic dvips page.

**Misplaced selection: line metrics from the whole font.** pdf2htmlEX sets each
font's ascent and descent to the bounding box of every glyph in the font file.
Those values become the font's hhea/OS2 metrics, the CSS `line-height`, and
the height of each `.t` line, whose bottom is the PDF baseline. Chromium paints
a selection highlight across the whole line box. A non-embedded Times-Roman is
substituted with macOS Times, whose polytonic Greek capitals reach 1.27 em,
giving 1.635 em line boxes on 1.2 em leading. TeX's extension font (cmex)
carries delimiters 3 em tall, giving 3.0 em boxes; cmsy's radical gives 1.7 em.
The glyphs a document actually uses span about 0.7 em above and 0.25 em below
the baseline. Because each `.t` is a separate positioned element painted in
DOM order, the next line's oversized, opaque highlight covered the previous
line's text: 51% of Shannon's text ink disappeared under a full-page selection.

## Decision

Carry a small patch queue on the v2 build, in
[`patches/pdf2htmlEX/`](../../patches/pdf2htmlEX/), applied to
`~/dev/external/pdf2htmlEX_v2/pdf2htmlEX/src`. A patched build reports
`0.18.8.rc2+pdfv1` from `--version`, which `write-provenance.py` records in each
entry's `meta.json`.

1. **One index per character in both passes.** The Splash and Cairo background
   renderers count `beginType3Char` as a character, and Cairo counts every
   `drawChar`, matching `HTMLRenderer::drawString`. After each page the
   background renderer compares its count with the text layer's and logs
   `Warning: covered-text desync on page N` if they differ, so any other drift
   shows up in the conversion log instead of on the page.
2. **Line metrics from the glyphs the document draws, clamped to a text
   band.** Ascent and descent are the bounding box of the glyphs mapped for
   this document (`ffw_get_used_metric`), clamped to at most 1.0 em above and
   0.35 em below the baseline. Glyph placement does not depend on these
   values, because a line's bottom is its baseline and the font's own metrics
   are rewritten to the same numbers. A 3 em delimiter still paints its full
   height; only its line box, and with it the highlight, stays text-sized.

The overlay's `::selection` background becomes translucent,
`rgba(0, 100, 163, 0.4)`, which is exactly the previous `#99C1DA` on white.
Glyph ink that legitimately extends past its line box (large delimiters,
picture-mode line fonts, text over figures) stays readable under a
neighbouring line's highlight.

## Rationale

**Fix the converter, not the output.** Post-processing the HTML cannot remove
letters already baked into a raster, and rewriting line metrics afterwards
would mean re-deriving each `.t` height from fonts shared across lines. Both
defects are a few lines in the converter, where the values are produced.

**Count, don't redesign.** The covered-text design (an index shared by two
passes) is fragile, but replacing it with position-keyed lookup is a larger
change to upstream code. Counting the same events in both passes, plus a
per-page check, keeps the patch small and turns any future drift into a
logged warning.

**Disabling covered-text handling was rejected.** `--correct-text-visibility
0` removes the doubled letters, but text hidden under images or shapes would
then show through.

**Clamp bounds from the corpus.** Across 24 cached documents, ordinary text
fonts use glyphs within 0.45–0.95 em above and 0.30 em below the baseline;
only extension and symbol fonts exceed that. The band (1.0, 0.35) leaves every
text font unclamped.

**Translucent selection as a second layer.** Tight line boxes fix the cause
for text. Glyphs that are larger than any sensible line box still exist, and an
opaque highlight hides whatever it overlaps. Translucency guarantees
readability without changing the colour on paper.

## Consequences

### Wins

- No doubled letters on Type 3 pages, and selections hug their lines, across
  in-sample and held-out documents (`scripts/tests/test_text_fidelity.py`,
  `test/corpus-text-fidelity.tsv`): before the patch 14 of the 15 documents in
  the affected classes failed and all 5 controls passed; after it all 20 pass.
- Desync is now observable: the warning appears in `~/.cache/pdf_viewer/log`.
- `meta.json` provenance distinguishes patched conversions (`+pdfv1`).

### Accepted downsides

- **A patch queue to carry.** Rebuilding from a fresh upstream checkout needs
  `patches/pdf2htmlEX/*.patch` applied first. The Homebrew-tap fallback in
  `install-native-pdf2htmlex.sh` still ships an unpatched binary; the
  installer and `doctor.sh` warn when `--version` lacks `+pdfv`.
- **Existing entries need reconversion** (`upgrade-cache.sh
  --mode=reconvert`). Entries whose source PDF is gone keep the old output.
- **Some line splits change.** pdf2htmlEX merges a shifted run (a superscript,
  a delimiter) into the current line when their ascent/descent bands overlap.
  Tighter bands for extension fonts mean a few more separate `.t` lines in
  displayed math. Text order and find are unaffected; `:yank` may break a line
  at such a run.
- **Highlights cover less of oversized glyphs.** Selecting a 3 em delimiter
  highlights a text-sized band at its top, not the whole glyph.

## Related

- [`docs/screenshots/text-fidelity-before-after.png`](../screenshots/text-fidelity-before-after.png) — Shannon page 2 and a page 1 selection, before and after, in the live viewer

- [`patches/pdf2htmlEX/0001-text-fidelity.patch`](../../patches/pdf2htmlEX/0001-text-fidelity.patch)
- [`scripts/measure-text-fidelity.cjs`](../../scripts/measure-text-fidelity.cjs) — pixel harness
- [`docs/verification.md`](../verification.md) — when to run it
- [`docs/pdf2htmlex-dom.md`](../pdf2htmlex-dom.md) — `.t` line box semantics
- ADR 0011 (native build), ADR 0010 (light HTML keeps visible `.t` canonical)

# ADR 0014: Reader — PDFium rasters under a transparent text layer

**Status**: Accepted for the reader routes (`/read`, `/r/<hash>/`). Making it
the default engine (`PDF_VIEWER_ENGINE=reader`) waits for Anders' check in
Comet with Vimium; until then pdf2htmlEX output stays the default and the
rollback.
**Date**: 2026-11-10

## Context

ADR 0001 chose pdf2htmlEX: it converts a PDF to HTML in which the browser
paints the text with embedded fonts over a raster of everything else. Most of
the code outside the overlay exists to manage that split:

- a patched converter and its patch queue (ADR 0013), built natively against
  Homebrew libraries (ADR 0011);
- the paint-safe text mode that decides, per line, whether the browser or the
  raster shows a glyph (ADR 0010), and font externalization for it;
- runtime patches to pdf2htmlEX's private viewer object;
- three representations per cache entry;
- conversion as a separate, slow, manual step: a cache miss opens the
  browser's own viewer until the reader runs a Raycast command (ADR 0004).

The corpus probe (`bench/corpus/`, 11,240 documents) found at least one
failure in 41.7 % of documents with that engine: substituted fonts (17 %),
visual differences from PDFium (15 %), drifting or doubled glyphs (8 %),
converter crashes and refusals (2.5 %). Page rasters were 1191 px wide, so on
a high-density display every figure and formula was upscaled about 2.7×.

Chrome's own viewer and pdf.js work differently: the page is one raster, text
included, and a transparent text layer on top provides selection and find.

## Decision

Add a second engine, the **reader** (`docs/reader.md`), and make it able to
replace the first:

1. **Pixels from PDFium, at device resolution.** The daemon renders a page
   with PDFium (`pypdfium2`) at the exact width the browser will show it:
   CSS width × zoom × device pixel ratio. PDFium is the engine of Chrome's own
   viewer, so the page looks as it does there.
2. **Text as a transparent layer, one element per line.** Lines and their
   positions come from PDFium's character boxes. The browser lays each line
   out in a fallback font and the overlay sets the letter-spacing that makes
   it exactly as wide as on the page. No font is embedded and no text is
   painted by the browser.
3. **On demand, no conversion.** Opening a PDF registers it and builds the
   page shell from it directly. Rasters are rendered when a page nears the
   viewport and cached with a size limit.
4. **The same DOM contract.** The shell uses the page-frame, raster, text-line
   and outline names the overlay already reads, so the overlay modules other
   than `overlay-document.js` and two small new ones do not know which engine
   built the page.
5. **The daemon computes.** This supersedes the read-only half of ADR 0004:
   the daemon downloads sources, renders and writes derived files. PDFium runs
   only in worker processes, so a document that crashes it costs a worker, not
   the daemon. The daemon still binds to `127.0.0.1` and documents never leave
   the machine.

## Rationale

Measured on this Mac (M-series, 12 cores), same documents:

| | pdf2htmlEX path | Reader |
|---|---|---|
| First open, 342-page book | 27 s conversion, started by hand | 1.1 s, automatic |
| First open, 1,677-page book | minutes | 7.3 s |
| Later opens, 1,677-page book | — | 0.5–1.2 s to first page |
| Uncached arXiv URL to reader | native viewer until converted | 0.3 s |
| Page markup, 342 pages | 8.7 MB, 29.6 k lines / 191 k spans | 2.5 MB, 17.5 k lines |
| Raster width at fit-width, 2× display | 1191 px, upscaled | exact device px (2720) |
| One page render, 2720 px wide | — | 70–150 ms, in parallel workers |

Scorecard over the 57 tier-1 corpus documents present locally
(`bench/reader/`, 2026-11-10), same documents for both engines:

| Failure family | pdf2htmlEX | Reader |
|---|---|---|
| Fails to open or render | 1 | 0 |
| Visual difference from PDFium above threshold | 2 | 0 |
| Glyph drift or font substitution | 12 | 0 |
| Blurred raster | 3 | 0 |
| Any of these | 18 (31.6 %) | 0 |

Text through the reader on those documents: copy matches PDFium's text
(similarity 1.000 at the median, 0.999 at the 10th percentile), find recall
1.0, and a find or selection highlight covers the word's glyph boxes with a
median intersection-over-union of 0.82 (0.94 along the line).

The visual result is close to true by construction: reference and reader use
the same renderer. That is the point of the design, and it also means the
scorecard cannot find a PDFium rendering fault.

What this removes once pdf2htmlEX is retired: the converter, its native build
and patch queue, the paint-safe parser, font preparation, the pdf2htmlEX
runtime adapter, two of three representations, the conversion and indexing
scripts, and the manual step on a cache miss.

## Consequences

- **Highlights are approximate inside a line.** Letter-spacing spreads the
  width error of the fallback font evenly; a word's highlight can be off by a
  fraction of a character in the middle of a long line. pdf.js has the same
  property.
- **Find works on lines.** A phrase that wraps across two lines is not one
  match, as before.
- **Text order is PDFium's.** It is usually reading order; it is not
  guaranteed for multi-column layouts.
- **Scanned PDFs have no text.** The page still shows; a text source such as
  OCR could feed the same text-layer format later.
- **The daemon needs `pypdfium2` and Pillow** (wheels, no local build).
- **Rasters cost CPU on first view** and disk afterwards
  (`PDF_VIEWER_RASTER_CACHE_MB`, default 1500).
- **Sign-in-gated sources** fall back to the browser's viewer first; the
  extension then hands the tab's bytes to the daemon and the tab moves to the
  reader.
- **Rollback** is `PDF_VIEWER_ENGINE=pdf2htmlex` (the default today):
  converted entries serve their HTML as before.

## Not decided here

- Deleting the pdf2htmlEX path. It stays until the reader has been the
  default for some days of real use.
- Streaming the shell for very large books, tiling, and the image format; see
  the open beads.

## Related

- Supersedes [ADR 0001](0001-pdf-to-html-engine-pdf2htmlex.md) for new opens
  and the read-only-daemon half of
  [ADR 0004](0004-on-demand-docker-and-daemon-split.md) once the reader is the
  default; [ADR 0010](0010-light-html-external-rasters-page-text.md),
  [ADR 0011](0011-native-arm64-pdf2htmlex.md) and
  [ADR 0013](0013-patched-pdf2htmlex-text-fidelity.md) then describe the
  rollback path only.
- Keeps [ADR 0009](0009-native-find-via-content-visibility.md) (text stays in
  layout for native find) and
  [ADR 0012](0012-page-zoom-off-the-scroller.md) (zoom on the pages).
- [`docs/reader.md`](../reader.md), [`docs/plans/hill-climb-week.md`](../plans/hill-climb-week.md) §4,
  `bench/reader/README.md`.

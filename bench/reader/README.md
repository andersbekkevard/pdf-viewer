# Reader scorecard

A repeatable scorecard for the reader engine (PDFium rasters under a
transparent, width-fitted text layer; `daemon/reader.py`) over the locally
present corpus documents, comparable with the stored probe results of the
retired pdf2htmlEX engine (`<corpus>/probe/<sha>.json`; the probe itself was
removed with the engine, ADR 0015) for the same documents. It covers axes A1 (visual), A2 (text), A3 (time to view, partly)
and A6 (reliability) of `docs/plans/hill-climb-week.md` §2.

## Run

A daemon with the reader must be running (`/read` and `/r/<hash>/`). The
default base is the dev daemon on port 7436; a private one can be started with
`cd daemon && PDF_VIEWER_CACHE_DIR=<scratch> uv run main.py --port 7443` and passed as
`--base http://127.0.0.1:7443`.

```bash
uv run bench/reader/run.py --out /tmp/pdfv-bench/reader-t1.json --tier t1 [--jobs 3] [--max-pages 5]
uv run bench/reader/run.py --out /tmp/pdfv-bench/reader-5.json --tier t1 --limit 5
uv run bench/reader/run.py --out /tmp/pdfv-bench/one.json --sha 0ce359 --keep-artifacts /tmp/pdfv-bench/keep
python3 bench/reader/compare.py /tmp/pdfv-bench/reader-t1.json      # prints, writes reader-t1.md beside it
```

Other options: `--limit N`, `--sha PREFIX` (repeatable), `--doc-timeout 300`
(seconds for the browser part of one document), `--raster-wait 30` (seconds
for one page raster), `--include-existing` (see Cache hygiene). Only manifest
rows whose PDF is in `<corpus>/files/` are selected; `--tier t1` includes t0.
The run writes the JSON after every document, so an interrupted run keeps
what it scored. Playwright is found as in `bench/corpus/probe/shared.py`.

Files: `run.py` (driver, PEP 723 deps), `pdfium_ref.py` (PDFium reference, run
as an isolated `python -I` child per call because corpus PDFs are untrusted),
`drive.cjs` (one headless Chromium per document), `compare.py` (stdlib only).

## Privacy

Most local corpus documents are Anders' private course material. The
scorecard JSON and the markdown summary hold numbers, sha256, manifest labels
and error strings with the PDF path replaced; no document text, titles or
file names. Text from PDFium and the text layer passes through memory only.
Screenshots go to `/tmp/pdfv-bench/work/<sha16>/` and are deleted after each
document unless `--keep-artifacts DIR` (refused inside the repository), which
also saves the viewer | PDFium | diff sheets. Never commit those.

## Cache hygiene

Opening a PDF through `/read` registers an entry in the daemon's cache
(`~/.cache/pdf_viewer/<sha256[:16]>/`, `entry.json` and `reader/`). The run
records the cache directories present at start and calls
`DELETE /mapping/<hash>` for each entry it created, right after scoring that
document and again in a final sweep, which also removes directories that a
late raster render recreated after the DELETE. `meta.cleanup` reports created, deleted
and leftover counts.

Documents whose entry existed before the run are skipped by default: `/read`
would rewrite the entry's source reference to the corpus path. With
`--include-existing` they are opened read-only through `/r/<hash>/`; this
still records a visit and may add `reader/` artifacts to the existing entry,
which the run does not delete. An entry that appears for a document after the run started
(another daemon or agent sharing the cache) is likewise opened read-only and
kept.

## What one document goes through

1. PDFium (`pdfium_ref.py info`): page count and sizes.
2. Pages: the old probe's sampled pages for this document first (page 1, the
   middle and the last page, or a window for long documents), then evenly
   spaced pages, `--max-pages` in all. Each page records `in_old_sample`.
3. PDFium text (`pdfium_ref.py text`): `get_text_range()` per page, and up to
   8 sampled words with their character boxes.
4. Browser (`drive.cjs`): opens `/read?path=<pdf>` in a fresh context with
   viewport and zoom chosen as the old probe chose them (fit-width 1600 CSS px,
   page height at most 4000 CSS px, zoom 0.25–10, viewport = page box + 100 px,
   DPR 2); the zoom is preset through the overlay's `pdf2html-zoom` preference.
   For each page: palette jump (`:` n Enter), wait for the raster at the exact
   device width, screenshot the `.pf` with overlay chrome and page shadow
   hidden and no selection, read the text layer, run find.
5. PDFium compare (`pdfium_ref.py compare`): render each page at
   zoom × DPR device px per point and compare.

## Metrics

### A6 reliability and A3 time (per document, `open`)

- `status`, `redirects`: HTTP status of the final reader page and of each
  redirect hop (`/read` should answer 307 to `/r/<hash>/`, which answers 200).
- `first_raster_ms`: from the start of navigation to `/read` until the first
  `.pf` has `data-pdf2html-raster-state="ready"`. The entry is new, so this is
  a cold open: the shell with text for the first pages, the rest loading after
  (`docs/reader.md`, Loading). The text pass waits for each page's text
  (`text_wait_ms`; `text_wait` is `timeout` if it never arrived).
  It is not the native-viewer ratio of plan A3; there is no native adapter yet.
- `jump_ms_median`: palette Enter to the target page's raster being ready at
  the exact device width (includes the smooth scroll), median over pages.
  Per page, `scroll_ms` is the part until the scroll has settled (scrollTop
  unchanged for 5 frames); the rest is waiting for the raster.
  Before the screenshot the driver awaits `img.decode()`: `ready` only means
  the image loaded, and Chromium paints a large PNG white until it is
  decoded. `decode_wait_ms` records that gap, which a reader sees as a
  white page; it is not part of `jump_ms`.
- `pf_count` vs PDFium's page count; console errors, page errors, failed
  daemon requests (>= 400 or network failure); external requests are blocked
  and counted as failed. Raster requests cancelled with `net::ERR_ABORTED`
  (the lifecycle drops a page's `src` when it leaves the mount window) are
  counted in `aborted_requests`, not as failures.

### A1 visual (per page, `visual`)

The old probe's metric, imported from `bench/corpus/probe/pdfium_worker.py`
(`ink_compare`), with its thresholds imported from `bench/corpus/probe/shared.py`, so the numbers
are those of the stored `visual-diff-high` class:

- a pixel is ink when its luma is below 128; `extra` = screenshot ink with no
  reference ink within 2 device px, `missing` = the reverse, both after a 3×3
  opening and divided by the reference's ink (floor 0.2 % of the page area);
- `block_diff` = share of 16×16 device px blocks whose mean colour differs by
  more than 48 levels in a channel;
- `size_delta` = screenshot size minus reference size in device px.

The reference is a direct PDFium render (`page.render(scale=zoom*2,
may_draw_forms=True)`). Document aggregate: `visual_worst` = max over pages of
max(extra, missing); `visual_worst_old_pages` restricts it to the old probe's
pages.

### A2 text (per page, `text`)

Pages whose PDFium text is empty after normalization are skipped with
`text_skipped`; pages with no word that qualifies get `words_skipped`.

- Normalization: PDFium's line-end hyphen markers U+FFFE and U+0002 become
  `-`, other control/format characters (Unicode Cc, Cf) are dropped,
  whitespace runs become one space, ends are trimmed.
- `copy_sim`: the page's DOM text (`.pc > .t` textContent, lines joined with
  `\n`) against PDFium's `get_text_range()`, both normalized, as
  1 − Levenshtein / max(len) (rapidfuzz). `copy_sim_nows` removes all
  whitespace first (separates spacing from content). `select_sim` uses what a
  select-all of the page's `.pc` returns (`Selection.toString()`), which is
  closer to a real copy. Document: mean and minimum over pages with ≥ 50
  PDFium non-space characters.
- `pdfium_chars`, `dom_chars`: non-space characters (the old `text-loss`
  rule compares the same two counts).
- Sampled words: distinct, letters only (`[^\W\d_]{5,}`), occurring exactly
  once on the page as a case-sensitive substring of PDFium's per-character
  string, whose loose boxes all lie inside the page box (1 px tolerance;
  off-page text objects are invisible and are counted in
  `offpage_candidates` instead), up to 8 spread evenly over the page.
- `find_found` / find recall: `window.find(word, caseSensitive)` from a
  collapsed selection at the start of the page's `.pc`; found when the hit is
  inside that page. Substring semantics (Chromium ignores whole-word): a hit
  inside a longer word on the page counts.
- Highlight IoU: a DOM Range over the word's first occurrence in the page's
  text-layer text nodes (a newline is inserted between `.t` lines, so a word
  split across two lines does not match); its client rects are converted to page px by
  subtracting the page frame's origin and dividing by the frame's on-screen
  scale (frame width / declared width = the zoom). Reference: the union of
  PDFium's *loose* character boxes (`FPDFText_GetLooseCharBox`, font
  ascent-to-descent, the boxes the reader positions its lines from),
  mapped to top-left page px with `FPDF_PageToDevice` as
  `daemon/pdfium_doc.py` does, so rotated pages are handled. IoU of the two
  unions of rectangles, rasterized at 4 samples per px. Words absent from the
  DOM text are not given an IoU; they are counted in `iou_missing_in_dom` (and
  as find misses). `iou_x_median`: IoU of the horizontal extents only, which
  separates horizontal drift from the line box being taller than the glyphs.
  `find_iou_median`: the same IoU for the range window.find selected.
  Document: median and 10th percentile over all words.

## Classes

Comparable with the old probe (same rule, same threshold):

| class | rule |
|---|---|
| `page-count-mismatch` | `.pf` count differs from PDFium's page count |
| `visual-diff-high` | `extra` or `missing` > 0.15, or `block_diff` > 0.02 |
| `glyph-drift` / `font-substitution` | `extra` or `missing` in (0.03, 0.15]; font-substitution when the document has non-embedded fonts |
| `raster-blur` | `missing` > 0.03 with ≥ 80 % faint and `extra` ≤ 0.03 |
| `blank-page` | PDFium ink ≥ 2000 px and screenshot ink < 5 % of it |
| `page-size-mismatch` | screenshot and render differ by > 4 device px |
| `text-loss` | DOM non-space chars < 0.5 × PDFium's (PDFium ≥ 50) |

Reader failure to open or render (the counterpart of the old
`convert-*`, `light-build-failed` and `viewer-load-failed`): `open-failed`
(final status not 200, no `.pf`, no `/r/<hash>/` URL, or not a `raster-v1`
page), `doc-timeout`, `raster-timeout`, `raster-error`, `page-missing`.

Reader-only, no stored old counterpart: `console-error` (console or page
error other than the meta.json 404 line), `meta-json-404` (the overlay asks
for `/<hash>/meta.json`, which reader entries lack), `failed-request`,
`find-miss` (any sampled word not found), `copy-mismatch` (`copy_sim` < 0.95 on
a page with ≥ 50 characters), `highlight-misaligned` (document median IoU
< 0.5), `raster-underres` (raster narrower than the device width by > 2 px),
`jump-failed`, `palette-missing`, `bench-error`, `pdfium-error`.

Not comparable: the old `ghost-glyphs`, `selection-occlusion`,
`tall-line-box` and `covered-text-desync` describe pdf2htmlEX's visible text
layer and converter and have no reader measurement. The old stored console
errors are mostly 404s produced by the probe harness, which stubs daemon
routes; `compare.py` reports them with and without 404 lines.

The A2 thresholds (0.95, 0.5) are provisional and not calibrated against
viewer behaviour Anders notices; compare distributions rather than these
class rates.

## Known limits

- Visual equivalence is near-trivially perfect when the raster arrives at
  the exact device width, because the reference and the raster are the same
  PDFium render. A1 therefore mostly checks that the right raster is shown at
  the right size, not raster quality; it will catch a wrong width, a stale
  raster at another zoom, blank pages and paint from the text layer.
- One zoom only (fit-width 1600 CSS px). Plan A1 asks for fit-width, 100 % and
  200 %.
- `first_raster_ms` runs with up to `--jobs` documents in parallel against
  one daemon, so it includes contention; use `--jobs 1` for timing.
- Highlight IoU against loose boxes is capped below 1 by design: Chromium's
  range rect is the fallback font's ascent + descent, taller than PDFium's
  loose box (about 0.85 for upright Latin text even with perfect horizontal
  fit). Compare IoU between runs, not against 1.
- Find recall uses substring search and words that are unique on the page,
  so it measures whether the text layer is findable, not find precision.
- The copy metric reads `textContent`, not the clipboard. `select_sim` is
  closer but still not a real Cmd-C.
- No native-viewer adapter, no MuPDF cross-check of PDFium, no Vimium.
- The old probe compared each document's own sampled pages; this bench adds
  evenly spaced pages, so document-level worst values cover more pages than
  the old ones (`visual_worst_old_pages` restricts to the same pages).

### Text-only and order investigations

`--text-only` skips raster readiness/screenshots and visual comparisons, while
keeping the same sampled pages, copy/select similarity, native `window.find`
and highlight IoU. It is not a visual or timing proof. Supply
`PDF_VIEWER_CACHE_DIR` to match the scratch daemon and `PDFV_BENCH_SCRATCH` for
an isolated work directory; these override the historical cache/work defaults.

Each sampled page also records `order_inversions` / `order_pairs`: pairs of
upright, non-RTL, single-segment lines with at least half their x extents in
common and distinct y positions. An inversion has an earlier DOM line below
a later one. This diagnoses backward movement in a horizontal lane, not full
reading-order correctness: it cannot judge captions or transitions between
columns. `scripts/measure-reader-order.py` checks known synthetic column order
separately. Copy similarity remains against **PDFium stream order**; do not
change that reference to make a geometric reordering pass. Such a reorder can
preserve every character and still lower this order-sensitive metric.

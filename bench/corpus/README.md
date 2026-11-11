# PDF test corpus

The corpus the hill-climbing week scores against
([`docs/plans/hill-climb-week.md`](../../docs/plans/hill-climb-week.md) §5). It
is a downloaded public set, deliberately weighted toward documents that make the
current viewer or PDFium fail, with a diversity floor across producers, eras,
scripts, page counts and PDF features.

The PDFs themselves are not in git. The repo holds the code and the record of
where every file came from, so the corpus can be rebuilt.

## Location

`$PDFV_CORPUS_DIR`, default `~/.local/share/pdf_viewer/corpus/`:

```
incoming/<source>/            raw downloads, one directory per source
incoming/<source>/_files.tsv  filename<TAB>url<TAB>license   (one row per file)
files/<sha[0:2]>/<sha>.pdf    content-addressed store after ingest (sha256)
manifest.jsonl                one row per unique PDF (written only by ingest.py)
probe/<sha>.json              probe result per PDF and pipeline version
probe/artifacts/<sha>/        diff images for failing pages
```

Disk budget: 25 GB for `files/` plus `incoming/`. Keep at least 50 GB free on
the volume; check `df -h ~` before any bulk step.

## Offloaded copy on Storage Box

On 2026-10-21 the corpus was moved off the Mac to free disk space. The Storage
Box namespace `pdf-viewer-corpus` (root `projects/pdf-viewer-corpus`) holds,
under `v2026-10-21/`:

- `metadata.tar`: `manifest.jsonl`, `ingest-state.json`, `summary-final.json`,
  the probe results (`probe/*.json`) and the local-only source's `_files.tsv`
  and `_collect.py`;
- `incoming-<source>.tar`: one archive per downloaded source, including its
  `_files.tsv`;
- `probe-artifacts.tar`: the probe's diff sheets.

The local-only source (`incoming/own-local/`) is not uploaded; its files are
clones of Anders' own documents and are rebuilt with its `_collect.py`.

To restore, from the repo root:

```bash
SB=~/dotfiles/agents/storage-box
C=~/.local/share/pdf_viewer/corpus
mkdir -p "$C" && cd "$C"
$SB ls pdf-viewer-corpus v2026-10-21
$SB get pdf-viewer-corpus v2026-10-21/metadata.tar metadata.tar && tar -xf metadata.tar && rm metadata.tar
# for each incoming-<source>.tar listed (and probe-artifacts.tar into probe/):
$SB get pdf-viewer-corpus v2026-10-21/incoming-arxiv.tar x.tar && tar -xf x.tar -C incoming && rm x.tar
python3 incoming/own-local/_collect.py
cd - && uv run bench/corpus/ingest.py   # recreates files/ as APFS clones
```

Ingest recognises the existing manifest rows, so it only rehashes and clones;
no facts or probes are recomputed. The tiers in `manifest.jsonl` survive.

## Sources

`sources/*.md` lists each source: what it is, why it is in the corpus, license
or terms, how to fetch more, and how much was taken. Only openly accessible
material: no logins, no paywalls, no paid content, no pirated books. Respect
rate limits and robots rules (arXiv: one request every 3 seconds, through
`export.arxiv.org`).

### Local-only source

`incoming/own-local/` holds Anders' own documents: his course PDFs, NTNU
textbooks and every PDF the viewer has cached. Its collector script,
`_collect.py`, lives in that directory, outside git, and is re-runnable. Rows
carry the license `private-local-only` and a `local:` URL. Nothing from this
source (file names, paths, text, images) goes into the repository. T1 is built
mainly from it, because it is what the viewer is actually used for.

## Manifest row

Written by `ingest.py`, one JSON object per unique PDF:

| field | meaning |
|---|---|
| `sha256`, `bytes` | identity and size |
| `sources` | list of `{source, url, license, filename}`; duplicates across sources merge here |
| `pages`, `pdf_version`, `producer`, `creator`, `encrypted`, `page_sizes` | from PDFium / pdfinfo |
| `fonts` | counts by class: `type3`, `type1`, `truetype`, `cid`, `nonembedded` |
| `features` | detected booleans: `scanned` (little or no text per page), `invisible_text` (render mode 3, OCR layers), `rotated`, `mixed_sizes`, `forms`, `annotations`, `ocg_layers`, `transparency`, `jbig2`, `cjk`, `rtl` |
| `labels` | free labels from the source (for example `arxiv-1995`, `slides`, `datasheet`) |
| `tier` | `t0`, `t1` or `t2` (assigned after probing) |

## Probe

> **Removed 2026-11-11.** The probe scored the pdf2htmlEX engine, which is
> retired ([ADR 0015](../../docs/adr/0015-retire-pdf2htmlex.md)).
> `probe/probe.py`, `convert.sh`, `pdf2htmlex-range.sh`, `shoot.cjs`,
> `summary.py` and `tiers.py` are no longer in the repo. Its stored results
> (`<corpus>/probe/<sha>.json`) and the tiers it assigned in `manifest.jsonl`
> remain as a fixed baseline, read by `bench/reader/`. What is left in
> `probe/`: `pdfium_worker.py` (the PDFium reference renderer and ink
> comparison) and `shared.py` (corpus location, Playwright lookup,
> thresholds). The description below records how the stored results were
> produced.

`probe/` runs each PDF through both pipelines and records failures:

- **current viewer**: native pdf2htmlEX conversion and the light build into a
  scratch cache (`PDF_VIEWER_CACHE_DIR`), with a time limit; then headless
  Chromium screenshots of sampled pages of the light HTML at DPR 2, compared
  with a PDFium render at the same device scale.
- **PDFium**: open, page sizes, render time per sampled page, text extraction
  time and character count, errors.

The result names failure classes, for example `convert-crash`,
`convert-timeout`, `light-build-failed`, `covered-text-desync`,
`visual-diff-high`, `ghost-glyphs`, `blank-page`, `page-count-mismatch`,
`pdfium-error`, `pdfium-slow-page`, `no-text`. These classes decide where bulk
downloading goes next: sources and features with high failure rates get more
documents.

## Tiers

- **T0**: a few dozen small files, one per failure class and feature, for
  every change.
- **T1**: about 100–150 documents, stratified, every failure class represented,
  for every candidate.
- **T2**: everything, overnight.

## Ingest and probe usage

Run from the repo root. Both commands are incremental and can be re-run at
any time while downloads continue.

```bash
uv run bench/corpus/ingest.py                 # hash, store, refresh manifest.jsonl
uv run bench/corpus/probe/probe.py --work /tmp/pdfv-probe   # probe every unprobed row
python3 bench/corpus/probe/summary.py --json /tmp/summary.json   # failure-rate tables
python3 bench/corpus/probe/tiers.py           # write t0/t1/t2 into manifest.jsonl
```

`$PDFV_CORPUS_DIR` or `--corpus` selects another corpus directory.

### ingest.py

- Reads every `incoming/<source>/_files.tsv`. Only files with a row are
  ingested; a last line without a trailing newline is ignored as still being
  written. An optional fourth column holds comma-separated labels; the part of
  a filename before `__` is also taken as a label.
- Copies each file to `files/<sha[0:2]>/<sha>.pdf` as an APFS clone (`cp -c`,
  no extra disk space) and merges provenance of duplicates into `sources`.
- Hashes are cached in `ingest-state.json` by path, size and mtime.
- PDF facts come from a separate `python -I` process per file (time limit
  120 s): PDFium for page count, version, metadata, page sizes, encryption and
  the features; `pdffonts` for the font classes. Features are measured on up
  to 12 evenly spaced pages. `scanned` means most sampled pages have an image
  covering 60% of the page and fewer than 5 visible text objects.
  `invisible_text` means text objects with render mode 3. `forms` means XFA
  or widget annotations (an empty `/AcroForm` does not count). `annotations`
  means annotations other than links, popups and widgets. `ocg_layers` means
  content marked `/OC`. `cjk` and `rtl` mean at least 20 such characters, or
  10% of the text, in the sampled pages. Counts are in `feature_stats`.
- A file PDFium cannot open gets a row with `error` (and pdfinfo facts when
  pdfinfo can read it).
- `--refresh` recomputes facts for every row; `FACTS_VERSION` in the script
  does the same when the detection code changes. `--jobs` (default 6).

### probe/probe.py

One JSON per document in `probe/<sha256>.json`. A result is reused while the
pipeline is unchanged (probe version, `pdf2htmlEX --version`, overlay
version); `--force` re-probes. Selection: `--source`, `--label`, `--sha`,
`--per-source N` (first N per source by hash, a quick stratified sample),
`--per-label N` (first N per source and first label, for example per bug
tracker or PDF/A part),
`--limit`, `--max-pages`. `--reclassify` re-applies the class rules to stored
results without re-running anything (use it after changing a threshold).
`--jobs` (default 4, at most 6) documents run in
parallel; each document runs its steps one after another.

Steps per document, each a child process with its own time limit:

1. **PDFium** (`pdfium_worker.py info`, 120 s): open time, all page sizes,
   render time of up to 10 evenly spaced pages at 3200 device px wide
   (fit-width 1600 CSS px at DPR 2), text extraction time and character count
   (all pages up to 600 pages, with a 20 s budget).
2. **Conversion** (`convert.sh convert`, 300 s): `native_convert` from
   `scripts/lib/pipeline.sh` into a scratch cache under `--work` via
   `PDF_VIEWER_CACHE_DIR`. `convert.sh` refuses to run against
   `~/.cache/pdf_viewer`.
3. **Light build** (`convert.sh light`, 240 s): the pipeline's
   `inject_overlay` on the canonical HTML, then `build_light`
   (externalize-page-images.py and prepare-light-runtime.py, then injection).
   These are the two steps of `build_entry`, called separately because
   `build_entry` ignores a light-build failure.
4. **Text fidelity** (300 s): `scripts/measure-text-fidelity.cjs` on the
   canonical HTML for the sampled pages (ghost glyphs, selection occlusion,
   line-box height), with the limits of `scripts/tests/test_text_fidelity.py`.
5. **Viewer screenshots** (`shoot.cjs`, 240 s): headless Chromium from the
   cached Playwright loads the light HTML with the real overlay. Requests to
   `http://pdfv-probe.test/` are served from the scratch cache, all other
   network requests are aborted. The overlay's zoom preference is set so the
   widest sampled page is 1600 CSS px wide (pages taller than 4000 CSS px get
   a smaller zoom), the viewport holds a whole page, overlay chrome is hidden,
   and each sampled page is captured at DPR 2 after its page raster reports
   `ready` and fonts have loaded.
6. **Comparison** (`pdfium_worker.py compare`, 240 s): each screenshot
   against a PDFium render at the same device scale (forms and annotations
   drawn, as in Chrome's viewer).

The scratch conversion is deleted after each document unless `--keep-work`.
Diff images for failing pages (and for every page with `--save-all`) go to
`probe/artifacts/<sha>/p<N>-sheet.jpg`: viewer, PDFium and diff side by side,
each at a quarter of device resolution, JPEG quality 80 (about 0.1–0.3 MB per page; results
from the first pass have half-resolution `p<N>-{html,pdfium,diff}.png`
instead). When the home volume has less than 56 GB free, sheets are not saved and the
page records `artifacts_skipped`. Re-probe a document with
`--force --sha <prefix> --save-all` to look at it again. In the diff, red is ink only in the viewer, blue is ink only in PDFium, and an orange
tint marks 16×16 blocks whose colour differs.

The pdf2htmlEX page range for long documents needs `-f/-l`, which
`native_convert` does not pass. `convert.sh` points the pipeline's
`NATIVE_BIN` at `pdf2htmlex-range.sh`, which adds them and runs the real
binary; no repo script is changed.

**Sampling policy.** Documents with at most 40 pages and 40 MB are converted
whole and pages 1, the middle page and the last page are compared. Longer or
larger documents are converted in two page ranges, page 1 and a 3-page window
starting at the middle page (`n // 2`), and pages 1, `n // 2` and
`n // 2 + 2` are compared. `page-count-mismatch` then compares the HTML page
count with the requested range. Conversion time is therefore not the full
document's time for long documents.

**Visual metric.** Chromium and PDFium rasterize glyph edges differently
everywhere, so a pixel diff is not used. A pixel is ink when its luma is
below 128. Extra ink is viewer ink with no PDFium ink within 2 device px
(1 CSS px); missing ink is the reverse. A 3×3 opening then removes one-pixel
slivers. `extra` and `missing` are those pixel counts divided by the PDFium
page's ink (at least 0.2% of the page area). `block_diff` is the share of
16×16 blocks whose mean colour differs by more than 48 levels in a channel; it
catches colour fills, images and annotations that the ink metric ignores.
`missing_faint` is the share of missing ink with viewer ink lighter than
luma 200 nearby: the stroke is there, but blurred.

**Calibration.** Known-good documents: `test/fixtures/basic_text.pdf`, the
three text-fidelity fixtures, and the four local control rows of
`test/corpus-text-fidelity.tsv` (Bananflue, introml lecture 10, pmr
preparation, Barjaktarevic). With embedded fonts, `extra` and `missing` stayed
at or below 0.0003. The worst known-good page was the ReportLab fixture with
non-embedded base-14 fonts (substituted differently by Chromium and PDFium):
extra 0.016, missing 0.008, block_diff 0.010. The failure threshold for
`extra`/`missing` is 0.03, about twice that. `block_diff` above 0.02 fails; the
one control over it, Bananflue page 4 (0.029), has highlight annotations that
PDFium draws and the viewer does not, a real difference. In the first pilot,
the visually obvious defects (missing ligatures, word-spacing errors in
beamer slides, Arabic text drawn in a different font) all scored 0.27 or more, and the subtle
ones (glyphs displaced by 1–3 device px, substituted glyph shapes) scored
0.04–0.08, which is why the classes split at 0.15.

**Review of flagged pages (first pass).** Diff images of `glyph-drift` and
`visual-diff-high` pages from mit-ocw and qpdf were checked by eye. The
differences were real and visible when the two renders are compared:
missing ligatures ("separaon" for "separation"), wrong word spacing in beamer
slides, words split by a gap ("Pot ato"), replacement characters in a title,
form XObjects and a filled bar not drawn, link borders drawn by the viewer but
not by PDFium, and Arabic text in a different font. Two kinds are mild: in
documents with non-embedded fonts the viewer shows a different substitute
typeface, often a few CSS px lower; and on OCR'd scans thin strokes come out
lighter. These are now their own classes (`font-substitution`, `raster-blur`).
One probe defect was found and fixed: on small pages (zoom above about 4) the
zoomed page margins pushed the page partly out of the viewport, which showed
as `page-size-mismatch`; the viewport now includes the zoomed margins and a
page that still does not fit is reported as `probe-error`.

**Classes** (a document can have several):

| class | condition |
|---|---|
| `pdfium-error` | PDFium cannot open the file, or a page fails to load, size, render or extract |
| `pdfium-slow-page` | a timing page takes over 1 s to render at 3200 px wide |
| `no-text` | PDFium extracts no characters (document property: find and copy cannot work) |
| `convert-crash` | pdf2htmlEX exits non-zero or writes no HTML |
| `convert-refused` | pdf2htmlEX refuses an encrypted PDF whose permissions forbid copying |
| `convert-timeout` | pdf2htmlEX exceeds 300 s for one page range |
| `covered-text-desync` | the patched converter printed `covered-text desync` (ADR 0013) |
| `page-count-mismatch` | HTML page count differs from the requested range (or PDFium's count) |
| `light-build-failed` | inject or `build_light` failed or timed out |
| `viewer-load-failed` | the light page did not load, a sampled page is missing, or its raster did not reach `ready` |
| `page-size-mismatch` | a page screenshot differs from PDFium's page size by more than 4 device px |
| `visual-diff-high` | `extra` or `missing` above 0.15, or `block_diff` above 0.02 |
| `glyph-drift` | `extra` or `missing` between 0.03 and 0.15, document has only embedded fonts |
| `font-substitution` | the same range, document has non-embedded fonts (Chromium and PDFium substitute different local fonts) |
| `raster-blur` | `missing` above 0.03, at least 80% of it faint, and `extra` at most 0.03 (an upscaled page raster) |
| `blank-page` | PDFium page has at least 2000 ink pixels and the viewer under 5% of that |
| `text-loss` | the page's HTML text has under half of PDFium's non-space characters (PDFium ≥ 50) |
| `ghost-glyphs` | fidelity ghost rate above 0.003 |
| `selection-occlusion` | fidelity occlusion above 0.01 |
| `tall-line-box` | a line box taller than 1.4 em |
| `probe-error` | a bug or failure in the probe itself |

Each result also has a one-line `summary`. Converter warnings are counted by
kind under `convert[].warnings`.

### probe/summary.py

Stdlib only. Prints, for all documents and per group (source, label,
detected feature, font class, page-count bucket, producer family), the number
of probed documents, the share with any viewer class, and the share per class.
`--json` writes the same numbers with up to `--examples` example documents per
class. `--by source,feature` limits the groups; `--min-n` hides small groups.

### probe/tiers.py

Stdlib only. Writes the `tier` field of every manifest row (the one field of
the manifest not written by `ingest.py`; it takes the ingest lock first, and
`ingest.py` keeps the field). `tier` is the smallest tier that holds the
document: T0 documents are also in T1 and T2.

- **T0**: chosen greedily, rarest first, so that every failure class, every
  detected feature and every font class has at least one document, taking the
  documents with the shortest probe time and at most 20 pages first. One
  passing document per owner document type is added as a control.
- **T1** when `own-local` rows are probed: T0, then from `own-local` up to
  two documents per (`course:`, `kind:`) label pair (a failing one first,
  then a passing one), every own document of 200 pages or more, and up to 12
  own documents without a course label (viewer cache), failing ones first.
  Then a small top-up from the public sources per document type (slides 5,
  papers 6, problem sets 4, notes 3, textbooks 3, other real-world 6,
  test-suite 6), and finally two documents per failure class, own documents
  preferred.
- **T1** without `own-local`: T0 plus quotas per document type: slides 20, papers 20, problem
  sets 15, lecture notes 8, long textbooks 12, other real-world documents 15,
  test-suite files 10. The type comes from labels (`slides`, `beamer`, `pset`,
  `exam`, `notes`, ...), the source (arXiv is papers; test-suite sources are
  adversarial), and page shape and count (landscape documents are slides;
  200+ pages from book sources are textbooks). In each type the pick first
  covers each failure class present, then takes two failing documents for
  each passing one, spread across labels. Documents with over 90 s of probe
  time are only taken to cover a class. Every class ends with at least two
  T1 documents when the corpus has two.
- **T2**: every probed document. Rows that have not been probed get
  `tier: null`; probe them and re-run `tiers.py`.

`--dry-run` prints the selection without writing. Re-run it after a probe
pass; the selection changes as the corpus grows.

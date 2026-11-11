# Plan: one week of hill-climbing the viewer

**Status**: Closed (2026-11-11). The raster-plus-transparent-text design (§4)
became the reader (ADR 0014), then the default engine, and pdf2htmlEX was
retired (ADR 0015). The text below is the plan as written, with pdf2htmlEX as
the engine being measured; it is kept as history. Open follow-ups are beads
under `pdfv-4ye` (zoom sharpness, memory) and `pdfv-yg1.18` (reading order).

This plan defines what "better" means for the viewer, how to measure it, which
structural change is most likely to move every measure at once, and how to run
a week of parallel agent work against those measures without regressions.

## 1. What the viewer is for

The viewer exists so that Anders can read PDFs with Vimium and the keyboard.
Chrome's native PDF viewer is the alternative he would otherwise use, so it is
the baseline for every measurement in this plan. The goal follows from that:

> The viewer is a strict superset of Chrome's native PDF viewer. It looks
> identical, opens at least as fast, uses no more memory, finds and selects
> text at least as well, and adds keyboard control, marks, the palette and
> model context. Anders never has a reason to switch to the native viewer, and
> never has to think about conversion.

Two consequences:

1. Every metric is reported as a ratio to the native viewer on the same
   document, machine and viewport. "Better than native" is a number, not a
   claim.
2. Conversion should not be visible to Anders. The current design asks him to
   run a Raycast command on a cache miss and shows the native viewer until then.
   Any design where an arbitrary PDF opens in the custom viewer within about a
   second removes that step.

## 2. The axes

Each axis below can improve indefinitely and can be measured automatically. The
first seven are the ones Anders named; the rest are axes the product already
depends on that would otherwise regress unnoticed.

| # | Axis | Metric (lower is better unless noted) | How it is measured |
|---|------|---------------------------------------|--------------------|
| A1 | Visual equivalence | Fraction of pixels differing from the PDFium reference beyond an anti-aliasing tolerance, per page; worst-page and p99 across the corpus | Screenshot of each sampled page at fit-width, 100 % and 200 %, DPR 2, compared with a PDFium render of the same page at the same device scale |
| A2 | Text accuracy (find, select, copy) | Find recall and precision; copy exactness; highlight-to-glyph alignment (IoU); reading-order edit distance | Ground truth from PDFium character boxes; scripted `window.find`, drag-selection and clipboard checks |
| A3 | Time to view | Trigger to first usable page (page raster ready, controls mounted), cold and warm, by page-count bucket | Scripted journey with tracing; same journey on the native viewer measured by visual completeness of screencast frames |
| A4 | Interaction latency | Page jump to crisp page; `j`/`d` held scroll frame times (p50/p95/p99, dropped frames); far Cmd-F to visible highlight; zoom to crisp; selection drag frame time | CDP tracing, `long-animation-frame` observer, screencast visual completeness |
| A5 | Memory | Whole-process-set physical footprint after a standard journey, minus an empty-tab baseline | macOS `footprint` on every Chrome helper process of a fresh profile, plus the daemon's attributable share |
| A6 | Reliability | Fraction of corpus documents that open with correct page count, no console errors, no hung render and no crash | Corpus run, plus a malformed/encrypted/huge-page fuzz set |
| A7 | Implementation simplicity | Lines of code, number of moving parts per open, third-party patches, runtime monkey-patches, representations per cache entry | `cloc` plus a short checklist in the scorecard; tracked, not optimized blindly |
| A8 | Coverage | Fraction of PDF opens that land in the custom viewer (versus native fallback, `file://`, sign-in-gated, no `.pdf` extension) | Daemon visit log versus extension-observed PDF navigations |
| A9 | Keyboard completeness | Scripted Vimium and overlay journeys pass: hints reach every control, `j`/`d` step sizes exact, marks, palette | Playwright with the real Vimium extension loaded (persistent context) |
| A10 | Disk and idle cost | Cache bytes per page; idle CPU and energy with an open book | `du`; `powermetrics` sample |
| A11 | Upgrade robustness | Number of external toolchain pieces that can break on a Homebrew or Chrome upgrade | `doctor.sh` checklist count |

A9 is in the table because the keyboard surface is the reason the product
exists. A change that wins on A1–A5 and loses a Vimium behavior is a regression.

## 3. What the codebase shows

The overlay is in good shape. It is split into concept modules with explicit
capabilities, and only two modules (`overlay-document.js` and
`overlay-pdf2htmlex.js`) are tightly coupled to pdf2htmlEX's DOM; the rest touch
it in a handful of places, mostly through the `.pf` page-frame convention.

Most of the complexity outside the overlay exists to make pdf2htmlEX's output
behave. pdf2htmlEX paints visible text with embedded web fonts on top of a page
raster that holds everything else. That split is the source of:

- the patched converter and its patch queue (ADR 0013: covered-text index
  drift producing doubled letters; line metrics producing misplaced
  selections);
- the paint-safe text mode, which decides from document CSS whether each `.t`
  line is hidden fallback text (`externalize-page-images.py`, 766 lines);
- font externalization and lazy fonts (`prepare-light-runtime.py`);
- runtime patches to pdf2htmlEX's private viewer object
  (`overlay-pdf2htmlex.js`);
- three representations per entry (canonical, light, diagnostic modes) and
  their routes;
- the native-toolchain build with Homebrew dylib fragility (ADR 0011);
- the cache-miss path: 307 to the native viewer, then a manual Raycast
  conversion.

Measured today on this Mac:

| Document | Pages | pdf2htmlEX convert | Light build | Light HTML | `.t` lines / spans | Page images, fonts |
|---|---|---|---|---|---|---|
| kompendium.pdf | 342 | 27 s | 2 s | 8.7 MB | 29.6 k / 191 k | 11 MB at 1191×1684 px, 4.8 MB |
| entropy.pdf | 55 | 6 s | ~1 s | — | — | — |

ADR 0010 recorded a 5.15 GiB renderer footprint for the 1,677-page AlgDat book
in paint-safe mode, against 12.4 GiB canonical. That book is no longer in the
cache, and the memory harness still defaults to its hash.

The page images are 1191 px wide. At fit-width on a 1600 px viewport with DPR 2
the screen shows 3200 device pixels, so every non-text element in the raster
(figures, rules, path-drawn math) is upscaled about 2.7×. Text looks sharp
because it is drawn with fonts; figures probably do not. The visual-equivalence
bench should confirm or refute this first, because it is a defect the native
viewer does not have.

The same documents through PDFium (`pypdfium2`, native arm64, no build):

| Document | Open + all page sizes | Render one page at 3200 px wide | Text with character boxes, all pages | PNG encode of that page (zlib level 1) |
|---|---|---|---|---|
| kompendium.pdf (342 p) | 73 ms | 9–45 ms (steady state) | 0.82 s (731 k chars, 64 k rects) | 180 ms, 0.8 MB |
| entropy.pdf (55 p) | 2 ms | ~23 ms | 70 ms | 126 ms, 2.0 MB |
| Attention paper (15 p) | 2 ms | ~39 ms | 79 ms | 126 ms, 1.5 MB |

Two facts stand out. PDFium does in well under a second what conversion does in
tens of seconds. And at device resolution, encoding an image costs more than
rendering it; a raw BGRA page is 43 MB. Where pixels are produced and how they
reach the compositor is therefore a first-order design question.

## 4. The structural rewrite worth testing first

### The proposal

Replace pdf2htmlEX with the approach Chrome's own viewer and pdf.js use: every
page is a raster produced by PDFium at the exact device scale, with a
transparent, positioned text layer on top for selection, find, copy and Vimium.

- **Pixels**: PDFium renders each page, text included, at
  `CSS width × zoom × DPR`. Chrome's native viewer also uses PDFium, so the
  reference renderer and the production renderer are the same engine and
  visual equivalence holds by construction, apart from resampling.
- **Text**: one element per text line (or run) from PDFium's character boxes,
  `color: transparent`, a generic local font, `transform: scaleX(...)` to match
  the line width (the pdf.js method). `::selection` paints the highlight; native
  Cmd-F finds and highlights it; Vimium visual mode and the Comet sidebar read
  it. No font embedding at all.
- **Page frames**: emitted from page sizes alone (73 ms for 342 pages), with
  exact intrinsic sizes and `content-visibility: auto`, keeping the `.pf`
  convention so most overlay modules work unchanged.
- **Links and outline**: from PDFium link annotations and bookmarks, rendered
  as real `<a>` elements so Vimium can hint them.
- **On demand**: there is no conversion step. Opening a PDF downloads it,
  hashes it, emits the page shell, renders visible pages first and builds the
  text layer in the background, persisting text JSON and rendered rasters in the
  cache for warm opens.

### What it would change, axis by axis

- **A1**: same engine as the reference; vector figures rendered at device
  scale instead of upscaled; doubled letters and font substitution cannot occur
  because no text is painted by the browser.
- **A2**: reading order comes from PDFium (or MuPDF) structured text rather than
  pdf2htmlEX's drawing order, which addresses `pdfv-yg1.18`. Highlight geometry
  becomes approximate per line, as in pdf.js; the bench must show it is at
  least as good as the current per-glyph spans.
- **A3**: from 6–30 s plus a manual Raycast step to roughly the time to
  download the bytes plus one page render. The miss path and Raycast conversion
  disappear.
- **A5**: no embedded fonts, about a third as many text elements as the current
  span count, and decoded memory bounded by the mounted-page window.
- **A6, A7, A11**: removes pdf2htmlEX, its native build, the patch queue, the
  paint-safe parser, the font preparer, the injector's representation logic,
  the pdf2htmlEX runtime patches and two of three representations. `pypdfium2`
  ships arm64 wheels under a BSD-style license, which also matters if the
  project is published as open source.
- **A8**: every PDF can open in the custom viewer, so coverage is limited only
  by what the extension can intercept.
- Scanned PDFs (the OCR note in `anders.md`, `pdfv-j6j`) become a second text
  source in the same text-layer format, for example from macOS Vision, with no
  change to painting.

### What the spike must prove before anything is built on it

1. Native Cmd-F highlights matches in transparent text visibly, on a page far
   from the viewport, in Comet.
2. Selection on transparent `scaleX` lines copies exact text and its highlight
   is aligned well enough (A2 numbers at least equal to today).
3. The pixel path. Three candidates, measured on time to crisp page and
   memory:
   - **Daemon-native**: the daemon renders with PDFium in a worker-process pool
     and serves images; cost is the encode (§3), mitigated by tiling, fast
     codecs, parallel workers and a disk cache that makes warm opens pure file
     reads.
   - **In-page WASM**: a PDFium WASM build renders into `OffscreenCanvas` in a
     worker; no encode or decode, but slower than native code and a PDFium heap
     per tab.
   - **Current light HTML**, as the baseline.
4. Zoom: time from `⌘+` to a crisp page, with the previous raster scaled as a
   placeholder in the meantime.

If the spike fails on (1) or (2), the fallback is a hybrid: keep pdf2htmlEX's
text layer but render pixels with PDFium at device scale. That still fixes the
upscaling and removes the paint-safe and font machinery, because the text layer
would no longer paint.

### Decisions this reopens

ADR 0001 (engine), ADR 0004 (read-only daemon: the daemon or a worker pool now
renders), ADR 0010 (light HTML), ADR 0011/0013 (native pdf2htmlEX and patches)
and the non-goals on auth-gated fetching and `file://`. Each needs a superseding
ADR if the spike wins, written at the decision gate, not before.

## 5. Measurement comes first

The week succeeds or fails on whether the bench is trustworthy. Nothing in the
product changes until the bench can score the current viewer and the native
viewer.

### Corpus

**Built 2026-10-21; see [`bench/corpus/README.md`](../../bench/corpus/README.md).**
It is a downloaded public set of about 17,400 PDFs, weighted toward documents
that made the current viewer fail, plus a local-only set of Anders' own course
PDFs and textbooks. Tiers are recorded in its manifest. The tier descriptions
below were the original design.

- **T0 fixtures** (seconds, every change): the existing `test/fixtures`, the
  text-fidelity fixtures, plus a handful of adversarial files (rotated pages,
  mixed page sizes, encrypted, a 2,000-page synthetic book, a scanned page,
  forms, annotations, CJK).
- **T1 stratified set** (~100 documents, under 10 minutes, every candidate):
  sampled by producer (pdflatex, dvips, Word, InDesign, scanners, Chrome print),
  font class (Type 3, Type 1, substituted base-14, CID), page count bucket and
  file size, including the existing `test/corpus-text-fidelity.tsv` documents
  and Anders' most-visited documents from `visits.db`.
- **T2 full local corpus** (overnight): every readable local PDF, three sampled
  pages each, for A1, A2 and A6 only.

A manifest builder writes `bench/corpus/*.tsv` (hash, path, class labels, pages,
sampled pages) so every run is reproducible.

### Reference and adapters

The visual reference is a PDFium render at the exact device scale, which is what
the native viewer shows. A second render with MuPDF flags pages where PDFium
itself is suspect, so those pages are not used to judge the viewer.

The bench drives every candidate through one adapter interface:
`open(doc) → ready`, `goToPage(n)`, `scrollBy(px)`, `find(term)`,
`selectRange(page, a, b)`, `zoom(level)`, `screenshotPage(n)`. Adapters exist for
the native viewer (keyboard events and screencast only, since `chrome://pdf`
cannot be scripted), the current light viewer, and each spike candidate. Writing
the native adapter early matters most, because every target is a ratio to it.

### Scorecard and ratchet

One command produces one JSON file per run:

```bash
uv run bench/run.py --tier t1 --candidate light --out bench/results/<commit>-light.json
```

A compare command prints per-axis deltas with noise bands. Noise is estimated by
running the baseline five times; a change counts as an improvement or
regression only beyond twice the median absolute deviation, with a small floor.

`bench/baseline.json` is the ratchet. A change may land only if no axis
regresses beyond its band, unless it records the trade explicitly (axis, size,
why it is worth it) in the experiment log and Anders accepts it at a gate. Each
improvement that lands updates the baseline, so the measures can only move one
way.

### Galleries

Every T1 and T2 run writes a contact sheet of the 50 worst pages per axis
(reference, candidate, difference image). A reviewing agent reads the sheets,
groups failures by cause, and files beads. This is how corpus-scale problems
become concrete work items instead of an average.

### What the bench cannot prove

Comet itself, the real Vimium settings, Raycast and the Comet LLM sidebar. Two
things narrow the gap: Playwright can run Chromium with the real Vimium
extension loaded, and may be able to launch Comet's binary directly. The rest is
a short manual checklist Anders runs at each gate (§7).

## 6. The iteration loop

- **Inner loop (minutes)**: change, run T0 (under a minute), run the T1 axes the
  change targets, compare with the baseline, keep or revert. Every attempt,
  kept or reverted, gets one line in `bench/experiments.md`: hypothesis, axis,
  result, decision. Reverted attempts are as useful to the next agent as kept
  ones.
- **Outer loop (daily)**: full T1 on every axis, T2 overnight, gallery review,
  new beads, and a short daily summary at the top of the experiment log.
- **Rule against fooling ourselves**: a metric improvement that comes from
  changing the measurement does not count. Bench changes land separately,
  re-score the baseline, and are reviewed before product changes are compared
  against them.

## 7. Parallel work

### Contracts frozen on day 1

Parallel agents need fixed seams so they do not edit the same files:

1. **Bench adapter interface and scorecard schema** (§5).
2. **Page DOM contract**: `.pf` frames with page size attributes, a text layer
   element per page, raster lifecycle states, link elements. The overlay reads
   only this, through `overlay-document.js`.
3. **Render API**: daemon routes for page shell, page raster (page, scale,
   optional tile), text JSON and outline, so pixel and text work can proceed
   independently.

### Workstreams

| Stream | Owns | Depends on |
|---|---|---|
| WS0 Bench | `bench/`, corpus manifests, adapters, galleries | none; starts first |
| WS1 Pixels | render API, worker pool, image transport, raster cache, prefetch | contracts 2–3 |
| WS2 Text layer | text JSON builder, reading order, line merging, OCR source later | contract 2 |
| WS3 Shell and overlay port | page shell, `overlay-document.js` for the new contract, removal of `overlay-pdf2htmlex.js` from the new path | contract 2 |
| WS4 Delivery | extension routing for all PDFs, download/stream path, sign-in-gated fetch, `file://` | contract 3 |
| WS5 Tuning | latency and memory work on the chosen design | WS1–WS3 at parity |
| WS6 Simplification | deleting retired paths, ADRs, docs | decision gate |

Each stream works in its own git worktree and branch and merges through the
ratchet. One integrator agent owns merges and the baseline file.

### Week schedule

| Day | Work | Gate |
|---|---|---|
| 1 | WS0 builds corpus tiers, reference, native and current adapters; records baseline scorecards for native and current. Contracts written. | Bench reproduces within its noise band on repeated runs |
| 2 | Spike: daemon-native and WASM pixel paths, transparent text layer on T1, the four proofs in §4 | **Anders approves the architecture** from the scorecard; superseding ADRs drafted |
| 3–4 | WS1–WS4 in parallel to feature parity behind a separate route (for example `/view2`) | T0 green; overlay journeys (`verify-overlay.sh` groups) pass on the new route |
| 5 | WS5 tuning against the ratchet; T2 overnight | No axis worse than current; most axes at or better than native |
| 6 | Default routing switches to the new path, old path kept as rollback; Anders reads with it in Comet | **Anders' manual checklist**: Vimium hints and steps, Cmd-F far term, selection and copy, marks and resume, sidebar LLM context |
| 7 | WS6 retires the old path from normal routing, reconciles README, CLAUDE.md, ADRs and `docs/` | Deleting pdf2htmlEX code is a separate decision after some days of real use |

## 8. Work to stop or not start

- **pdf2htmlEX fidelity work**: further converter patches, paint-safe parser
  refinements, font preparation and runtime patches are investments in the path
  the spike may retire. Pause them until the gate on day 2.
- **Bulk indexing and reconversion**: `index-directory*.sh` and
  `upgrade-cache.sh --mode=reconvert` exist because conversion is slow. Under
  on-demand rendering only text extraction is worth precomputing, for
  cross-document search (`pdfv-yg1.14`).
- **The fixed-document memory harness**: `measure-viewer-memory.cjs` defaults
  to an AlgDat hash that is no longer cached. Fold its method (fresh browser,
  `footprint`) into the bench instead of maintaining it separately.
- **Overlay `/` search over visible pages**: with a text JSON per page, a
  whole-document search can run on data rather than the DOM; until then it
  duplicates native Cmd-F.
- **`docs/arm64-native-proposals.md`**: historical; it can move to an archive
  note.

## 9. Lower-level performance, after the architecture settles

These matter only once the structural question is answered, and each must show
a ratchet improvement to land.

- Render at exact device pixels for the current zoom so the compositor never
  resamples; on zoom, show the scaled previous raster and replace it.
- Tile large pages (for example 512 px) so encode, transfer and decode run in
  parallel and memory scales with the viewport, not the page.
- Choose the image transport by measurement: fast PNG, lossless WebP, raw
  pixels into `ImageBitmap`, or in-page rendering. Decode off the main thread
  (`createImageBitmap`, `decoding="async"`).
- Prefetch by scroll direction and velocity; on a jump, render the target page
  first and cancel stale requests.
- Keep hot documents open in the worker pool (PDFium is not thread-safe, so
  use processes), keyed by content hash.
- Minimize text-layer elements (one per line), and measure nodes per page and
  style-recalculation cost directly.
- Measure overlay startup separately (module count, first frame); bundle only
  if the numbers show a cost, since the repo has no build step by design.
- Watch compositor layers and `will-change` use; ADR 0002 already showed that
  unconditional containment caused churn.

## 10. Brief for the autonomous agent

Paste this as the week's goal.

> **Goal.** Make the pdf_viewer a strict superset of Chrome's native PDF viewer
> on every axis in `docs/plans/hill-climb-week.md` §2, measured as ratios to
> the native viewer on Anders' own PDFs, without losing any keyboard or Vimium
> behavior.
>
> **Order of work.** Build the bench first (§5) and record baseline scorecards
> for the native viewer and the current viewer before changing the product.
> Then run the spike in §4 and stop at the day-2 gate with a scorecard and draft
> ADRs for Anders. The rewrite to raster plus transparent text is in scope for
> the whole week, but do not build on it until he approves it at that gate.
> Stopping there is expected: end the session with the gate report and wait for
> his answer. If the spike fails proofs (1) or (2) in §4, propose the hybrid
> fallback described there instead.
>
> **Corpus.** It already exists; do not rebuild it. Read
> `bench/corpus/README.md`. The PDFs and `manifest.jsonl` are in
> `~/.local/share/pdf_viewer/corpus/` (17,615 documents, 11,240 probed against
> the current viewer). Use the tiers recorded in the manifest: T0 (24
> documents) on every change, T1 (120 documents, about half of them Anders'
> own course PDFs) for every candidate, T2 (all probed rows) overnight. The
> probe in `bench/corpus/probe/` already compares the current light viewer with
> PDFium page by page; extend it into the bench rather than starting over.
> Lessons from building it: two of its early failure classes were probe bugs
> (small pages pushed out of the viewport; screenshot timeouts under parallel
> load), so check a new failure class by eye on its diff images before trusting
> its rate, and re-run suspicious failures alone.
>
> **Private documents.** The `own-local` source holds Anders' course PDFs,
> textbooks and viewer cache. Nothing from it — file names, paths, text,
> screenshots, diff images — goes into the repository, commit messages or
> anything published. Refer to these documents by sha256 prefix and labels.
>
> **Measurement runs.** Visual and text checks may run in parallel. Latency
> and memory runs must run one at a time with no other probe, agent or build
> running, and are scheduled overnight when Anders is away; keep the Mac awake
> for them. Record the time and machine state with each run.
>
> **Existing beads.** The rewrite makes some open beads obsolete or changes
> them, notably `pdfv-yg1.1` (Cmd-F on large sections), `pdfv-yg1.7` and
> `pdfv-yg1.9` (selection and native-find behavior), `pdfv-yg1.18` (logical
> text order) and `pdfv-j6j` (scanned PDFs). Do not work on them on the old
> architecture; note on each bead how the rewrite affects it.
>
> **Rules.** Every change goes through the ratchet: no axis may regress beyond
> its noise band without a recorded trade that Anders accepts. Bench changes
> land separately from product changes. Log every attempt in
> `bench/experiments.md`. Use Beads for work items per `docs/ai-production.md`.
> Run parallel streams in separate worktrees along the contracts in §7; one
> integrator owns merges and `bench/baseline.json`.
>
> **Constraints.** Documents never leave the machine. The daemon binds to
> `127.0.0.1`. Keyboard behavior and Vimium coexistence (`docs/keybindings.md`,
> ADR 0003, ADR 0005, ADR 0012) are requirements, not metrics to trade. Keep
> the old route as a rollback until Anders decides to delete it. Commit
> locally on a working branch made from `codex/pdf-book-gates-20261012` (and on
> the streams' worktree branches) as often as the ratchet allows; this is
> approved. Do not push, merge into `main` or open PRs; Anders merges at the
> end.
>
> **Deliverables.** Bench and corpus tooling; a scorecard per day; the chosen
> architecture behind a route and then as default; superseding ADRs; updated
> README, CLAUDE.md and `docs/`; a final report comparing day-1 and day-7
> scorecards against native, with the worst-page galleries.

## 11. Decisions for Anders

1. ~~Whether the raster-plus-transparent-text architecture is in scope for the
   week, or only the bench and the spike.~~ Decided 2026-10-20: in scope for the
   whole week, subject to the day-2 gate.
2. ~~Whether the native viewer is the right baseline for every axis.~~ Decided
   2026-10-20: yes, until a measurement shows it is the wrong reference for a
   particular axis; such a change is recorded in the experiment log.
3. ~~Which local folders the corpus may read.~~ Decided 2026-10-20: the
   corpus is a downloaded public set, gathered before the week starts and
   weighted toward documents that make the current viewer fail. See
   [`bench/corpus/README.md`](../../bench/corpus/README.md). Anders' own PDFs
   can be added later as a local-only supplement.
4. ~~Whether bench runs may use the Mac overnight.~~ Decided 2026-10-21:
   latency and memory runs happen overnight on the Mac without Anders, one at a
   time. Local commits on a working branch are approved; pushing is not. The
   agent stops at the day-2 gate and waits for Anders.

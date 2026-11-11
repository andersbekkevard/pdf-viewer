# Reader selection and reading-order investigation

The stale-selection proxy is fixed. The whitespace-to-top and Vimium line-motion
bugs did not reproduce on the generated reader fixtures; regression guards are
retained. Geometric ordering is **unfinished**: a measured, opt-in prototype
improves synthetic reading order but fails the required corpus copy-similarity
gate. It is disabled by default. No owner daemon, owner cache or headed browser
was used. Work is local on `t3/reader-text-selection-order`; no push or PR.

## Findings

- **pdfv-yg1.7:** real mouse drags from a line into the left margin, column gap,
  paragraph gap and below the final text on single/two-column pages stay local
  on the unmodified reader. The earlier apparent empty-selection failure was a
  test artifact: a fresh press within an existing selection can initiate native
  drag-and-drop. Clear that selection before each independent drag. Experiments
  with an end-of-content hit area, inline spans and `user-select` changes were
  removed; no text-layer CSS/markup workaround is shipped.
- **pdfv-yg1.10:** real Vimium trusted `j`/`k` cross a page boundary, and `j`
  crosses a column break and figure gap. No stuck reader boundary reproduced.
  The checks extend the existing real Vimium harness, rather than emulating
  Vimium through page key listeners. Its scratch extension rule-count assertion
  was stale after the extension's content-type rule was added; it now expects
  the two existing daemon origins. `PDFV_PORT` selects an isolated test port.
- **pdfv-yg1.9:** after `window.find`, scrolling to 800 px and re-announcing the
  same selection following Enter returned to 0 px before the fix. After the
  fix it stays at 800 px. `overlay-scrolloff.js` now requires a changed focus
  node/offset before following. Search's deliberate Enter/n/N moves and Vimium
  visual/caret motion retain their existing scrolling and suppression.
- **pdfv-yg1.18:** the XY prototype splits horizontal empty bands, then persistent
  x gutters, and sorts disjoint upright lines in a column vertically. Ambiguous
  overlaps keep stream order; rotated stamps follow the body; RTL pages retain
  their original order. Recursion is bounded. No line's characters, segments,
  geometry or style are changed. Shell version is 7; text version is 5 normally
  and 7 with `PDF_VIEWER_GEOMETRIC_TEXT_ORDER=1`, preventing cross-mode cache reuse.

Known synthetic order: two columns improve from 28 inversions to 0, three
columns from 84 to 0. Single-column captions/footnotes/stamp are vertically
ordered; table rows and the Hebrew page are unchanged. Every output contains
exactly the original line objects. The fixtures include intentionally scrambled
stream order; this is an independent truth for their column tokens.

Double-click selects a word; triple-click selects a line. Selection across two
pages contains each boundary line once, has a line break and copies exactly to
the headless native clipboard. A hyphenated line end remains `-` followed by a
newline, with no invented de-hyphenation. Hebrew extraction/ordering and RTL
markup are guarded by daemon tests and the generated-page order measurement.
A headless native-clipboard comparison on the same Hebrew fixture also
matched with the original `bc4c517` scrolloff module and the fixed module
(`rtl-copy.json`, 21 characters, both non-empty). The native quote command's
existing formatting was not changed.

## Corpus gate

The completed runs use the same 63 tier-0/tier-1 documents and 266 sampled
pages (249 pages have text). Document-median metrics:

| Metric | Stream-order baseline | Geometric prototype |
|---|---:|---:|
| Copy similarity (median document mean) | 0.9999 | 0.9980 |
| Find recall (median) | 1.0 | 1.0 |
| Highlight IoU (median document median) | 0.8358 | 0.8358 |
| Documents with copy-mismatch | 0 | 19 |

The baseline and corrected prototype have the same pre-existing find-miss on `7319a537e6c3` (recall 0.9714).
The corrected prototype is rejected for default use. A failing unit regression
exposed x-sort order leaking into ambiguous recursive groups in the first
prototype; restoring original stream order fixed that bug. The table reports
the corrected version, not the initial rejected 0.9604 / 39-mismatch run. The copy score is explicitly
order-sensitive and compares against PDFium stream order; its reference was
not rewritten to favor the prototype. Some drops reflect the intended
reordering, but that does not satisfy the requested no-regression gate or
establish confidence for every ambiguous page. More conservative confidence
rules and an independently justified reading-order reference remain work.

The scorecard now has `--text-only`, isolated cache/work overrides, and
`order_inversions` / `order_pairs` diagnostics. That geometric diagnostic
counts vertically reversed lines sharing a horizontal lane, excludes RTL,
rotated text and segmented table rows, and does not judge column transitions.
The baseline run began before its driver fields were persisted, so the final
default-reader run supplies the comparable geometric baseline.

Shared-machine load was high: observed load averages included
140.64/116.16/60.55 during initial checks and 46.61/123.73/98.76 during the
ordering investigation. Timing numbers are not used. An initial full visual
scorecard was stopped after 12 documents because raster/screenshot waits were
outside this text-only investigation; the completed text runs retain the
existing copy/find/highlight definitions. They do not verify raster visuals.

## Commands and evidence

All evidence is outside the repository under `/tmp/pdfv-text-7449/`.

```sh
# Baseline and experimental daemons, run serially on port 7449:
PDF_VIEWER_ENGINE=reader PDF_VIEWER_CACHE_DIR=/tmp/pdfv-text-7449/cache \
  PDFV_STATE_DB=/tmp/pdfv-text-7449/state.db \
  uv run --directory daemon uvicorn main:app --host 127.0.0.1 --port 7449
# Add PDF_VIEWER_GEOMETRIC_TEXT_ORDER=1 only for the rejected prototype run.

PDF_VIEWER_CACHE_DIR=/tmp/pdfv-text-7449/cache \
  PDFV_BENCH_SCRATCH=/tmp/pdfv-text-7449/bench-before-text \
  uv run bench/reader/run.py --tier t1 --text-only --include-existing \
  --base http://127.0.0.1:7449 --out /tmp/pdfv-text-7449/before-text.json --jobs 1
# Same command with bench-order-corrected and geometric-corrected.json for the corrected prototype.
# Same command with bench-final and final-text.json for the final default.
python3 bench/reader/compare.py /tmp/pdfv-text-7449/before-text.json
python3 bench/reader/compare.py /tmp/pdfv-text-7449/geometric-corrected.json
python3 bench/reader/compare.py /tmp/pdfv-text-7449/final-text.json

uv run --quiet --no-project --with reportlab python \
  scripts/lib/text-selection-fixture.py /tmp/pdfv-text-7449/order.pdf
uv run --directory daemon python ../scripts/measure-reader-order.py \
  /tmp/pdfv-text-7449/order.pdf
uv run --directory daemon python -m unittest discover -s tests
PDFV_PORT=7449 scripts/verify-overlay.sh --reader
PDFV_PORT=7449 scripts/verify-vimium.sh --engine reader
```

Unit tests: 215 run, one skipped, no failures. Synthetic order check passes.
Full reader overlay: 95/95 checks pass. Real Vimium: 53/53 checks pass.
After adding the RTL clipboard guards, the selection-only group also passes
19/19 checks.
The first order unit run failed before `reading_order` existed; the new
column/caption/RTL/table checks pass afterward. The stale-find proxy failed
before the focus-endpoint guard and passes afterward. Non-reproduced bugs
have guards, not invented failing behavior or speculative product changes.

## Limits and handoff

The native Cmd-F bar is not available in headless Chromium. `window.find` and
repeated selection-event handling are established, but real Cmd-F Enter,
the owner's Vimium settings, Raycast, drag-and-drop of an existing selection,
and arbitrary PDF producers remain unproven. Upright margin notes are not
confidently classified by the prototype; only rotated stamps are deferred. The RTL comparison replaces the changed overlay module on the same stream-order
reader text; it is not a comparison of two complete historical app builds.

Minimal edits outside the requested product boundary: `overlay-scrolloff.js`
owns the actual stale-selection follow behavior. The scratch test helper uses
`SO_REUSEADDR` for its free-port probe so the assigned port can be reused after
stopping a daemon, while still rejecting a live listener. No raster/rendering
functions, quick-open, sidebar/pins, navigation or zoom modules were edited.

Local implementation commits so far: `a41b3f2` (selection guards/follow fix),
`dda4eb6` (opt-in ordering and scorecard measurements), `bd07156` (keep original
stream order in ambiguous recursive groups). A final verification
commit records this report, evidence comments and small harness follow-ups.

Selection research reference: [PDF.js text-layer builder](https://raw.githubusercontent.com/mozilla/pdf.js/master/web/text_layer_builder.js)
creates an empty `endOfContent` hit area and, for older Chromium, moves it next
to the active selection. It informed the discarded experiment; it did not
justify changing this reader after corrected native-drag checks passed.

Final default-reader scorecard (`final-text.json`): all 63 documents have
**identical metrics** to the stream-order baseline, with no new failure class.
The median copy/find/IoU values remain 0.9999 / 1.0 / 0.8358.

Additional native RTL comparison command (same fixture and browser, original
versus fixed scrolloff module):

```sh
git show bc4c517:assets/overlay-scrolloff.js > /tmp/pdfv-text-7449/baseline-scrolloff.js
source scripts/lib/playwright.sh
resolve_playwright
NODE_PATH="$PW_NODE_PATH" node /tmp/pdfv-text-7449/check-rtl.cjs
```

The durable selection-only command after adding native RTL guards was:

```sh
scripts/verify-overlay.sh \
  'http://127.0.0.1:7449/read?path=/tmp/pdfv-text-7449/order.pdf' --only selection
```

The corrected corpus comparison (`summary.json`, `geometric-corrected.json`)
measures all 266 pages against the final default-reader order: geometric lane
inversions decrease **10,086 → 6,478**, with **zero pages worse** by that measure.
All compared DOM character counts are identical. This supports a geometric
improvement, not a claim of fully correct semantic order; the 19 new
copy-mismatch documents still fail the rollout gate. Synthetic two/three-column
inversions remain 28/84 → 0/0, including independent caption/footnote/stamp
ordering assertions. Table and RTL pages retain their extracted order.

Beads `.7`, `.10` and `.9` were closed with the scoped reader evidence and
limitations above. `.18` is open with the corrected prototype's failed gate.
The scratch daemon on 7449 is stopped. Nothing was pushed.

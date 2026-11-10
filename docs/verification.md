# Verification

Use the existing automated checks and a narrow real-surface verification loop before
closing a bead. Tests live in `daemon/tests/` and `scripts/tests/`; they use temporary data.
Run the relevant suite through `uv` with its declared dependencies. For current discovery:

```bash
uv run --directory daemon python -m unittest discover -s tests
uv run python -m unittest discover -s scripts/tests
```

## Verification surfaces

Use the available browser tooling for real converted HTML and screenshots. Comet extension,
Vimium, Raycast and the Comet LLM sidebar require those actual surfaces; a standalone browser
check cannot establish their integration. Daemon/cache behavior can also use curl and logs.
Use existing browser tools for ad hoc verification; add a durable test dependency only when
the task calls for it.

## Session checklist

Before implementation:

```bash
br show <id>
br sync --status
curl -fsS http://localhost:7435/healthz
```

If the daemon is down and the bead needs it:

```bash
uv run --directory daemon main.py
```

For the launchd-managed daemon:

```bash
launchctl kickstart -k gui/$UID/com.anders.pdf_viewer
tail -f ~/.cache/pdf_viewer/daemon.log   # daemon; conversions log to ~/.cache/pdf_viewer/log
```

Before closing a bead:

```bash
git diff --check
br comments add <id> "Verification: <what was checked and result>"
br close <id> --reason "Completed"
br sync --flush-only
```

If verification is blocked, do not close the bead. Add a comment explaining the
blocker, what was attempted, and the exact missing artifact or user action.

## Overlay smoke test (standard pre-close check for overlay beads)

`scripts/smoke-viewer.sh` is the standard pre-close check for any bead that
touches `assets/overlay*.js` or `assets/overlay.css`. It is a single command that exits non-zero
on any failure:

```bash
scripts/smoke-viewer.sh
```

It converts `test/fixtures/basic_text.pdf` with the real native pdf2htmlEX
binary into a temp cache entry, injects the live overlay, and runs headless
Chromium (the locally-cached Playwright — no repo dependency) against the real
daemon on `:7435`, asserting: expected `.pf` page count,
`#pdf2html-pageno-current` present, sidebar DOM present,
`pdf2htmlEX.defaultViewer.render_timer === null`, `window.find('Normal')`, zero
console errors, and zero failed `/_assets/` requests. The temp entry is
trap-cleaned on exit. The daemon must already be up — the script never starts
it. Run it green before closing an overlay bead; a richer interactive proof
from the list below is still warranted when the bead changes behavior the smoke
test does not assert.

## Pick the right proof

Use the smallest proof that exercises the changed behavior:

- **Overlay UI / keyboard work**: open a real converted PDF through
  `localhost:7435`, perform the key sequence or pointer action, and confirm the
  visible state with Browser/Playwright screenshot or DOM snapshot.
- **Overlay behavior (any `assets/overlay*` change)**: run
  `scripts/verify-overlay.sh <viewer-path>` against a cached document with an
  outline and internal links (e.g. `/<hash>/<stem>.light.html`), and once
  against a short paper. Groups (`--only geometry,navigation,sidebar,commands,search`)
  cover Vimium-sized steps and zoom (ADR 0012), page and chapter jump landing,
  marks and resume, sidebar keyboard commits, palette commands, preferences,
  settings, the cheatsheet and `/` search. Real Vimium speed still needs Comet.
- **Conversion pipeline (`scripts/lib/pipeline.sh` and its callers)**: run
  `uv run python -m unittest discover -s scripts/tests`, then index a small
  folder with `scripts/index-directory.sh` and check the summary line, the new
  entry's HTML, `.light.html`, `meta.json`, `thumbs/` and its `mappings.tsv` row.
- **Native browser find**: use a large converted PDF, open native Cmd-F, search
  for text outside the initially visible pages, press Enter through matches, and
  confirm the active highlight is visible on the expected page. Check normal
  reload and hard reload if the bead mentions stale assets.
- **Selection behavior**: use a real converted PDF page, perform the exact drag
  or visual-mode action from the bead, and verify both visible selection and
  copied clipboard/plain-text output when relevant.
- **Daemon/cache behavior**: verify with `curl`, `rg ~/.cache/pdf_viewer`, and
  the daemon logs. A browser check is still needed if the route changes user
  navigation.
- **Conversion/injection behavior**: use a small local PDF fixture or a known
  cached PDF. If conversion itself is exercised, the native pdf2htmlEX binary
  must already be installed (`scripts/install-native-pdf2htmlex.sh`, ADR 0011);
  scripts must not auto-install or auto-build it.
- **Extension redirect behavior**: verify in Comet with the unpacked extension
  loaded. Check both cache hit and passthrough/cache-miss paths when redirects
  change.
- **Memory/performance work**: define the measurement first, run it before and
  after on the same document, and record the numbers in the bead comment.
- **LLM context work**: verify in Comet's LLM sidebar with the exact prompt or
  interaction used. Record what the sidebar could and could not access.
- **Docs-only work**: verify links, command accuracy, `git diff --check`, and
  `br sync --status`.

## Artifacts

- Keep temporary Browser/Playwright output out of commits unless it is useful
  evidence for a review.
- If a screenshot or trace should be kept, store it under `output/playwright/`.
- Do not create new top-level artifact folders.

## Close-out standard

A bead is done only when all three are true:

1. The behavior is implemented or the research question is answered.
2. The owning docs are updated or explicitly not affected.
3. The bead has a verification comment with the command/browser flow and result.

## Text-layer fidelity regression

`scripts/tests/test_text_fidelity.py` converts the committed fixtures in
`test/fixtures/text-fidelity/` (rebuild them with its `build.sh`) with the
native binary and measures the HTML with `scripts/measure-text-fidelity.sh`.
It fails on doubled glyphs (raster and opaque HTML ink coinciding), on text ink
hidden by a full-page selection painted with the overlay's `::selection`, on
line boxes over 1.4 em, and on a `covered-text desync` converter warning (ADR
0013). It is part of the script suite and skips without the binary or a cached
Playwright. Run it after any converter rebuild or Homebrew upgrade, and against
a candidate build with `PDF2HTMLEX_BIN=<path>`.

The local corpus in `test/corpus-text-fidelity.tsv` (Type 3, substituted
base-14, TeX math and control documents, split in-sample/held-out) runs with
`PDF_VIEWER_TEXT_CORPUS=1` and prints a table; missing documents are skipped.
To inspect one conversion, `scripts/measure-text-fidelity.sh <file.html>
--pages 1,2 --save <dir>` writes the raster-only, text-only and selected
screenshots it measured.

## Raster lifecycle regression

Run `node scripts/tests/test_raster_lifecycle.cjs` for repeated proximity,
entry/exit, multi-raster readiness, stale completion and failure/re-entry
coverage. This deterministic contract complements the real-book verification;
it does not establish renderer memory, scroll latency or Vimium integration.
For fallback-selection changes, compare real selected-page screenshots at
fit-width, 100% and 200%, and assert exact copied text and visible far-find
highlights. Retain before/after physical-footprint and frame-time measurements
from the same book and representation before claiming a performance fix.

## Prepared startup and font regression

Run `node scripts/tests/test_early_runtime.cjs` to assert one visible-page
measurement for a 606-page input, preserved private Page methods, numbering,
CTM/inverse CTM, idempotence and fail-closed metadata. The script suite includes
`test_prepare_light_runtime.py` for exact font bytes, deduplication, unchanged
text paint markup, mixed dimensions, invalid metadata and canonical-file guards.

For actual input, compare baseline and prepared idle/selected screenshots at
fit width, 100% and 200%, assert copied text against a known passage, and find
a term on a distant page before and after reload. Measure a fresh browser's
whole process set together with attributable serving memory; a renderer-only
number is not the total-memory gate. Report cold and warm usable load through
mounted controls, fonts, first-page raster readiness and two animation frames.

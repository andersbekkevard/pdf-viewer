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

`scripts/smoke-viewer.sh --reader` is the fast, self-contained pre-close check
for reader overlay changes. It generates one synthetic page with reportlab
through `uv`, boots a scratch reader daemon on a free loopback port with its own
temporary cache and state database, and uses cached Playwright/Chromium headlessly.
It checks overlay/sidebar boot, native `window.find`, zero console/page errors
and zero failed overlay asset requests, then stops the daemon and removes the data.
It never touches the owner's daemon or cache. `PDFV_PORT=7441` requests a particular
free port; an occupied requested port fails rather than using that daemon.

The existing `scripts/smoke-viewer.sh` without arguments remains the legacy
pdf2htmlEX check (running daemon on 7435 required). Prefer the isolated
`scripts/verify-overlay.sh --pdf2htmlex --only smoke` when testing that engine
without writing to the owner's cache.

## Overlay regression checks

```bash
scripts/verify-overlay.sh                      # self-contained reader, headless
scripts/verify-overlay.sh --both               # reader then native pdf2htmlEX
scripts/verify-overlay.sh --pdf2htmlex          # isolated native conversion
scripts/verify-overlay.sh http://127.0.0.1:7441/r/<hash>/
PDFV_BASE=http://127.0.0.1:7441 scripts/verify-overlay.sh /<hash>/<file>.light.html
scripts/verify-overlay.sh --reader --only geometry,navigation,sidebar,commands,search
```

With no target, the harness generates a 160-page version of the outline/link fixture
from `verify-vimium`, long enough for the jump checks. All scratch data and processes
are cleaned on exit; no Playwright installation or owner browser profile is used.
Native pdf2htmlEX must already be installed for `--pdf2htmlex`/`--both`; missing tools
fail explicitly. Full URLs select their own origin for resets and state requests.
Cached-document runs reset the target's preferences and per-document state, so use
a disposable document/cache. They require enough pages, text, outline and internal
links for the requested groups; absent outline/link cases are explicitly reported.

The shared geometry, navigation, sidebar, commands, search, smoke and interaction
groups run on both engines. Interaction covers arrows, Space/Shift-Space,
PageUp/PageDown/Home/End, Cmd-Z/Cmd-Shift-Z, Cmd/Ctrl plus/minus/0 (page width changes
while sidebar width stays fixed), dark pages, the brief counter, quote copying,
accessible expiring toasts, and position/zoom/marks restored from daemon state after
clearing localStorage. Reader-only checks assert transparent text and, on a fresh
generated document, hold text-range responses until the first raster paints, then
require all text and `data-reader-text="complete"`. The pdf2htmlEX private runtime
page/scale and stopped render-loop assertions are marked engine-specific.

These checks exercise trusted Playwright keys without Vimium loaded. They complement
the real-extension check below and cannot prove Comet, Raycast or native Cmd-F UI.

## Vimium check

`scripts/verify-vimium.sh [--engine reader|pdf2htmlex|both]` runs the viewer under the
real Vimium extension. It copies the Vimium installed in the Chrome Default profile into a
temp dir (read-only; nothing is committed) and loads it with a patched copy of `extension/`
into headless Chromium for Testing, against a scratch reader daemon on the first free port in
7470–7479 with a temp cache and state db. It generates a 14-page PDF with an outline, an
internal link, an external link and URL/DOI text (reportlab through `uv`), opens it in the
reader through `/read?path=`, and, when native pdf2htmlEX is installed, converts a copy with
`scripts/lib/pipeline.sh` and runs the same checks on its `.light.html`. Vimium gets the
exclusion rule from `docs/keybindings.md` ("Vimium setup") through
`chrome.storage.sync.exclusionRules`; the run confirms it is active, and that `?` reaches
Vimium on an origin the rule does not match.

Keys are trusted CDP key events, so they pass through Vimium's handlers as typed keys do.
The checks cover `j k d u` steps at fit zoom and at zoom 2, `gg` / `G`, link hints for PDF
links, outline entries and overlay buttons (including both jumps), visual and caret mode
with `y` (the headless clipboard is separate from the macOS pasteboard), the overlay keys
and Esc chain, sidebar scroll scoping and page console errors. A string check, with no
browser, shows that a rule containing `<c-f>` would pass plain `f` to the page, which is
why the documented rule leaves `<c-f>` out. A full run takes about 90 s (`--engine reader`
about 40 s) and opens no window (`PDFV_HEADED=1` shows it).

Two known limitations are NOTE lines and do not affect the exit status. Vimium's `ma` /
`'a` marks store the window's scroll position, which is always 0 because the viewer scrolls
`#page-container`; `:mark` / `:jump` is the supported path. On the pdf2htmlEX engine only,
the internal and external PDF link elements are not hit-testable, so the script notes that
they receive no hint; on the reader engine those two stay real checks.

Exit status 0 means no regression: every check passed. A FAIL line is a regression. The
script does not prove Comet, the owner's real Vimium settings, held-key scrolling speed,
the browser's own Cmd-F find bar or a sign-in host. It has no baseline file. If the same
check fails on both engines, the problem predates the reader.

## Pick the right proof

Use the smallest proof that exercises the changed behavior:

- **Overlay UI / keyboard work**: open a real converted PDF through
  `localhost:7435`, perform the key sequence or pointer action, and confirm the
  visible state with Browser/Playwright screenshot or DOM snapshot.
- **Overlay behavior (any `assets/overlay*` change)**: run
  `scripts/verify-overlay.sh --both`, or a disposable cached document with an
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
- **Extension redirect behavior**: run `scripts/verify-extension.sh`, which
  loads a patched copy of the extension in Chromium against a scratch daemon,
  cache and web origin (open PDF, sign-in-gated PDF, `file://`, disabled
  entries). Then verify in Comet with the unpacked extension loaded: the
  script cannot prove the real profile, Vimium or a real sign-in host.
- **Reader (`daemon/reader.py`, `daemon/pdfium_doc.py`, reader overlay
  modules)**: `uv run --directory daemon python -m unittest discover -s tests`,
  then `uv run bench/reader/run.py --tier t1 --out <json>` and
  `python3 bench/reader/compare.py <json>` against a daemon started with
  `PDF_VIEWER_ENGINE=reader` on a spare port. A change may not lower find
  recall, copy similarity or highlight IoU, or add a failure class.
- **Memory/performance work**: define the measurement first, run it before and
  after on the same document, and record the numbers in the bead comment.
- **LLM context work**: verify in Comet's LLM sidebar with the exact prompt or
  interaction used. Record what the sidebar could and could not access.
- **Docs-only work**: verify links, command accuracy, `git diff --check`, and
  `br sync --status`.

### Scorecard isolation caveat

The current `bench/reader/run.py` hardcodes both `CACHE` (the owner's cache)
and `SCRATCH` (`/tmp/pdfv-bench`). A custom `--base` does not change those
paths: cache-skip/cleanup counts are unreliable for a scratch daemon, and
concurrent scorecard runs can delete each other's work files. Serialize runs
and use separate scratch directories when investigating failures. Do not
interpret a `bench-error` from a missing work file as a viewer regression.

Known scorecard finding (2026-11-10): on documents `8567362c2276` and
`8abe6308619d`, the unmodified driver can report loaded/decoded rasters with
zero image bounds and blank screenshots (`raster-no-box`, `blank-page`,
`visual-diff-high`). A diagnostic delay after hiding benchmark chrome cleared the first document,
while disabling content visibility in screenshot CSS cleared the second; neither
intervention cleared both. Layout/paint readiness remains an unresolved known
finding. Keep the original failures visible rather than relaxing the scorecard. Text/copy/find remain intact.

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

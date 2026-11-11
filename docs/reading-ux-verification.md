# Reading UX implementation verification

Implemented on the implementation worktree branch `t3/reading-ux-pins-outline-hints`,
from base `bc4c517`. No push or owner-daemon changes.

## Result and decisions

Persistent numbered return pins expose `core.pins` to command/quick-open consumers:
`list()`, `drop()`, `jump(n)`, `remove(n)`, `onChange(fn)`. Pin records contain
`number`, `page`, normalized `x`/`y`, `title`, `section`, and creation `ts`.
The composition root alone calls `mount()`.

Ctrl-Shift-P drops; Ctrl-Shift-O returns to the newest remaining pin. Both reached
the page under real Vimium 2.4.2 without changing the pass-key rule. Commands are
`:pin`, `:pin N`, `:unpin N`, `:pins`. The previous cursor-centering command is
`:cursorpin`. Numbers reuse the lowest free slot without renumbering existing
pins. Long titles truncate in the sidebar and remain available in the tooltip.
Nearby margin markers stack vertically to remain individually hintable; markers
hide when their page margin is outside the viewport rather than covering text.

Outline h/l and left/right now act on branches. Ctrl-left/right cycles all three
tabs. The current entry's ancestors open automatically. Deep children start
collapsed; disclosure choices persist in document state. The counter shows the
root chapter and exposes the deeper section on hover. Counter, Help close and
Settings close are buttons with actions.

## Verification commands and results

All browsers were headless, used generated documents and disposable profiles,
and all scratch daemons used port 7448 and isolated cache/state directories.

```
uv run --directory daemon python -m unittest discover -s tests
# 211 tests, OK, one skipped; ResourceWarnings in existing tests.

PDFV_PORT=7448 scripts/verify-vimium.sh --engine reader
# PASS all 73 checks; real Vimium 2.4.2, trusted keys and f-hint activation.

git show bc4c517:assets/overlay-sidebar.js > /tmp/pdfv-sidebar-baseline.js
mkdir -p /tmp/pdfv-reading-shots
PDFV_PORT=7448 PDFV_SCREENSHOTS=/tmp/pdfv-reading-shots \
  PDFV_BASELINE_SIDEBAR=/tmp/pdfv-sidebar-baseline.js \
  scripts/verify-overlay.sh
# PASS 97/97 checks.

PDFV_PORT=7448 PDFV_SCREENSHOTS=/tmp/pdfv-reading-shots \
  scripts/verify-overlay.sh --only pins
# PASS 10/10; retakes Pins/empty screenshots at the pin location.

git diff --check
# clean
```

The overlay checks include exact anchor return, one undo entry, selected text
as title, keyboard overview, removal/empty state, daemon restoration after
clearing localStorage, branch keyboard/pointer behavior, collapse persistence,
current branch opening and top-level chapter/hover. The added daemon test checks
pin inheritance with clamped page, unchanged number/anchor/title, and preservation
of existing target state. Existing marks checks still pass.

The same synthetic 2,000-entry tree measured a median of 0.20 ms before versus
0.00 ms reported after for ten Ctrl-J dispatches with a forced outline layout.
The latter is below the browser timer's reporting precision, not a claim of zero
cost. Disclosure DOM updates took 0.10 ms; current tree loading through mounted
sidebar took 1,685 ms including fixture navigation, daemon/raster work and waits.
Host load averages during the final run varied from approximately 96/153/106 to
62/134/101; these are local smoke measurements under substantial shared load,
not isolated performance guarantees. Row highlighting updates only old/current
rows; visible entries are cached until branch visibility changes.

Screenshots outside the repository: `/tmp/pdfv-reading-shots/pins.png`,
`pins-empty.png`, `outline-collapsed.png`, `outline-expanded.png`, `pin-marker.png`.
Reviewed as contact sheets and with a sidebar crop: row alignment, ellipsis,
thumbnail size, empty-state instructions and margin placement are coherent.

## Boundaries, caveats and handoff

Minimal supporting changes outside the named implementation files:

- `assets/overlay-state.js`: codecs for pins and outline state, through the shared daemon mechanism.
- `assets/overlay-prefs.js`: remember the third sidebar tab.
- `assets/overlay-settings.js`: close button and corrected cursorpin command hint.
- `daemon/tests/test_state.py`: rewritten-file pin inheritance regression.
- `scripts/lib/overlay-scratch.sh`: use SO_REUSEADDR in the port availability probe,
  matching uvicorn and allowing repeated runs on 7448 while a previous socket is
  in TIME_WAIT. An active listener still fails the bind.

Within `overlay-commands.js`, only the command table and cheatsheet changed;
no finder implementation changes. The existing pin command was necessarily
renamed to avoid two meanings for `:pin`.

The owner's real Chrome profile and physical keys were not tested.
OCR notices and current toasts are passive status messages with no actions;
they intentionally do not produce hints. Existing harness coverage proves hints
for native PDF links and activation of internal destinations; external navigation
continues to use native anchors. Pins use whole-list last-writer-wins across
simultaneously editing tabs; no cross-document pin management is included.

Raster/zoom-agent handoff: in the synthetic reader fixture, drop a pin on page 1,
jump to page 8, return to the pin, undo to page 8, then open Pins. In screenshots,
the page body sometimes stayed white while the sidebar and thumbnail were
rendered (including after an 800 ms wait). Returning to page 1 rendered correctly.
No raster/zoom implementation was changed here; this remains an observed rendering
risk rather than a resolved defect. Pins screenshots were retaken at the pin
location. Earlier harness failures were corrected test assumptions (old keys,
missing probe after reload, hidden selector, range-control focus), and a stale
extension URL-count assertion; final passing commands are above.

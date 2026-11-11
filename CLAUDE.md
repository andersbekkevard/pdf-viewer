# PDF viewer instructions

Read [README.md](README.md) for the daemon, cache, overlay and extension boundaries.
The product is PDFs as HTML for keyboard-native Vimium use. The reader (`daemon/reader.py`,
ADR 0014) builds pages from the PDF on demand with PDFium; all PDFium calls stay in
`daemon/pdfium_doc.py` and run in worker processes. Nothing is converted ahead of time: the
pdf2htmlEX engine is retired (ADR 0015), and no code may read the converted HTML that older
cache entries still contain.

## Route before changing

- Overlay controls or keys: `docs/keybindings.md`; check Vimium conflicts before adding a binding.
- Reader (PDFium rasters, transparent text, on-demand opening, page DOM): `docs/reader.md` and
  ADR 0014.
- Cache identity, entries or routing: `docs/cache.md`.
- Multi-step work and tracking: `docs/ai-production.md` and the installed `beads` skill.
- Verification or closeout: `docs/verification.md`; choose proof for the affected surface.
- Scope or architectural rationale: `docs/non-goals.md` and the relevant current ADR.

`assets/overlay.js` composes the concept modules in `assets/overlay-*.js` through explicit
capabilities. Preferences go through `overlay-prefs.js`, page geometry and the raster lifecycle
through `overlay-document.js`, jumps and the current page through `overlay-navigation.js`; no
`window.__*` bridges. The daemon serves `assets/` live from the repo. Use the owning module;
there is no bundler or build step. Raycast wrappers stay trivial forks into `scripts/`.

## Runtime constraints

Use `uv` for Python projects, tools and scripts. Stdlib-only shell one-liners may use
`python3` to avoid startup overhead. Pin tool Python when its dependency wheels require it.
Raycast does not inherit the interactive PATH: include `~/.local/bin` and Homebrew paths
explicitly when invoking installed tools. Keep the log redirection in
`scripts/open-in-reader.sh`: Raycast silent mode surfaces stderr as macOS notifications.

The daemon binds 127.0.0.1 and documents never leave the machine. Test browsers run headless
against a scratch daemon and cache (`PDF_VIEWER_CACHE_DIR`); never drive Anders' own Chrome or
use his profile in place.

## Rendering and interaction constraints

- Keep offscreen text in layout for native Cmd-F. Use CSS `content-visibility: auto`;
  `display:none` page gating breaks full-document search.
- Unconditional `contain: layout paint style` on every page caused compositor churn (ADR 0002).
  Preserve the eligibility-driven containment and cached intrinsic size used by content visibility.
- Zoom lives on the `.pf` pages, never on the `#page-container` scroller, so scroller offsets are
  screen px and Vimium's j/d steps are exact (ADR 0012). Get page positions from the document
  model's rect geometry; a page's `offset*` values are page-local units. Don't cache offsets.
- Interactive controls must be semantic elements or carry role and tabindex so Vimium can hint them.
- Reader text is transparent and must never get a colour: highlights tint the raster (see
  `docs/reader.md`, "Rules for overlay code"). Bump `SHELL_VERSION` when reader markup changes.
- A page image never loses its `src`: a page without a raster shows the 1-pixel placeholder
  (`overlay-document.js`), or Chromium can leave the page blank after a far jump.
- Per-document position, marks and zoom go through `overlay-state.js` (daemon `state.db`), not
  straight to localStorage.
- The `pdf2html-` prefix on classes, attributes, CSS variables and preference keys is the
  overlay's own namespace and stays; renaming it would discard saved preferences.

A hard reload sees overlay edits. A daemon code change needs
`launchctl kickstart -k gui/$UID/com.anders.pdf_viewer`.

## Completion

Checks: `uv run --directory daemon python -m unittest discover -s tests`,
`scripts/verify-overlay.sh`, `scripts/verify-vimium.sh`, `scripts/verify-extension.sh`
(headless Chromium against a scratch daemon) and `bench/reader/` (scorecard against PDFium).

Use Beads for active work; `TODO.md` is legacy intake. Follow the owning verification document,
record the exact command/browser result on the bead, then close and flush it. Existing automated
checks complement real viewer proofs; they cannot prove the real Chrome with the real Vimium, or
Raycast.

## Publication boundary

Inspect the branch and working tree before editing; preserve shared work. Local verification
and Beads closeout do not authorize publication. Do not commit, push or open a PR unless Anders
asks for publication. When authorized, review the diff, stage only task files, reconcile remote
changes without reset, overwrite or implicit stash, and verify the pushed commit on the remote.

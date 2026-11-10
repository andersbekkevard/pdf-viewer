# PDF viewer instructions

Read [README.md](README.md) for the conversion, cache, daemon, overlay and extension boundaries.
The product is PDFs as HTML for keyboard-native Vimium use, from two engines. The reader
(`daemon/reader.py`, ADR 0014) builds pages from the PDF on demand with PDFium; all PDFium calls
stay in `daemon/pdfium_doc.py` and run in worker processes. pdf2htmlEX conversion is the default
and rollback path until `PDF_VIEWER_ENGINE=reader` is made the default; its conversion and
indexing remain explicit script operations.

## Route before changing

- Overlay controls or keys: `docs/keybindings.md`; check Vimium conflicts before adding a binding.
- Converted-page selectors: `docs/pdf2htmlex-dom.md`.
- Reader (PDFium rasters, transparent text, on-demand opening): `docs/reader.md` and ADR 0014.
- Cache identity, routing or injection: `docs/cache.md`.
- Multi-step work and tracking: `docs/ai-production.md` and the installed `beads` skill.
- Verification or closeout: `docs/verification.md`; choose proof for the affected surface.
- Scope or architectural rationale: `docs/non-goals.md` and the relevant current ADR.

`assets/overlay.js` composes the concept modules in `assets/overlay-*.js` through explicit
capabilities. Preferences go through `overlay-prefs.js`, page geometry through
`overlay-document.js`, jumps and the current page through `overlay-navigation.js`, and every
pdf2htmlEX runtime patch lives in `overlay-pdf2htmlex.js`; no `window.__*` bridges. Conversion
steps for all scripts live in `scripts/lib/pipeline.sh`. Assets are served live through the cache symlink. Use the owning module;
there is no bundler or build step. Raycast wrappers stay trivial forks into `scripts/`.

## Runtime constraints

Use `uv` for Python projects, tools and scripts. Stdlib-only shell one-liners may use
`python3` to avoid startup overhead. Pin tool Python when its dependency wheels require it.
Raycast does not inherit the interactive PATH: include `~/.local/bin` and Homebrew paths
explicitly when invoking installed tools.

Preserve conversion-script log redirection: Raycast silent mode surfaces stderr as macOS
notifications. Conversion uses native arm64 pdf2htmlEX, with explicit data/poppler-data paths.
Its Homebrew dylib dependencies can need a rebuild after upgrades; follow README and ADR 0011.
The binary carries the text-fidelity patches in `patches/pdf2htmlEX/` (ADR 0013, `+pdfv`
version); a rebuild must apply them and pass `scripts/tests/test_text_fidelity.py`.
The retired comparison script and its separate port/cache stay untouched.

## Rendering and interaction constraints

- Disable pdf2htmlEX's own render loop on load; verify that integration after upgrades.
- Keep offscreen text in layout for native Cmd-F. Use CSS `content-visibility: auto`;
  `display:none` page gating breaks full-document search.
- Normal light routing uses paint-safe text. Visible or ambiguous `.t` lines remain byte-for-byte
  canonical; geometry/original text modes are diagnostics. Preserve canonical HTML for rollback.
- Unconditional `contain: layout paint style` on every page caused compositor churn (ADR 0002).
  Preserve the eligibility-driven containment and cached intrinsic size used by content visibility.
- Zoom lives on the `.pf` pages, never on the `#page-container` scroller, so scroller offsets are
  screen px and Vimium's j/d steps are exact (ADR 0012). Get page positions from the document
  model's rect geometry; a page's `offset*` values are page-local units. Don't cache offsets.
- Interactive controls must be semantic elements or carry role and tabindex so Vimium can hint them.
- Reader text is transparent and must never get a colour: highlights tint the raster (see
  `docs/reader.md`, "Rules for overlay code"). Bump `SHELL_VERSION` when reader markup changes.
- Per-document position, marks and zoom go through `overlay-state.js` (daemon `state.db`), not
  straight to localStorage.

Overlay cache versions hash every `assets/overlay*.js` module plus `assets/overlay.css`.
Use `uv run scripts/inject-overlay.py --print-version`; injection/cache-upgrade procedures live
in README. A hard reload sees symlink-served overlay edits without reconversion.

## Completion

Reader and extension checks: `bench/reader/` (scorecard against PDFium) and
`scripts/verify-extension.sh` (unpacked extension in Chromium against a scratch daemon).

Use Beads for active work; `TODO.md` is legacy intake. Follow the owning verification document,
record the exact command/browser result on the bead, then close and flush it. Existing automated
checks complement real viewer proofs; they cannot prove Comet, Vimium or Raycast integration.

## Publication boundary

Inspect the branch and working tree before editing; preserve shared work. Local verification
and Beads closeout do not authorize publication. Do not commit, push or open a PR unless Anders
asks for publication. When authorized, review the diff, stage only task files, reconcile remote
changes without reset, overwrite or implicit stash, and verify the pushed commit on the remote.

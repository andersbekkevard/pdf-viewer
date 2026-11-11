# ADR 0001 — pdf2htmlEX as the PDF-to-HTML rendering engine

**Status**: Superseded by [ADR 0015](0015-retire-pdf2htmlex.md) (pdf2htmlEX retired 2026-11-11)
**Date**: 2026-04-21

## Context

The entire reason `pdf_viewer` exists is that Vimium does not work inside
Chrome/Comet's native PDF viewer (see plan.md §0). The native viewer is a
sandboxed `chrome://pdf` surface that browser extensions cannot inject
scripts into. No `j/k` scroll, no `/` find, no visual mode, no marks.

For a keyboard-native workflow — which is a non-negotiable constraint
coming from the user's daily Vim/Vimium usage — the native viewer is
unusable. The only escape is to render the PDF as an **HTML document**,
because Vimium works on any HTML page.

So the question becomes: which PDF→HTML engine.

### Alternatives surveyed

| Tool | What it produces | Notes |
|---|---|---|
| **pdf2htmlEX** | Pixel-faithful HTML + embedded fonts + absolutely-positioned text spans | Visually identical to the PDF; text is selectable |
| **marker** (datalab-to/marker) | Semantic, reflowable HTML (headings, paragraphs, tables, math) | Great for reading; loses visual fidelity entirely |
| **docling** (IBM) | Similar to marker | Comparable quality, slower at scale, less reflow focus |
| **pdfminer / pdfplumber** | Raw text + structure heuristics | No HTML layout preservation; fine for data, bad for viewing |
| **MinerU / olmOCR / GOT-OCR** | ML-extracted semantic HTML/Markdown | GPU-heavy, best-of-class accuracy, overkill for casual viewing |
| **Frontier VLMs** (Gemini/Claude) | Per-page conversion via API | Best quality, per-page API cost, privacy concerns with licensed PDFs |

## Decision

Use **pdf2htmlEX** as the primary rendering engine, via the Docker image
`pdf2htmlex/pdf2htmlex:0.18.8.rc2-master-20200820-ubuntu-20.04-x86_64`
(run under `--platform linux/amd64` on our arm64 Mac).

## Rationale

**Visual fidelity matches user expectation.** When we open a textbook
PDF, we want it to look like the textbook. pdf2htmlEX embeds the original
fonts and positions each character absolutely, so the HTML is
pixel-for-pixel identical to the source PDF. This is non-negotiable for
textbook reading — figure placement, typography, and page layout all
carry meaning. Every alternative that reflows the content (marker,
docling, VLMs) breaks that identity.

**Fully local, no per-use cost.** Docker + pdf2htmlEX runs on the
laptop. No API calls, no data leaves the machine. Licensed textbook PDFs
stay private. Important because several of the target documents are
paid-for academic materials.

**Cacheable output.** The output is a static HTML bundle. Once
converted, it's a permanent artifact on disk. We can iterate on the JS/CSS
overlay without re-running the engine. This feeds directly into the
cache-centric architecture (see ADR 0004).

**Proven and stable.** pdf2htmlEX has been around for a decade, dormant
since 2020, but "dormant" here is a feature — the output format is
stable, and the Docker image we pin is immutable.

**Selectable text survives.** The text spans are real DOM `<div>`
elements with text content. That's enough for Vimium's visual/caret mode
to select, for `/` find to hit, and for copy-paste to work. Not as clean
as flowed paragraphs, but sufficient.

## Consequences

### Accepted downsides

- **Absolute-positioned spans make caret mode clunky across figures.**
  Text is in reading order only approximately; around figures the DOM
  order of spans doesn't match visual reading order. Pressing `j` in
  Vimium caret mode can jump to unexpected spots. (See ADR 0002 for
  how we mitigate with cursor pinning.)

- **amd64-only Docker image.** Runs on Apple Silicon via Rosetta
  emulation. First conversion of a 797-page textbook takes ~70 seconds.
  Acceptable because the cache makes conversion a one-time cost per
  document. If this ever becomes a real blocker, mupdf has an arm64
  native `mutool convert -F html` worth evaluating.

- **Large HTML files with embedded fonts.** A 797-page textbook → ~40MB
  HTML file. Loads fine in Chromium on modern hardware. Would be a
  problem on low-end devices, but we serve from localhost so download
  cost is nil.

- **No reflow — bad for small-screen reading.** Can't read a pdf2htmlEX
  output on a phone without aggressive zoom. For those scenarios, marker
  or docling are the right tools; they're explicitly considered
  out-of-scope for pdf_viewer (kept as parallel standalone tools).

### Consequences embraced

- The entire JS overlay (sidebar, pin, render window, cheatsheet,
  palette, page counter) exists because we're committed to the
  fixed-layout model and want the reading UX to compensate for what
  that costs. If we'd picked marker, most of the overlay wouldn't
  exist — but we'd also lose visual fidelity and gain reflow problems.

### Not a downside but worth flagging

pdf2htmlEX outputs its own runtime JS that tries to lazily render pages
on scroll. We disable it in favor of our own IntersectionObserver-based
render manager. See ADR 0002.

## Related

- plan.md §0 (problem statement — why HTML at all)
- ADR 0002 (how we manage rendering on top of pdf2htmlEX's output)
- ADR 0004 (why docker is on-demand, not always-on)
- `raycast_scripts/other/pdf2html-marker-convert.sh` — marker exists as a
  parallel tool for the "I want reflow" use case, but is not integrated
  into `pdf_viewer` and won't be unless a compelling reason appears.

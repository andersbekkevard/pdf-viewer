# ADR 0010 — Paint-Safe Light HTML With External Rasters

**Status**: Superseded by [ADR 0015](0015-retire-pdf2htmlex.md) (pdf2htmlEX retired 2026-11-11)
**Date**: 2026-05-21 (accepted 2026-07-12)

## Context

Large pdf2htmlEX books can make the browser renderer enormous. AlgDat, the
1,677-page forcing case, has about 475 MiB canonical HTML. Its renderer
footprint was 12.385 GiB in the repeatable far-find journey.

There were two independent causes:

1. pdf2htmlEX embedded every full-page raster as a base64 `data:` URL in the
   HTML, forcing the browser to parse and retain a huge document payload before
   it even decided which pages were visible.
2. The selectable text layer contains millions of glyph/spacer spans. Its
   paint role is document-specific: removing or simplifying a visible line can
   change pixels even when a page raster sits behind it.

## Decision

Keep the canonical pdf2htmlEX output as `<stem>.html`, but generate a derived
`<stem>.light.html` for normal viewing.

Production light-v1 uses root mode
`data-pdf2html-text-mode="paint-safe"` and has:

- an external raster in `page-images/0001.png`, `0002.png`, ... as the visual
  source of truth;
- the original positioned `.t` line order for native find, drag selection,
  copy, and targeting;
- simplification and `data-pdf2html-paint-safe="hidden"` marking only for a
  `.t` line proved to be hidden fallback text from conservative,
  document-local CSS visibility semantics;
- byte-for-byte preservation of every visible or ambiguous `.t` line;
- observable raster lifecycle state on `.pf`: `unloaded`, `loading`, `ready`,
  or `error`.

`scripts/externalize-page-images.py` owns producing and validating this shape.
It marks the root with `data-pdf2html-representation="light-v1"` and
`data-pdf2html-text-mode="paint-safe"`. `geometry` and `original` remain
explicit diagnostic experiments, not production routing modes.
`assets/overlay-document.js` is the small consumer interface for pages, text,
and raster lifecycle.

Normal `/view` and `/view-raw` routes prefer light-v1 and fall back to canonical
HTML. `/view-canonical` and `/view-canonical-raw` are explicit rollback routes;
direct canonical cache URLs remain valid. `mappings.tsv` still points at the
canonical file so the derived representation can always be rebuilt.

## Rationale

This keeps rollback cheap. Deleting `<stem>.light.html` or using
`/view-canonical` returns to original pdf2htmlEX behavior;
`PDF_VIEWER_ENABLE_LIGHT=0` disables new light generation; the legacy
`PDF_VIEWER_ENABLE_EXPERIMENTAL_LIGHT` flag remains honored.
`scripts/upgrade-cache.sh --mode=light` builds or rebuilds derived files from
canonical HTML without changing `mappings.tsv`.

External page rasters remove the worst HTML payload without changing visual
fidelity: the page raster is still the source of truth for what the user sees.
Lazy mounting prevents native find jumps from keeping hundreds of decoded
page PNGs alive.

The parser deliberately does not attempt a full CSS cascade. When it cannot
prove that a fallback `.t` line is hidden, it leaves that line untouched. This
keeps the raster as the idle visual source while preserving the canonical DOM
where it might still paint.

## Consequences

### Wins

- AlgDat's paint-safe light HTML is about 40 MiB, versus about 475 MiB
  canonical HTML.
- Renderer footprint in the same measurement family: canonical 12.385 GiB;
  original/conservative 10.622 GiB; geometry 3.542 GiB; paint-safe 5.153 GiB.
- Normal opens no longer parse hundreds of megabytes of embedded base64.
- Canonical and original/conservative runs froze before native find. Paint-safe
  completed six far-find advance/settle steps; real Comet native find reported
  26 hits and reached page 918, followed by line-aligned drag and copy.
- ArXiv representative pages and zoom levels had AE=0. Exact external rasters
  and all visible or ambiguous lines were preserved.

### Accepted Downsides

- Native-find highlighting may overlap slightly where fallback-font metrics
  differ, although idle pixels remain raster-faithful.
- The cache stores extracted page images next to the canonical HTML. Disk usage
  is not reduced; browser memory is.
- Paint-safe is intentionally less memory-minimal than the geometry experiment:
  preserving anything that might paint takes precedence over a smaller DOM.

## Related

- ADR 0009 — Native Cmd-F via `content-visibility: auto`
- `scripts/externalize-page-images.py`
- `assets/overlay-document.js`
- `docs/cache.md`

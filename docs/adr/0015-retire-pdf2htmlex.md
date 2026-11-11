# ADR 0015 — Retire pdf2htmlEX; the reader is the only engine

**Status**: Accepted
**Date**: 2026-11-11
**Supersedes**: [ADR 0001](0001-pdf-to-html-engine-pdf2htmlex.md),
[ADR 0010](0010-light-html-external-rasters-page-text.md),
[ADR 0011](0011-native-arm64-pdf2htmlex.md),
[ADR 0013](0013-patched-pdf2htmlex-text-fidelity.md), and the conversion half
of [ADR 0004](0004-on-demand-docker-and-daemon-split.md)

## Context

The project began by converting each PDF to HTML with pdf2htmlEX (ADR 0001)
and injecting an overlay into the result. The reader (ADR 0014) replaced
conversion with PDFium page images under transparent text, built on demand,
and became the default engine on 2026-11-11.

At that point the two engines compared as follows on the 63-document
scorecard (`bench/reader/`): the reader had no failures in any comparable
failure family; pdf2htmlEX failed on 19 documents (conversion crashes,
timeouts, refusals of copy-restricted PDFs, visual differences). A first
open took one to two minutes of conversion for a textbook under pdf2htmlEX
and under 100 ms to the first page image in the reader. Real usage showed the
cost of an explicit conversion step: over 58 days about 1,560 PDFs were
opened outside the viewer against 562 inside it, because an unconverted PDF
fell back to the browser's own viewer.

Keeping pdf2htmlEX as a rollback meant keeping a patched native toolchain
(ADR 0011, ADR 0013), nine Homebrew libraries, a conversion pipeline, light
and canonical HTML representations (ADR 0010), a runtime adapter for the
converter's JavaScript, and a second branch in the overlay, the daemon and
every check.

## Decision

Remove pdf2htmlEX and everything that exists only for it. The reader is the
only way a document is shown.

- The `PDF_VIEWER_ENGINE` switch, the `/view-light*` and `/view-canonical*`
  routes and the static mount of the whole cache directory are gone. `/view`
  and `/read` are the same route.
- The conversion, indexing, injection and cache-upgrade scripts, the patched
  toolchain's installer and patches, the Brewfile, the light-HTML checks and
  the overlay's pdf2htmlEX adapter are deleted.
- The Raycast command becomes "open in reader": it sends the active tab to
  the daemon's open route. Folder indexing is dropped, since nothing needs
  preparing before a PDF is opened.

Cache entries the conversion scripts wrote are kept as library entries:

- `mappings.tsv` is still read. A row gives an entry its source reference
  and its name (the stem of the HTML path the row records, which is where
  `:rename` kept the names of converted entries). `:rename` on such an entry
  rewrites that path in the row. The HTML file itself is never read.
- An entry opens in the reader from its stored `_source/*.pdf` or, for a
  local file, from the file at its recorded path.
- An entry with no PDF on disk but an `http(s)` source reference stays in
  the library and downloads the PDF again when opened. An entry with no PDF
  and a local path that no longer exists is left out of the library.
- The address of a converted page (`/<hash>/<name>.html`, as old tabs,
  bookmarks and history have it) redirects to the reader for that entry.

The converted HTML, fonts and page images in existing entries are no longer
used. They are left on disk; deleting them is a manual, optional cleanup.

## Consequences

- One engine to verify. The overlay, daemon and checks lose their second
  branch, and setup needs only `uv`.
- The daemon no longer serves arbitrary files under the cache directory
  (which also held `state.db`, `opens.db` and `visits.db`); the only entry
  files it serves outside `/r/` are `meta.json` and the redirect above.
- There is no rollback engine. A document the reader shows badly is opened
  in the browser's own viewer with `:disable`.
- The viewer's DOM still uses the names pdf2htmlEX introduced (`.pf`, `.pc`,
  `.t`, `#page-container`, `#outline`) and the overlay's own `pdf2html-`
  prefix for classes, attributes, CSS variables and stored preference keys.
  These are identifiers; renaming them would discard saved preferences for
  no behavioural gain.
- Earlier ADRs and benchmark notes describe the pdf2htmlEX system as it was.
  They are history and are not rewritten.

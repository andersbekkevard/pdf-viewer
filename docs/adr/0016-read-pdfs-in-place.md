# ADR 0016 — Read a PDF at its own address

**Status**: Accepted
**Date**: 2026-11-12

## Context

The extension redirected every PDF navigation to the daemon, so the tab showed
`http://localhost:7435/r/<hash>/…` instead of the PDF's URL. The address could
not be copied or shared, history and bookmarks pointed at a local hash, and
the tab no longer said where the document came from.

Chrome does not let an extension show one address while displaying another
page. The reader therefore has to be built inside the page at the PDF's URL.

## Decision

The extension leaves the tab where it is and builds the reader there
(`docs/in-place.md`):

- Header rules turn a PDF response into a plain-text page, so Chrome's viewer
  never starts and the document is in standards mode.
- A page script replaces that page with the reader shell and imports the
  overlay.
- A hidden extension frame carries every request to the daemon. The daemon
  gets no CORS headers.
- The address carries a `#page=<n>` fragment, and a second Vimium exclusion
  rule (`*#page=*`) gives the overlay its keys.

The daemon's `/r/<hash>/` pages remain as the fallback and for checks that run
without the extension.

## Alternatives rejected

- **A full-page frame of the daemon's reader inside the original page.**
  Simple, but Vimium handles frames worse (focus, scrolling, hints), and the
  frame's navigation to localhost meets Chrome's local-network permission.
- **Rewriting the response to `text/html`.** The PDF bytes parse as a
  quirks-mode document. `document.open()` gives standards mode but removes
  Vimium's listeners in that tab.
- **Letting the page call the daemon directly with CORS.** Any website could
  then read the library.
- **Serving daemon content at extension URLs from the service worker.** The
  worker's fetch handler does not see requests made by web pages.
- **Taking the overlay's keys before Vimium** (a listener registered first,
  through a fixed extension ID that sorts before Vimium's). It works in
  Vimium's normal mode and breaks link hints, visual mode, marks and
  multi-key commands, which use the same letters. Vimium's own exclusion rule
  is the only mechanism that follows its modes.

## Consequences

- The address bar, history and copied links show the PDF's real location,
  with the page being read.
- Overlay code must go through `assets/overlay-daemon.js` for requests,
  images, storage and navigation. A relative URL now goes to the PDF's site.
- One more Vimium exclusion rule is needed.
- The tab's own request reaches the PDF's host on every open. An unreachable
  host falls back to the daemon's page.
- The approach depends on Chromium behaviour that is not a documented
  contract. `scripts/verify-extension.sh` and `scripts/verify-vimium.sh`
  cover it.

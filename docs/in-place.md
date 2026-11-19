# Reading a PDF at its own address

The reader is built in the tab at the PDF's own URL or `file://` path. The
address bar shows `https://arxiv.org/pdf/2401.00001#page=3`, not a
`localhost:7435` address. ADR 0016 has the decision; this is how it works.

The daemon's own pages (`http://localhost:7435/r/<hash>/`, the library, the
home page) still exist. A document falls back to its daemon page when its own
address cannot be used, and the checks that run without the extension use it.

## What happens on an open

1. **The response becomes a plain page.** `extension/rules.json` matches a
   main-frame response typed `application/pdf` (or a `.pdf` URL typed
   `octet-stream`) that is not a download, sets its `Content-Type` to
   `text/plain`, adds `X-Content-Type-Options: nosniff` and a
   `Server-Timing: pdfv` entry, and removes the response's own restrictions on
   what the page may load (`Content-Security-Policy` and similar). Chrome then
   builds an ordinary standards-mode text document instead of starting its PDF
   viewer. For each cached URL the service worker installs the same rewrite
   whatever the response's type, so a cached document opens even when its host
   now answers with a sign-in page. Nothing is redirected.
2. **The page script takes over.** `extension/page.js` runs at
   `document_start` in every top-level page. It reads the `Server-Timing`
   entry, which is how it knows synchronously that this is a taken-over PDF,
   and returns at once on any other page. A local file needs no rule: Chrome
   starts a PDF document (`document.contentType`), and the script runs before
   the viewer is created. It replaces the page's root element with an empty
   document, calls `window.stop()` (which ends the PDF's download), and sets
   the `#page=` fragment.
3. **The bridge reaches the daemon.** A page on another site may not call
   `localhost`, and the daemon answers no cross-origin request on purpose.
   `extension/bridge.html` is a hidden extension frame that can. The page
   script talks to it over a `MessagePort`; bodies cross as Blobs.
4. **The daemon says where the reader is.** `POST /extension/locate` makes the
   same decisions as `/view-raw` and answers JSON: `{"reader": "/r/<hash>/"}`,
   `{"native": url}`, or `{"wait": id}` while a large or sign-in-gated PDF is
   still being fetched. The bridge then fetches the shell markup.
5. **The overlay runs in the page.** The page script inserts the shell's
   markup, links `overlay.css` from the extension (`extension/assets` is a
   symlink to `assets/`), connects a transport to `assets/overlay-daemon.js`
   and imports `overlay.js` into its own isolated world.

A document the daemon will not read (disabled, not a PDF after all, daemon
down) goes to the browser's viewer: the page script reloads the address with
`_pdfvw=passthrough`, which the allow rule lets through untouched and the page
script ignores.

## The overlay's side: `overlay-daemon.js`

Overlay modules never build an absolute daemon URL, read `localStorage`
directly or assign `location` to move between documents. They use the
`daemon` object: `fetch`, `storage`, `image`/`setImage`, `open`, `leave`,
`url`, `post`, `viewport`, `location`, `history`. On the daemon's origin these
are the browser's own. In place, the page script connects replacements:

| Capability | In place |
|---|---|
| `fetch` | through the bridge; returns an ordinary `Response` |
| page images | fetched through the bridge, shown as `blob:` URLs, revoked on release |
| `storage` | `chrome.storage.local` (preferences are copied once from the daemon origin's `localStorage`) |
| `open(href)` | the document's own address (`GET /extension/address/<hash>`), navigated by the service worker |
| `location.hash`, `history` | the page the address came with; the real fragment belongs to the page script |

A relative URL in overlay code would go to the PDF's site. That is a privacy
leak as well as a bug: use the `daemon` object.

## The `#page=` fragment and Vimium

For a reader at a `file://` address, Chrome must allow file access separately
for Vimium and the PDF Viewer extension. See [Vimium setup](keybindings.md#vimium-setup).

Vimium decides which keys it leaves to a page from the page's URL. In-place
pages have arbitrary URLs, so the page script keeps a `#page=<n>` fragment on
the address, the standard PDF page fragment, updated 600 ms after the page
being read changes. One Vimium exclusion rule with the pattern `*#page=*`
(`docs/keybindings.md`, "Vimium setup") then gives the same key behaviour as
the `localhost:7435` rule. An address opened with `#page=7` opens on page 7.

Vimium reads the address when its script starts, which can be before the
browser has recorded the fragment, and its later re-checks wait for
`DOMContentLoaded`, which a stopped document never fires. Once the reader is
mounted the page script moves focus into a throwaway frame and back; the
window's focus event makes Vimium read the address again.

Taking the keys in the page script instead (a listener registered before
Vimium's) was tried and rejected: Vimium's link hints, visual mode, marks and
multi-key commands use the same letters, and only Vimium knows which mode it
is in.

## Between the two addresses

- A tab that opens `/r/<hash>/` on the daemon (the library, an old link, the
  open script) is sent to the document's own address when it has one.
- When that address fails (offline, a redirect to a sign-in page), or a cached
  document's URL fails on a direct visit, the tab goes to the daemon's page
  with `_pdfvw=local`, which the page script leaves alone.
- A local file moves to its `file://` address only when the extension has
  "Allow access to file URLs".

## Security

- The daemon gains no CORS headers. Only the extension can reach it.
- `bridge.html` is web-accessible, so any site can frame it. It serves only a
  page script that registered a random token for its tab with the service
  worker over extension messaging, which a web page cannot send. It accepts
  daemon paths only, never a caller-chosen URL.
- The taken-over page runs none of the site's scripts: the response is parsed
  as text and replaced.

## Costs and limits

- The tab's own request still reaches the PDF's host on every open, and is
  stopped once the headers arrive. A cached document therefore needs the host
  to answer; the fallback above covers the case where it does not.
- A first open downloads the PDF a second time (the daemon's own download, or
  the extension's for a sign-in-gated host).
- Chrome reads `background.js` from disk when the worker restarts but keeps
  the manifest and `rules.json` it loaded. After pulling a change to
  `extension/`, reload it in `chrome://extensions`.
- Checked in headless Chromium for Testing with the real Vimium
  (`scripts/verify-extension.sh`, `scripts/verify-vimium.sh`). The header
  rewrite and the page script's ordering are Chromium behaviour, not a
  documented contract; a Chrome update can break them, and the checks are how
  that shows.

Cached response rewrites use priority 1, below the passthrough allow at 2.
Otherwise cached PDFs with the marker become plain text while page.js skips them.

Passthrough fix verification (2026-11-16): a scratch headless Chromium 1243
loaded the installed static allow rules and a cached rewrite. Priority 3 returned
text/plain; priority 1 returned application/pdf for the same marked URL.
Mac scripts/verify-extension.sh was attempted but has no cached Playwright.
Reload the unpacked extension to activate the changed service worker.

# Non-goals

Explicitly out of scope. Revisit carefully before adding any of these.

- **Auth-gated PDF fetching outside the browser** (SharePoint, paywalls,
  corporate SSO). The scripts and daemon hold no credentials and run no
  sign-in flow. A source open in a signed-in tab is fetched by the
  extension inside that browser session (`POST /signal/fetch`, see
  [reader.md](reader.md), "Sign-in-gated sources"); anything else: let the
  browser download it and open the local copy.
- **Catching PDFs served as downloads.** The extension redirects `.pdf`
  URLs and `application/pdf` responses shown inline; a PDF sent as an
  attachment download is left to the browser.
- **In-viewer annotations or notes.** Use Obsidian or Preview.
- **Real-time collaboration / multi-user.**
- **Mobile-native app.** Tailscale-to-laptop-daemon is the fallback
  (phase 8, unbuilt).
- **Public URLs.** Daemon always binds to `127.0.0.1`.
- **A second rendering engine or ahead-of-time conversion.** pdf2htmlEX is
  retired (ADR 0015); a document the reader shows badly is opened in the
  browser's own viewer with `:disable`.
- **Bulk indexing of folders.** Nothing needs preparing before a PDF is
  opened; the library holds what has been opened.
- **Browsers other than Chrome.** Comet is no longer a target.
- **Cloud OCR, OCR of born-digital pages, and writing recognized text back
  into the PDF.** Scanned pages are recognized on this Mac only (Apple
  Vision, `daemon/ocr.py`); pages that already have text, including a
  producer's invisible OCR layer, are never re-recognized, and the source
  PDF is never modified. Text drawn as vector outlines is not recognized.
- **Integrating `marker` into the daemon.** Kept as a standalone
  parallel tool until a compelling in-viewer use case appears.

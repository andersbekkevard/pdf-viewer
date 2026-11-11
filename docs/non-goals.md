# Non-goals

Explicitly out of scope. Revisit carefully before adding any of these.

- **Auth-gated PDF fetching outside the browser** (SharePoint, paywalls,
  corporate SSO). The scripts and daemon hold no credentials and run no
  sign-in flow. A source open in a signed-in tab is fetched by the
  extension inside that browser session (`POST /signal/fetch`, see
  README); anything else: let the browser download it and convert the
  local copy.
- **Smart auto-detection of PDFs without a `.pdf` extension.** The
  extension deliberately does not try to sniff Content-Type. A URL the
  daemon already knows is matched by its per-entry rule; anything else:
  open it with `/read?url=`.
- **In-viewer annotations or notes.** Use Obsidian or Preview.
- **Real-time collaboration / multi-user.**
- **Mobile-native app.** Tailscale-to-laptop-daemon is the fallback
  (phase 8, unbuilt).
- **Public URLs.** Daemon always binds to `127.0.0.1`.
- **Auto-installing the conversion toolchain.** Conversion uses a native
  arm64 pdf2htmlEX binary (ADR 0011); scripts fail fast with "native
  pdf2htmlEX not installed" rather than building or fetching it. (Docker
  is no longer involved in conversion at all.)
- **Cloud OCR, OCR of born-digital pages, and writing recognized text back
  into the PDF.** Scanned pages are recognized on this Mac only (Apple
  Vision, `daemon/ocr.py`); pages that already have text, including a
  producer's invisible OCR layer, are never re-recognized, and the source
  PDF is never modified. Text drawn as vector outlines is not recognized.
- **Integrating `marker` into the daemon.** Kept as a standalone
  parallel tool until a compelling in-viewer use case appears.

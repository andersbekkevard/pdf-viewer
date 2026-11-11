# pdf_viewer

Personal PDF viewer for a keyboard-native (Vimium) workflow. Click any PDF
link in Chrome and land in a dark, Vim-friendly HTML page instead of
Chrome's sandboxed PDF surface.

![Viewer — sidebar outline + light PDF canvas](docs/screenshots/viewer.png)

This README is the orientation doc. For deeper references:
[`docs/reader.md`](docs/reader.md) (how pages are built),
[`docs/cache.md`](docs/cache.md) (cache design),
[`docs/keybindings.md`](docs/keybindings.md) (full key + palette
registry), [`docs/adr/`](docs/adr/) (architectural decisions),
[`docs/ai-production.md`](docs/ai-production.md) (agent workflow +
Beads), [`docs/verification.md`](docs/verification.md) (verification
loops), [`CLAUDE.md`](CLAUDE.md) (constraints for agents).

## Quick start

```bash
git clone <repo> pdf_viewer && cd pdf_viewer
./scripts/setup.sh
```

`scripts/setup.sh` is the idempotent bootstrap — safe to re-run. It checks
for `uv` (and prints the install one-liner if it is missing), templates and
loads the launchd daemon job, creates the cache dir, and ends by running
[`scripts/doctor.sh`](scripts/doctor.sh) as the success gate.

Two manual steps it can't script (it prints both on success):

1. **Chrome extension** — `chrome://extensions` → enable Developer mode →
   *Load unpacked* → point at `extension/`.
2. **Raycast script directory** — Raycast → Settings → Extensions →
   Script Commands → *Add script directory* → pick `raycast/`.

(Optional, for the keyboard workflow: add the Vimium exclusion rule — see
[Externalities](#externalities) §5.)

## Why

Vimium — the vim-style keyboard navigation we rely on for everything —
**does not work inside Chrome's native PDF viewer**. The native viewer is a
sandboxed surface that browser extensions cannot reach. No `j/k`, no `/`,
no visual mode, no marks.

The workaround: show PDFs as **HTML** instead. The reader draws every page
with PDFium (the renderer Chrome's own viewer uses) and lays the PDF's text
over it as transparent, selectable HTML, so Vimium treats the document like
any other page. A JS/CSS overlay supplies the rest (dark canvas, sidebar,
palette, quick open, outline tracker, marks, pins, position restore, …).

## Design philosophy

1. **Nothing is converted.** A PDF opens as fast as its first page renders.
   The daemon builds the page shell, the text and each page image from the
   PDF on demand and caches them under `~/.cache/pdf_viewer/<hash>/`
   ([`docs/reader.md`](docs/reader.md), ADR 0014). The pdf2htmlEX
   conversion engine this project started with is retired (ADR 0015).
2. **Local daemon, documents never leave the machine.** A FastAPI daemon on
   `127.0.0.1:7435` serves everything. All PDFium calls run in worker
   processes, so a PDF that crashes PDFium cannot take the daemon down.
3. **The extension makes it frictionless.** The MV3 extension redirects PDF
   navigations (`*.pdf` URLs, `application/pdf` responses, `file://` PDFs)
   to the daemon. A PDF behind a sign-in is fetched by the extension inside
   the browser session and handed to the daemon.
4. **Overlay is the product.** `assets/overlay*.js` and `assets/overlay.css`
   are what the user actually experiences. Served live from the repo —
   edits reload on ⌘⇧R.
5. **Keyboard first.** All numeric arguments go through the `:` palette,
   not `[N]<key>` prefixes. Shortcut conflicts with Vimium are
   non-negotiable — see the "Permanently rejected" list in
   [`docs/keybindings.md`](docs/keybindings.md).

## Current state

What works end-to-end today:

- **Opening** — any PDF the extension redirects opens in the reader:
  public URLs (signed Blackboard/S3/CloudFront URLs included; the query
  string is stripped from the cache key so signed links hit the same entry
  across sessions), sign-in-gated URLs (Cloudflare Access, campus SSO;
  `docs/reader.md`, "Sign-in-gated sources") and local files, which reload
  live when the file changes on disk. A changed `extension/background.js`
  needs a reload in `chrome://extensions` before it runs.
- **FastAPI daemon** (`daemon/main.py`, uv project). Routes:
  `GET /` (home page: the library, searchable; `assets/home.*`) /
  `GET /view?path=|url=` (also `/read`) / `GET /view-raw?<url>` /
  `GET /view-file-raw?<file-url>` / `GET /r/<hash>/` (the reader shell) /
  `GET /r/<hash>/p/<page>/<width>.jpg` (page images) /
  `GET /r/<hash>/text/<k>.json` / `GET /native?hash=` /
  `GET /entry/<hash>/state` (position, marks, zoom) /
  `GET /_assets/*` / `GET /healthz` / `GET /stats` /
  `GET /stats/recent` / `GET /library` (`?view=finder`: quick-open rows).
  The full list is the docstring of `daemon/main.py`.
- **launchd autostart** — `launchd/com.anders.pdf_viewer.plist`, installed
  into `~/Library/LaunchAgents/` by `scripts/setup.sh` (see
  [Externalities](#externalities) §2). `KeepAlive=true`, respawns within a
  second if killed; brought up on login.
- **Chrome MV3 extension** (`extension/`) — static
  `declarativeNetRequest` rules redirect PDF main-frame navigations to the
  daemon. Loop-prevention via a `_pdfvw=passthrough` marker that the daemon
  appends when it sends a tab back to the original URL. The toolbar action
  toggles the current PDF between the custom viewer and the native browser
  PDF viewer; disabled entries install higher-priority allow rules instead
  of redirect rules.
- **Visit and open tracking** (`daemon/visits.py`, `daemon/opens.py`) —
  powers `/stats`, `/stats/recent`, and the frecency order of the home
  page, quick open (`⌘P`, `⌘K`) and `:open`
  ([`docs/observability.md`](docs/observability.md)).
- **Native `⌘F` full-document indexing** — `.pf` carries
  `content-visibility: auto` so off-viewport pages skip paint+layout
  but their text stays in the layout tree, where Chromium's native
  find indexes it. See ADR 0009. Overlay `/` search remains visible-page
  scoped.
- **Scanned pages** — text is recognized on the device with Apple Vision
  (`daemon/ocr.py`) and becomes selectable and findable like any other.

What's not built: cross-device access over Tailscale (optional).

## Workflow

- **Any PDF, anywhere on the web or on disk** — click the link, land in the
  viewer. No thought.
- **Bad rendering / want native for this doc** — run `:disable` (alias
  `:native`) in the viewer. The daemon records that cache hash as disabled
  and opens the native PDF route without deleting the cache entry. Click the
  extension toolbar button while the PDF is native to re-enable the custom
  viewer for that same document.
- **A tab the extension left in the native viewer** — run the Raycast
  command "PDF viewer: open in reader" (`scripts/open-in-reader.sh`).
- **Going back to a document** — `⌘P` in the viewer, or the home page at
  `http://localhost:7435/`.

## Components

```
pdf_viewer/
├── assets/overlay.js            # composition root: wires the overlay-*.js concept modules
├── assets/overlay-*.js          # prefs, document model, zoom, navigation, sidebar, search,
│                                # scrolloff, commands, quick open, pins, settings, finger, …
├── assets/overlay.css           # the overlay styles
├── assets/home.*                # the library home page
├── scripts/
│   ├── open-in-reader.sh        # send the active Chrome tab's PDF to the reader
│   ├── setup.sh, doctor.sh      # bootstrap and read-only diagnosis
│   ├── verify-*.sh              # headless browser checks (docs/verification.md)
│   └── open-stats.py            # what was opened, how, and how fast
├── raycast/                     # Raycast-format wrapper (point Raycast here)
│   └── pdf-viewer-convert.sh    # "PDF viewer: open in reader"
├── daemon/                      # FastAPI service (uv project)
│   ├── main.py                  # thin HTTP adapter + extension signals
│   ├── reader.py                # reader shell + raster cache (PDFium worker pool)
│   ├── pdfium_doc.py            # every PDFium call: text, links, outline, rendering
│   ├── ocr.py                   # on-device text recognition for scanned pages
│   ├── sources.py               # downloading a remote PDF
│   ├── state.py                 # per-document position, marks and zoom
│   ├── catalog.py               # cache identity, discovery, and safe mutations
│   ├── opens.py, visits.py      # open log and visit counts
│   └── tests/
├── extension/                   # Chrome MV3 redirect extension
│   ├── manifest.json
│   ├── rules.json               # static redirects (*.pdf URLs, application/pdf responses) + passthrough allow
│   └── background.js            # per-entry dynamic rules, daemon signals, sign-in fetches, toolbar toggle
├── bench/                       # reader scorecard, performance and history-replay benchmarks
├── launchd/                     # LaunchAgent plist
├── docs/
│   ├── adr/                     # immutable architectural decisions
│   ├── ai-production.md         # agent workflow + Beads task protocol
│   ├── cache.md                 # cache design: layout, hash keys, URL norm
│   ├── keybindings.md           # full key + palette registry
│   ├── non-goals.md             # explicit scope boundaries
│   ├── reader.md                # the reader: routes, DOM contract, text model
│   └── verification.md          # browser/daemon/manual verification loops
└── CLAUDE.md                    # guidance for agent sessions
```

## Externalities

Everything the repo **does not** contain but depends on. All of it is
wired once and then forgotten. The only tool to install is `uv`; the
daemon's Python dependencies (PDFium through `pypdfium2`, FastAPI) come
from `daemon/pyproject.toml`.

### 1. Raycast wrapper (`raycast/`)

The folder contains *only* Raycast-format scripts so it can be added
directly as a script directory (Raycast → Settings → Extensions →
Script Commands → *Add script directory* → pick `pdf_viewer/raycast/`).
The wrapper is deliberately **trivial**: a `nohup` fork into
`scripts/open-in-reader.sh`, then `echo` a HUD line and exit, with all
output redirected to the log (Raycast's silent mode shows stderr as a
macOS notification). The wrapper file keeps the name
`pdf-viewer-convert.sh` so the hotkey bound to it in Raycast survives.

### 2. LaunchAgent (`~/Library/LaunchAgents/com.anders.pdf_viewer.plist`)

Generated into `LaunchAgents/` by `scripts/setup.sh`, which templates
`launchd/com.anders.pdf_viewer.plist` (the repo copy hardcodes absolute
paths) with the live `$HOME` and repo dir before loading it. Re-running
setup only reloads the job if the templated content changed, so a
healthy daemon is left untouched. User-level agent, no sudo.
`RunAtLoad=true`, `KeepAlive=true`, `ThrottleInterval=5`.
Install/uninstall commands live as comments at the top of the plist.

### 3. Chrome extension (loaded from `extension/`)

Not published to a store. Install manually: `chrome://extensions` →
enable Developer mode → *Load unpacked* → point at
`pdf_viewer/extension/`. Enable "Allow access to file URLs" in its
details page so local PDFs open in the reader. An edit to the extension
takes effect only after hitting its reload button.

### 4. Runtime cache (`~/.cache/pdf_viewer/`)

Not checked into the repo. Bootstrapped on first run. Full design in
[`docs/cache.md`](docs/cache.md). Everything derived (page images, text,
shells) is rebuilt on the next open; what is not rebuilt is the stored
copy of a downloaded PDF, the library's names, and the reading state in
`state.db`.

### 5. Vimium exclusion rule

In Vimium's options, add an exclusion rule with the pattern `https?://localhost:7435/*` and the
keys `? s / n N h l e q E c C 0 1 2 3 4 5 6 7 8 9`, otherwise Vimium swallows them before the
overlay's handlers see them. Do not add `<c-f>`: it disables `f` link hints
([`docs/keybindings.md`](docs/keybindings.md), "Vimium setup").

### Network

Port `7435`, bound to `127.0.0.1`.

## Shortcuts (inside the viewer)

| Key      | Action                                       |
|----------|----------------------------------------------|
| `⌘.` / `⌘B` | Toggle sidebar                            |
| `Ctrl-j` / `Ctrl-k` · `↓` / `↑` | Sidebar selector up/down; `Enter` jumps |
| `Ctrl-f` | Finger visible URL / DOI / ISBN / long-ID tokens |
| `/` / `s` | Find in visible pages                       |
| `e` / `q` / `E` | Next / prev page; active text selection extends pagewise |
| `→` / `←` · `↓` / `↑` | Next / prev page · scroll (sidebar closed) |
| `c` / `C` | Next / prev chapter                        |
| `⌘+` / `⌘−` / `⌘0` | Zoom in / out / fit-width        |
| `⌘⇧.`    | Toggle page counter                          |
| `:`      | Open command palette                         |
| `⌘O`     | Quick open: sections or pages of this document |
| `⌘P`     | Quick open: documents (`⌘P` `Enter` = previous document) |
| `⌘K`     | Quick open: sections, documents and commands |
| `⌘,`     | Settings                                     |
| `?`      | Cheatsheet (needs Vimium `?` disabled on `localhost:7435`) |
| `Esc`    | Close the topmost overlay, then the sidebar, then clear selection |

Palette: `:42`, `:p 42`, `:chapter <name>`, `:next` / `:prev`,
`:mark <a-z>`, `:jump <a-z>`, `:clear <a-z>`, `:open <doc>` / `:o`,
`:rename <name>`, `:path`, `:print`, `:disable`, `:delete confirm`,
`:pin`, `:scrolloff 25` / `:so 25`, `:case`, `:zoom N | auto`,
`:yank <ref|page|chapter|document>` / `:y`, `:finger` / `:f`,
`:counter` / `:num`, `:set`, `:help` / `:h`.

Full key + palette registry (including the Vimium-reserved keys we
deliberately *don't* bind): [`docs/keybindings.md`](docs/keybindings.md).

## Screenshots

<table>
<tr>
<td width="50%"><img src="docs/screenshots/cheatsheet.png" alt="Cheatsheet"><br><sub><b>Cheatsheet (<code>?</code>)</b> — all keybindings + palette commands.</sub></td>
<td width="50%"><img src="docs/screenshots/find.png" alt="Find in visible pages"><br><sub><b>Find (<code>/</code>)</b> — search within rendered pages, <code>Enter</code> to jump, <code>n/N</code> to cycle. Page counter pill visible top-center.</sub></td>
</tr>
<tr>
<td width="50%"><img src="docs/screenshots/settings.png" alt="Settings"><br><sub><b>Settings (<code>:set</code>)</b> — theme, zoom, render buffer, scrolloff, cursor pin.</sub></td>
<td width="50%"><img src="docs/screenshots/pages.png" alt="Pages panel"><br><sub><b>Pages panel</b> — thumbnail grid in the sidebar (toggle Outline / Pages tabs).</sub></td>
</tr>
</table>

## Testing

Run the relevant automated checks and surface proof in
[`docs/verification.md`](docs/verification.md): the daemon unit tests, the
headless overlay, Vimium and extension checks (`scripts/verify-*.sh`), and
the reader scorecard (`bench/reader/`). The real Chrome with the real
Vimium, and Raycast, still need a manual look. `scripts/doctor.sh` gives a
read-only diagnosis of the daemon, the launchd job and the cache dir.

**Overlay-only changes** (most common): edit `assets/overlay*.js` or
`assets/overlay.css`, then ⌘⇧R in an open viewer tab. The daemon serves
`/_assets/*` from the repo with revalidation on every load.

**Reader markup changes**: bump `SHELL_VERSION` in `daemon/reader.py`, so
cached shells are rebuilt, and restart the daemon
(`launchctl kickstart -k gui/$UID/com.anders.pdf_viewer`).

## Further reading

- [`CLAUDE.md`](CLAUDE.md) — constraints and routing for agent sessions
- [`docs/reader.md`](docs/reader.md) — the reader
- [`docs/cache.md`](docs/cache.md) — cache layout, hash keys, URL
  normalization, failure modes
- [`docs/ai-production.md`](docs/ai-production.md) — documentation
  ownership and Beads workflow for agent-driven work
- [`docs/verification.md`](docs/verification.md) — browser, daemon, and
  manual verification loops for closing beads
- [`docs/pins.md`](docs/pins.md) — pins
- [`docs/keybindings.md`](docs/keybindings.md) — full key + palette
  registry including Vimium conflicts
- [`docs/observability.md`](docs/observability.md) — the open log
- [`docs/non-goals.md`](docs/non-goals.md) — explicit scope boundaries
- [`docs/adr/`](docs/adr/) — architectural decisions 0001–0015; the
  index with each one's status is [`docs/adr/README.md`](docs/adr/README.md)

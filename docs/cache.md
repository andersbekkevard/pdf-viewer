# Cache design

`~/.cache/pdf_viewer/` holds the library (which documents exist, under which
names, from which sources), the stored copies of downloaded PDFs, the reading
state, and everything the reader derives from a PDF. This doc captures the
decisions behind it that aren't obvious from reading the code.

`PDF_VIEWER_CACHE_DIR` points a scratch daemon at another directory; the
checks use it so they never touch the real cache.

## Catalog interface

`daemon/catalog.py::CacheCatalog` is the single owner of the cache's
filesystem semantics. Its interface resolves a local path or remote URL,
exposes extension and library entries, reconstructs native sources, and
performs rename, disable, and delete mutations. `daemon/main.py` is the HTTP
adapter at this seam: it validates route-specific input, translates catalog
errors into HTTP responses, records visits, and emits extension signals.

Callers must not reproduce `mappings.tsv`, `entry.json`, `disabled.json` or
safe-mutation rules. Configure a `CacheCatalog` with a cache root instead;
temporary-directory tests in `daemon/tests/test_catalog*.py` exercise the
interface without launching FastAPI or a browser.

## Layout

```
~/.cache/pdf_viewer/
├── log                  events from scripts/open-in-reader.sh
├── daemon.log           the daemon's own log
├── mappings.tsv         entries written by the retired conversion scripts (see below)
├── disabled.json        per-hash custom-viewer disable list
├── _gated_hosts.json    hosts whose PDFs need the browser's session (docs/reader.md)
├── visits.db            SQLite event log (hash, ts, kind) — see below
├── opens.db             one row per open attempt (docs/observability.md)
├── state.db             per-document viewer state (position, marks, zoom) — see below
├── <hash>/              one dir per unique document
│   ├── _source/         the PDF: a download (remote) or a snapshot (local file)
│   ├── entry.json       name and source of the entry
│   ├── meta.json        title, author, page count, file size (written from PDFium)
│   └── reader/          derived reader artifacts, safe to delete (docs/reader.md)
│       ├── shell.html   page frames, text lines, links, outline (once all text exists)
│       ├── text/<k>.json   text and link markup of pages 32k+1…32k+32
│       └── px/<width>/<page>.{jpg,png}   rasters by device width, size-limited
└── ...
```

The daemon serves `/_assets/*` straight from the repo's `assets/` directory
and, from an entry directory, only `meta.json` and the reader's own routes
under `/r/<hash>/`. Nothing else in the cache is reachable over HTTP.

## Entries

An entry's identity is `<hash>/entry.json`, `{"name": ..., "source_ref": ...}`
(plus `source_refs`, `local_stamps` for local files), written by
`CacheCatalog.register` when a PDF is first opened. The daemon is the only
writer.

### Entries from the retired conversion engine

Until 2026-11-11 documents were converted to HTML by pdf2htmlEX
([ADR 0015](adr/0015-retire-pdf2htmlex.md)). The conversion scripts recorded
each entry as a `mappings.tsv` row: `timestamp<TAB>source<TAB>hash<TAB>html-path`.
Those rows are still read, so the documents stay in the library:

- `mappings()` returns the TSV rows plus every manifest, and a TSV row wins
  for a hash that has both. A row's name is the stem of its `html-path`,
  which is where `:rename` kept the names of converted entries; `:rename`
  on such an entry rewrites that path in the row. The HTML file is never
  read and need not exist.
- The entry opens in the reader from `_source/*.pdf` or, for a local file,
  from the file at the recorded path. With neither on disk, an entry whose
  source is an `http(s)` URL stays listed and downloads the PDF again when
  opened (`/read?url=…`); one whose local file is gone is left out.
- `/<hash>/<name>.html`, the address old tabs, bookmarks and history hold,
  redirects to `/r/<hash>/`.

The converted files in those directories (`*.html`, `*.light.html`,
`page-images/`, `page-fonts/`, `thumbs/`, fonts and scripts) are unused and
can be deleted; nothing reads them. Keep `_source/`, `entry.json` and
`meta.json`.

## Hash keys

Two different algorithms, picked deliberately:

- **Local PDF**: `sha256(file bytes)[:16]`, the content hash
  (`_content_hash` in `daemon/catalog.py`). Moving or renaming a file keeps its cache entry,
  and the same book under two filenames is one entry. The daemon first
  looks the path up among its registered entries and only hashes on a miss.
- **Remote PDF**: `sha256(host + path)[:16]`. **Query string stripped
  entirely.** This is what makes signed URLs (Blackboard, S3,
  CloudFront, Azure, GCS) hit cache across sessions — the path carries
  the stable document ID, the query string carries only ephemeral auth
  state.

## URL normalization

Stripped as ephemeral:
- All `X-Amz-*` params
- `X-Blackboard-*` params
- `X-Goog-*` params
- `Expires`, `Signature`, `response-cache-control`,
  `response-content-disposition`, `response-content-type`

Kept as cache-key basis: **host + path only**.

## Display filename (remote PDFs)

Resolution order:
1. Parse `response-content-disposition` query param (often contains the
   real filename, e.g. `filename*=UTF-8''sqlite(1).pdf`).
2. Fall back to the last path segment, append `.pdf` if missing.
3. Last resort: the hash itself.

## meta.json

`<hash>/meta.json` holds `title`, `author`, `pages`, `file_size` and the
other document-information fields PDFium reports, written by the reader the
first time an entry opens (`Reader._store_meta`). The library, quick open
and the sidebar header read it; the PDF is never opened to list the library.
Entries converted earlier may carry extra keys (`provenance`, pdfinfo
fields), which are ignored.

## Opening a document that is not stored yet

- **Remote URL** (`/view?url=`, `/view-raw?<url>`): the daemon downloads the
  source into `_source/` and redirects to `/r/<hash>/`. For a host behind a
  sign-in it holds the navigation while the extension supplies the bytes
  from the browser's session ([reader.md](reader.md), "Sign-in-gated
  sources"). `_gated_hosts.json` (`{"hosts": [...]}`, at most 500) lists the
  hosts for which that was needed, so their later opens skip the cookie-less
  download. Deleting the file only costs one cookie-less attempt per host.
  The `*-raw` routes read the entire raw query string as the remote URL so
  signed URLs with `&` parameters are not split into daemon query params.
- **Local file** (`/view?path=`, `/view-file-raw?<file-url>`): see "Local
  file revisions" below.

When neither the daemon nor the extension can get the bytes, the tab is sent
back to the original URL with the `_pdfvw=passthrough` marker and the
browser's own viewer opens it.

## Native fallback / disabled entries

`disabled.json` stores a sorted list of cache-entry hashes whose source PDFs
should bypass the custom viewer. The `:disable` / `:native` palette
command marks the current hash disabled and opens `GET /native?hash=<hash>`,
which serves the source PDF as `application/pdf` when available. For local PDFs
that streams the original file (Chromium blocks http→file redirects). For
remote PDFs it prefers the stored `_source/*.pdf`; if none exists, it
redirects to the original URL with the `_pdfvw=passthrough` marker.

The extension reads the same state from `/cache-urls`. Active entries install
redirect rules; disabled entries install higher-priority allow rules so future
clicks stay in Chrome's native PDF viewer. The daemon also honors
disabled state inside `/view*`, so stale extension rules cannot force a
disabled PDF back into the custom viewer.

## Visit tracking

`daemon/visits.py` maintains `visits.db` (SQLite, WAL mode,
`synchronous=NORMAL`). Every reader shell load inserts one row
`(hash, ts, kind)` via a FastAPI `BackgroundTask` — off the response
path, so a broken DB can never break serving. Aggregates computed at
query time; personal-use volume keeps the events table tiny for years.

Powers `/stats`, `/stats/recent`, and the frecency order of the library
(home page, quick open's `⌘P` / `⌘K`, `:open`). A session is one 15-minute
bucket with a visit; frecency is the sum over sessions of
`0.5 ** (age / 7 days)`, so a document read every few days stays above one
opened once today, and old habits fade behind recent use.

`GET /library?view=finder&current=<hash>` is the overlay's compact form: per
document the display title, author, source host, file name, pages, saved page
(from `state.db`), last read (the later of the last open and the last saved
page change) and score, with `previous: true` on the most recently read
document other than `current`. It reads `mappings.tsv` once per listing; 500
entries list in well under a second.

## Per-document state

`daemon/state.py` keeps `state.db` (SQLite, WAL; `PDFV_STATE_DB` overrides
the path): one row per `(hash, key)` for the keys `position`, `marks` and
`zoom`, holding a JSON value (under 64 KB) and an updated-at `ts` in ms.
`daemon/state_routes.py` serves it as `GET /entry/<hash>/state` and
`PUT /entry/<hash>/state/<key>` with body `{"value": ..., "ts": ms}`;
invalid input is a 400. `DELETE /entry/<hash>/state` clears a hash's rows
(test-harness reset), and deleting an entry forgets them too.

Merge rule: last writer wins by `ts`, and an older `ts` never overwrites a
newer one (a tie keeps the stored row). `marks` merges per letter by each
mark's own `ts`; clearing a mark stores a tombstone `{"deleted": true, "ts"}`
so a stale browser cannot resurrect it.

The overlay (`assets/overlay-state.js`) reads synchronously from a copy
seeded from localStorage, so first paint and resume never wait on the
network, then merges the daemon copy and pushes whatever the browser held
that was newer. That push is the migration of pre-existing localStorage
state, from either origin. A daemon position that arrives late moves the
reader only if they have not scrolled and no `#pf` deep link was followed;
a differing zoom is applied. Without the routes (an older daemon, detected
through `/openapi.json` so no 404 reaches the console) or without a daemon,
the overlay uses localStorage alone.

Why the daemon and not localStorage: localStorage is per origin and per
browser. The same document used to open on both `http://localhost:7435`
(static rule, Vimium exclusion) and `http://127.0.0.1:7435`
(the extension's dynamic redirects). The
extension now redirects to `localhost` too (`VIEWER` in
`extension/background.js`; its own fetches still use `127.0.0.1`), but only
the daemon copy is shared across browsers and profiles. Global preferences
(`overlay-prefs.js`) stay in localStorage.

## Find text

Native browser `Cmd-F` indexes the full document because `.pf` carries
`content-visibility: auto` (see ADR 0009): off-viewport pages skip paint
and layout but their text stays in the DOM. No per-document index file is
generated or fetched.

## Size

**LRU eviction of entries is deliberately not implemented.** Page rasters
under `reader/px/` are size-limited by the reader; stored PDFs are not.
Add a pruning script when cache size actually becomes a problem.

## Deletion

- **Single entry**: `:delete confirm` in the viewer (`DELETE /mapping/<hash>`),
  which removes the directory, the `mappings.tsv` row, the visits and the
  reading state.
- **Everything**: `trash ~/.cache/pdf_viewer/`. Derived data is rebuilt on
  the next open. What is lost: stored copies of downloaded PDFs (sign-in
  ones need the session again), names given with `:rename`, the library
  list, visit history and reading state.

## Memoization

The daemon memoizes content-hash lookups by `(path, mtime_ns, size)`,
so repeat requests on a 40 MB textbook re-hash exactly once per daemon
process lifetime.

## Local file revisions

Reader opens validate an immutable `_source/source.pdf` snapshot before publishing
its content hash. The local path (absolute, symlink components preserved) is
tracked in `entry.json` with `source_refs`, `local_stamps` and page count. Reopening
a changed registered path copies position, marks and zoom to newly seen content;
page numbers stay the same and clamp to the new final page. Existing target-content
state wins, preventing an unrelated source from overwriting it. Opening an unrelated
path never copies state from another path. Identical bytes still share hash state.
Both `/read?path=` and `/view-file-raw?<file-url>` use this registration path.

A superseded entry is deleted, including its rasters, text, OCR and source snapshot,
only when no other registered source refers to it. Old state rows remain available
to late writers, but are never used for an unrelated path. A moved/renamed file with
unchanged bytes shares its hash. Deleted originals leave the last valid snapshot
readable. Invalid, truncated or changing saves return 409 without replacing it.
Snapshots cost one additional copy of local PDF bytes. Stability uses size, inode,
mtime and ctime, followed by a 600 ms quiet window, EOF and PDFium parse checks in
a worker; it cannot predict a writer that pauses longer than the quiet window.
EOF is required within the final 2 KB; unusually padded PDFs may need resaving.

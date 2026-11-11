# Cache design

The cache is the load-bearing piece of `pdf_viewer`. Conversion is slow
(native arm64 pdf2htmlEX, up to ~1–2 min for a textbook; see ADR 0011);
every subsequent read is an instant disk hit. This doc captures the
decisions behind the cache — things that aren't obvious from reading the
code.

## Location

`~/.cache/pdf_viewer/` — deliberately different from the retired
hardcoded script's `~/.cache/pdf2html-serve/`, which is preserved intact
as an A/B reference and must not be touched.

## Catalog interface

`daemon/catalog.py::CacheCatalog` is the single owner of the cache's
filesystem semantics. Its interface resolves a local path or remote URL,
locates canonical or light representations, exposes extension and library
entries, reconstructs native sources, and performs rename, disable, and delete
mutations. `daemon/main.py` is the HTTP adapter at this seam: it validates
route-specific input, translates catalog errors into HTTP responses, records
visits, and emits extension signals.

Callers must not reproduce `mappings.tsv`, `disabled.json`, representation
fallback, or safe-mutation rules. Configure a `CacheCatalog` with a cache root
instead; temporary-directory tests in `daemon/tests/test_catalog.py` exercise
the interface without launching FastAPI or a browser. Conversion is
intentionally absent from the catalog and remains in the on-demand scripts,
preserving ADR 0004's accepted daemon/compute split.

## Layout

```
~/.cache/pdf_viewer/
├── _assets              → symlink to pdf_viewer/assets/ (served at /_assets/*)
├── log                  timestamped convert / download / server events
├── mappings.tsv         pdf-source ↔ hash ↔ html-path index (grep-friendly)
├── disabled.json        per-hash custom-viewer disable list
├── _gated_hosts.json    hosts whose PDFs need the browser's session (docs/reader.md)
├── visits.db            SQLite event log (hash, ts, kind) — see below
├── state.db             per-document viewer state (position, marks, zoom) — see below
├── <hash>/              one dir per unique document
│   ├── <stem>.html      canonical injected pdf2htmlEX HTML
│   ├── <stem>.light.html
│   │                    derived viewer HTML served by default when present
│   ├── page-images/     externalized full-page rasters for .light.html
│   ├── <stem>.outline.js + fonts/images/...  pdf2htmlEX output assets
│   ├── _source/         downloaded source PDF (remote) or none (local)
│   │   └── document.pdf
│   ├── entry.json       name and source of an entry opened on demand (see below)
│   ├── reader/          derived reader artifacts, safe to delete (docs/reader.md)
│   │   ├── shell.html   page frames, text lines, links, outline (once all text exists)
│   │   ├── text/<k>.json   text and link markup of pages 32k+1…32k+32
│   │   └── px/<width>/<page>.png   rasters by device width, size-limited
│   └── meta.json        pdfinfo fields + conversion provenance (see below)
└── ...
```

## Entries opened on demand

The reader opens a PDF without converting it (`/read`, or `/view*` with
`PDF_VIEWER_ENGINE=reader`). Such an entry has no `mappings.tsv` row: its
identity is `<hash>/entry.json`, `{"name": ..., "source_ref": ...}`, written
by `CacheCatalog.register`. `mappings()` returns the TSV rows plus every
manifest, and a TSV row wins for a hash that has both. `:rename` on an entry
with no converted HTML changes the manifest's name. The daemon is the only
writer of manifests; the conversion scripts keep writing `mappings.tsv`.

The daemon is no longer read-only with respect to the cache: it downloads
sources into `_source/`, writes `entry.json`, `meta.json` (when missing) and
everything under `reader/` (ADR 0014).

`_assets/` being a symlink back into the repo is what lets overlay edits
go live on ⌘⇧R without reconverting anything.

## Canonical vs paint-safe light HTML

The cache keeps the original pdf2htmlEX output as `<stem>.html`. That file is
the rollback path and the exact text-layout reference. `mappings.tsv` always
points at this canonical file.

Conversions build `<stem>.light.html` in `paint-safe` root mode by default:

- full-page raster images are extracted from base64 `data:` URLs into
  `page-images/0001.png`, `0002.png`, ...
- page `<img class="bi">` tags carry `data-pdf2html-src` and only nearby
  pages get a live `src`;
- only `.t` lines proved hidden fallback text by conservative, document-local
  CSS visibility semantics are simplified and marked
  `data-pdf2html-paint-safe="hidden"`; every visible or ambiguous `.t` line
  remains byte-for-byte canonical.

The root carries `data-pdf2html-representation="light-v1"` and
`data-pdf2html-text-mode="paint-safe"`. `geometry` and `original` are explicit
diagnostic experiments, not production representations.

The daemon's normal `/view` and `/view-raw` routes prefer the light file and
fall back to canonical HTML when it does not exist. `/view-light` remains a
compatibility alias. `/view-canonical` and `/view-canonical-raw` explicitly
select canonical HTML. `scripts/upgrade-cache.sh --mode=light` builds or
rebuilds derived artifacts from canonical HTML without changing `mappings.tsv`.
Generation is enabled by default; `PDF_VIEWER_ENABLE_LIGHT=0` disables it, and
the legacy `PDF_VIEWER_ENABLE_EXPERIMENTAL_LIGHT` flag remains honored.

## Hash keys

Two different algorithms, picked deliberately:

- **Local PDF**: `sha256(file bytes)[:16]`, the content hash
  (`content_hash` in `scripts/lib/pipeline.sh`, `_content_hash` in
  `daemon/catalog.py`). Moving or renaming a file keeps its cache entry,
  and the same book under two filenames is one entry. The daemon first
  looks the path up in `mappings.tsv` and only hashes on a miss.
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

## meta.json: pdfinfo fields + provenance

`<hash>/meta.json` carries two clearly-separated groups of keys, written by
two different owners that **merge** rather than overwrite, so either can run
first and neither clobbers the other:

- **pdfinfo-derived fields** (owner: `scripts/extract-meta.py`, driven by
  `scripts/extract-pdf-meta.sh`): `title`, `author`, `subject`, `keywords`,
  `producer`, `creator`, `pages`, `year`, `created`, `file_size`. Missing
  fields are omitted, not null. A re-run refreshes these and preserves
  everything else.
- **`provenance`** (owner: the *pipeline* — `scripts/write-provenance.py`,
  called from `pdf2html-convert.sh`, both indexers, and `upgrade-cache.sh
  --mode=reconvert`): records which converter produced the HTML.

```jsonc
{
  "pages": 1137,            // pdfinfo-derived
  "file_size": 14190884,
  "provenance": {           // pipeline-derived
    "converter": "native-arm64",   // or "docker-amd64"
    "pdf2htmlex": "0.18.8.rc2",
    "poppler": "24.06.1",          // 0.89.0 for the Docker era
    "converted_at": "2026-06-12",  // ISO date; live conversions only
    "overlay_version": "8efe6927a5", // overlay content hash at injection time
    "backfilled": true             // present only on backfilled entries
  }
}
```

Versions are parsed from the binary at convert time (`pdf2htmlEX --version`),
so reconversions after a toolchain upgrade stay accurate.

`scripts/backfill-provenance.sh` is a one-shot that stamped provenance into
every pre-existing entry using a documented date heuristic: everything cached
before **2026-06-12** is `docker-amd64` (poppler 0.89.0), with the native
2026-06-12 migration entries (hash `aa899dbceecd0cfb` plus any row timestamped
`2026-06-12` in `mappings.tsv`) marked `native-arm64`. Backfilled entries
carry `"backfilled": true` and no `converted_at`. The backfill writes only
`meta.json` and never touches HTML or any other cache file; it is idempotent
(skips entries that already have a `provenance` object).

Answer "which entries are Docker-era" in one command:

```bash
rg -l '"converter": "docker-amd64"' ~/.cache/pdf_viewer/*/meta.json
```

## Cache-miss behavior

The daemon (`daemon/main.py`, backed by `daemon/catalog.py`) never converts PDFs
or invokes Docker
(ADR 0004). Miss handling:

- `GET /view?url=<remote>` / `GET /view-light?url=<remote>` and the
  extension-only `GET /view-raw?<remote>` /
  `GET /view-light-raw?<remote>` → **307 to the original URL** on miss.
  The `*-raw` routes read the entire raw query string as the remote URL so
  signed URLs with `&` parameters are not split into daemon query params.
  Browser opens the native PDF viewer on miss (degraded but present). User
  escalates to HTML by running Raycast-convert; next visit of the same doc
  hits cache.
- `GET /view?path=<local>` → **streams PDF bytes as
  `application/pdf`**. A 307 to `file://` would work in the native
  viewer but Chromium blocks http→file redirects, so we stream
  instead.

With `PDF_VIEWER_ENGINE=reader` a remote miss is opened instead: the daemon
downloads the source into `_source/`, or, for a host behind a sign-in, holds
the navigation while the extension supplies the bytes from the browser's
session ([reader.md](reader.md), "Sign-in-gated sources"). `_gated_hosts.json`
(`{"hosts": [...]}`, at most 500) lists the hosts for which that was needed, so
their later opens skip the cookie-less download. Deleting the file only costs
one cookie-less attempt per host.

## Native fallback / disabled entries

`disabled.json` stores a sorted list of cache-entry hashes whose source PDFs
should bypass the custom HTML viewer. The `:disable` / `:native` palette
command marks the current hash disabled and opens `GET /native?hash=<hash>`,
which serves the source PDF as `application/pdf` when available. For local PDFs
that streams the original file. For remote PDFs it prefers the cached
`_source/*.pdf`; if no cached source exists, it redirects to the original URL
with the `_pdfvw=passthrough` marker.

The extension reads the same state from `/cache-urls`. Active entries install
redirect rules; disabled entries install higher-priority allow rules so future
clicks stay in Chrome/Comet's native PDF viewer. The daemon also honors
disabled state inside `/view*`, so stale extension rules cannot force a
disabled PDF back into the custom viewer.

## Visit tracking

`daemon/visits.py` maintains `visits.db` (SQLite, WAL mode,
`synchronous=NORMAL`). Every `/view` cache hit inserts one row
`(hash, ts, kind)` via a FastAPI `BackgroundTask` — off the response
path, so a broken DB can never break serving. Aggregates computed at
query time; personal-use volume keeps the events table tiny for years.

Powers `/stats`, `/stats/recent`, and the visits-sorted library picker
behind `⌘K` / `:open`.

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
(static rule, convert script, Vimium exclusion) and `http://127.0.0.1:7435`
(the extension's dynamic redirects), and in both Chrome and Comet. The
extension now redirects to `localhost` too (`VIEWER` in
`extension/background.js`; its own fetches still use `127.0.0.1`), but only
the daemon copy is shared across browsers. Global preferences
(`overlay-prefs.js`) stay in localStorage.

## Find text

Native browser `Cmd-F` indexes the full document because `.pf` carries
`content-visibility: auto` (see ADR 0009): off-viewport pages skip paint
and layout but their text stays in the DOM. No per-document index file is
generated or fetched; `text.json` files in older cache entries are
orphaned and can be deleted at leisure.

Paint-safe light HTML preserves the positioned `.t` line model and changes only
provably hidden fallback lines, so native `Cmd-F`, drag selection, and copy
remain line-aligned. Native-find highlighting may overlap slightly where
fallback-font metrics differ; idle pixels remain raster-faithful. Use
`/view-canonical` for the exact canonical text boxes.

**LRU eviction is deliberately not implemented.** Add a
`scripts/prune-cache.sh --keep N` when cache bloat actually becomes a
problem. Scary work belongs in Raycast scripts, not the daemon
(ADR 0004).

## Deletion

- **Single entry**: `trash ~/.cache/pdf_viewer/<hash>/` and remove the
  matching row from `mappings.tsv`.
- **Everything**: `trash ~/.cache/pdf_viewer/`. Lose nothing
  irreplaceable; next open re-converts.

## Memoization

The daemon memoizes content-hash lookups by `(path, mtime_ns, size)`,
so repeat requests on a 40 MB textbook re-hash exactly once per daemon
process lifetime.

## Prepared light runtime assets

The shared light-generation pipeline runs `scripts/prepare-light-runtime.py`
after raster externalization and before overlay injection. Supported embedded
font binaries become content-addressed `page-fonts/<sha256>.<extension>` files,
with unchanged font-family and format descriptors. The browser requests fonts
when their retained text is laid out. Declared page dimensions enable the
adapter's initialization before the converter's DOMContentLoaded listener.
The source canonical HTML and its visible text markup are preserved.

Regenerate an affected entry's light artifact to obtain this metadata; older
artifacts remain compatible through the converter's original initialization.

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

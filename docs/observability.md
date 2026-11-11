# Local open observability

`opens.db` lives under `PDF_VIEWER_CACHE_DIR`, beside `visits.db`. It contains
no URL, source path, filename, host, document text or raw error message.
`opens` records wall-clock seconds, entry hash when known, route, outcome,
failure class, page count, source bytes and response-header latency in ms.
SQLite uses WAL; failures to write never fail a PDF open. Existing visit
tracking remains unchanged.

The ASGI adapter in `daemon/opens.py` observes document GETs, not assets, text
ranges or raster requests. A `/read` or `/view` redirect carries an opaque
`_open` token to `/r/<hash>/`, so the redirect and shell update one attempt.
An un-followed redirect stays `pending`; it is never counted as reader success.
A direct shell request is `cached reopen`. Relay attempts have route `relay`:
`relay-ready` means source bytes were delivered, not that a shell was painted.
A later shell load establishes reader delivery. `home` and `converted` are
separate outcomes. Consequently reader share uses all recorded attempts,
including home, relay and pending rows; it is not a user-session conversion rate.

`overlay-timing.js` runs independently of overlay initialization. Image load
and root text-completion events trigger bounded beacons to
`POST /entry/<hash>/timing`. Updates replace one UUID-keyed row per page load.
First page is a loaded, visible raster followed by two animation frames; this
is a browser paint opportunity, not proof from the compositor. Text completion
is PDFium completion (`data-reader-text=complete`), independently of OCR.
Failures count image errors; after 60 seconds a missing raster or text result
counts as a timeout. Later load errors and uncaught exceptions send only
allowlisted classes. It never sends exception messages or stacks. The endpoint
limits bodies to 4 KB and validates numbers and classes. Telemetry is best-effort:
closed tabs, crashes, blocked beacons and errors before module execution can
lose measurements. Timing samples are independent page loads and are not a
one-to-one count of open attempts.

`GET /stats` retains visit fields and adds `opens` with 1, 7 and 30 day
windows, fallback classes (shares of all attempts), errors, sample counts,
nearest-rank p50/p95 first-page latency, and routes sorted by p95 shell latency.
`uv run scripts/open-stats.py [--daemon http://127.0.0.1:7445] [--json]`
prints these aggregates. No historical rows can be reconstructed before this
instrumentation is deployed. Logs from uvicorn have timestamped formatters
installed on app import, including the CLI used by launchd. No launchd restart
is necessary for tests; deploying this change needs the usual daemon restart.

See [history replay](../bench/history/README.md) for private history-based
measurement. That replay never uses browser cookies or an owner profile in place.

"""pdf_viewer daemon — read-only FastAPI service over ~/.cache/pdf_viewer/.

Routes:
    GET    /                    home page: the library, searchable (assets/home.html)
    GET    /view?path=<local>   light HTML by default, canonical/PDF fallback
    GET    /view?url=<remote>   light HTML by default, canonical/remote fallback
    GET    /view-raw?<remote>   same as /view?url=, but preserves raw query strings
    GET    /view-file-raw?<file-url>  same as /view?path=, from a raw file:// URL
    GET    /view-canonical?...  canonical HTML rollback route (also -raw)
    GET    /view-light?...      explicit light HTML, canonical fallback (also -raw)
    GET    /read?...            open any PDF in the reader, no conversion (also -raw)
    GET    /r/<hash>/           reader shell: PDFium rasters under transparent text
    GET    /r/<hash>/p/<n>/<w>.png  one page rendered at a device width
    GET    /r/<hash>/text/<k>.json  text and link markup of one range of pages
    GET    /r/<hash>/ocr?pages=1-4&wait=s  recognized text of scanned pages (ocr.py)
    GET    /native?...          the original PDF for a hash, path or url
    GET    /library             cached docs by frecency (overlay :open, ⌘K)
    GET    /cache-urls          redirect rules for the browser extension
    POST   /signal/navigate     queue a tab navigation for the extension
    GET    /signal/navigate/wait  extension long-poll for queued signals
    POST   /extension/toggle    toolbar toggle: disable/enable the current tab's PDF
    PUT    /entry/<hash>/disabled  disable or re-enable redirects for an entry
    GET    /stats               visit totals + top 20 by count (hash → name enriched)
    GET    /stats/recent        raw visit timeline, most-recent first
    GET    /_assets/*           overlay.{css,js} from the repo assets dir
    GET    /<hash>/<file>       cached pdf2htmlEX bundle (html + any sibling files)
    GET    /healthz             liveness probe
    POST   /signal/fetch        ask the extension to fetch a source PDF with browser cookies
    PUT    /fetch/<id>          extension upload of those bytes (memory only)
    GET    /fetch/<id>          convert-script collection of those bytes
    GET    /entry/<hash>/state  per-document position, marks and zoom (PUT .../state/<key>)
    DELETE /mapping/<hash>      drop the mapping row, rmtree the dir, forget visits and state
    PUT    /entry/<hash>/name   rename a cache entry's HTML file (changes search name)

The daemon never invokes Docker — conversion stays in the Raycast scripts
(ADR 0004). Cache hits are O(hash + sendfile); content-hash lookups for
local PDFs are memoized by (path, mtime_ns, size) so repeat requests on
the same file don't re-hash.

Run:
    uv run --directory daemon main.py                          # dev
    uv run --directory daemon uvicorn main:app \
        --host 127.0.0.1 --port 7435                           # prod / launchd
"""
from __future__ import annotations

import asyncio
import contextlib
import os
import pathlib
import time
import urllib.parse
from typing import Optional

from fastapi import BackgroundTasks, FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import sources
import state
import visits
from reader import Reader
from state_routes import router as state_router
from catalog import (
    CacheCatalog,
    EntryNotFound,
    InvalidCatalogInput,
    NameConflict,
    strip_passthrough,
    url_hash,
    with_passthrough,
)

# PDF_VIEWER_CACHE_DIR points a scratch daemon (scripts/verify-extension.sh)
# at a throwaway cache; production leaves it unset.
CACHE_DIR = pathlib.Path(
    os.environ.get("PDF_VIEWER_CACHE_DIR") or pathlib.Path.home() / ".cache" / "pdf_viewer"
)
REPO_DIR = pathlib.Path(__file__).resolve().parents[1]
ASSETS_DIR = REPO_DIR / "assets"
catalog = CacheCatalog(CACHE_DIR, visits)
reader = Reader(CACHE_DIR)


@contextlib.asynccontextmanager
async def _lifespan(_app: FastAPI):
    global _loop
    # Sync routes run in worker threads; they hand signal and relay work to
    # this loop, which owns the asyncio objects those use.
    _loop = asyncio.get_running_loop()
    visits.init()
    yield


_loop: Optional[asyncio.AbstractEventLoop] = None
app = FastAPI(title="pdf_viewer", version="0.1.0", lifespan=_lifespan)
# Per-document position, marks and zoom (daemon/state.py). Included before
# the static mounts at the end of this file, which catch every other path.
app.include_router(state_router)


def _prefer_reader() -> bool:
    """Whether documents open in the reader (PDFium rasters, built on demand)
    instead of pdf2htmlEX's converted HTML. PDF_VIEWER_ENGINE=pdf2htmlex is
    the rollback: converted entries then keep serving their HTML and a cache
    miss falls back to the browser's own viewer."""
    return os.environ.get("PDF_VIEWER_ENGINE", "pdf2htmlex").strip().lower() == "reader"


def _prefer_light_from_environment() -> bool:
    """Prefer light HTML unless an explicit canonical rollback is requested."""
    value = os.environ.get("PDF_VIEWER_PREFER_LIGHT", "")
    return value.strip().lower() not in {"false", "0", "no", "off"}


# -----------------------------------------------------------------------------
# Routes
# -----------------------------------------------------------------------------

@app.get("/cache-urls")
def cache_urls():
    """List every cache entry as a dict for the browser extension.

    Two kinds:
      - {"kind": "url",  "host": ..., "path": ..., "hash": ...}
        → extension matches ^https?://<host><path>(?:\\?.*)?$
      - {"kind": "file", "path": /absolute/path.pdf, "hash": ...}
        → extension matches ^file://<url-encoded path>(?:\\?.*)?$

    In both cases the rule redirects into the /view route. The path kind
    requires the extension manifest to include file:///* host permissions
    AND the user to toggle "Allow access to file URLs" per-extension.
    """
    return catalog.extension_entries()


# -----------------------------------------------------------------------------
# Navigation signals — extension-mediated tab navigation.
#
# The convert script POSTs {from_url, to_url} here when a cache-miss
# conversion finishes. The browser extension long-polls /signal/navigate/wait,
# picks up the signal, and calls chrome.tabs.update(tabId, {url}). That API
# doesn't touch focus at all, which is the whole reason we're going this
# route instead of AppleScript (Apple Events pull Chromium to the front on
# any tab mutation, causing a visible flash even with snapshot+restore).
#
# Signals have a 60s TTL. If the extension is asleep and misses the window,
# the viewer is still in cache — next click on the PDF link hits the static
# redirect rule and opens it anyway.
# -----------------------------------------------------------------------------

_NAV_SIGNAL_TTL_SEC = 60
_pending_nav_signals: list[dict] = []
_nav_signal_event: Optional[asyncio.Event] = None


def _nav_event() -> asyncio.Event:
    # Lazy-init so the event binds to the running loop (FastAPI creates one
    # per process). Accessing asyncio.Event() at import time binds to the
    # wrong loop and `.set()` becomes a no-op for awaiters.
    global _nav_signal_event
    if _nav_signal_event is None:
        _nav_signal_event = asyncio.Event()
    return _nav_signal_event


def _off_loop() -> bool:
    """True in a sync route's worker thread while the daemon's loop runs."""
    if _loop is None or _loop.is_closed():
        return False
    try:
        return asyncio.get_running_loop() is not _loop
    except RuntimeError:
        return True


def _wake_nav_waiters() -> None:
    # asyncio.Event is not thread-safe: from a sync route's worker thread the
    # wake-up is handed to the loop, or long-polls would sleep through it.
    if _off_loop():
        _loop.call_soon_threadsafe(_wake_nav_waiters)
        return
    # Set the current event and start a fresh one: every waiter holding the
    # old event wakes, and no waiter can clear it for the others.
    global _nav_signal_event
    _nav_event().set()
    _nav_signal_event = asyncio.Event()


_last_nav_signal_id = 0


def _next_nav_signal_id() -> int:
    # Microsecond timestamps, strictly increasing: a poller's cursor stays
    # meaningful across daemon restarts, and the values stay below 2**53, so
    # the extension's JavaScript numbers hold them exactly.
    global _last_nav_signal_id
    _last_nav_signal_id = max(time.time_ns() // 1000, _last_nav_signal_id + 1)
    return _last_nav_signal_id


def _purge_expired_nav_signals() -> None:
    cutoff = time.time() - _NAV_SIGNAL_TTL_SEC
    _pending_nav_signals[:] = [
        s for s in _pending_nav_signals if s["created_at"] >= cutoff
    ]


def _queue_extension_sync_signal(hash_: str, reason: str) -> None:
    _purge_expired_nav_signals()
    _pending_nav_signals.append({
        "type": "sync_rules",
        "id": _next_nav_signal_id(),
        "hash": hash_,
        "reason": reason,
        "created_at": time.time(),
    })
    _wake_nav_waiters()


class NavigateSignal(BaseModel):
    from_url: str
    to_url: str


def _queue_navigate_signal(from_url: str, to_url: str) -> None:
    _purge_expired_nav_signals()
    _pending_nav_signals.append({
        "type": "navigate",
        "id": _next_nav_signal_id(),
        "from_url": from_url,
        "to_url": to_url,
        "created_at": time.time(),
    })
    _wake_nav_waiters()


@app.post("/signal/navigate")
async def signal_navigate(sig: NavigateSignal):
    _queue_navigate_signal(sig.from_url, sig.to_url)
    return {"queued": True, "pending": len(_pending_nav_signals)}


def _public_signal(signal: dict) -> dict:
    return {k: v for k, v in signal.items() if k != "legacy_taken"}


@app.get("/signal/navigate/wait")
async def signal_navigate_wait(
    timeout: float = Query(25.0, ge=0.0, le=60.0),
    since: int | None = Query(None, ge=0),
):
    """Long-poll for signals.

    With `since` (the highest signal id the poller has seen; 0 at start), every
    unexpired signal newer than it is returned and nothing is consumed, so
    every listening browser or profile gets each signal and acts only on its
    own tabs. Without `since` (older extension builds), each signal goes to the
    first such poller only, as before, while cursor pollers still receive it.
    """
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while True:
        _purge_expired_nav_signals()
        if since is None:
            # Consumed for other cursor-less pollers only: marked, not
            # removed, so cursor pollers still receive it.
            out = [s for s in _pending_nav_signals if not s.get("legacy_taken")]
            if out:
                for s in out:
                    s["legacy_taken"] = True
                return [_public_signal(s) for s in out]
        else:
            out = [s for s in _pending_nav_signals if s["id"] > since]
            if out:
                return [_public_signal(s) for s in out]
        remaining = deadline - loop.time()
        if remaining <= 0:
            return []
        try:
            await asyncio.wait_for(_nav_event().wait(), timeout=remaining)
        except asyncio.TimeoutError:
            return []


# -----------------------------------------------------------------------------
# Browser fetch — source bytes through the browser's own session.
#
# The convert script downloads with curl, which has none of the browser's
# cookies. Auth-gated hosts (Cloudflare Access, campus SSO) answer it with an
# HTML sign-in page. On that failure the script POSTs /signal/fetch; the
# extension sees a `fetch` signal, fetches the URL with credentials (only if a
# tab in that browser has exactly that URL open), and PUTs the bytes back. The
# script collects them from GET /fetch/<id>. Results live in memory only and
# are dropped once collected or after the TTL, so the daemon still writes
# nothing to the cache.
#
# No CORS headers are sent, and FastAPI rejects non-JSON bodies on the JSON
# route, so a web page cannot start a fetch or read a result cross-origin.
# -----------------------------------------------------------------------------

_FETCH_TTL_SEC = 600
_FETCH_MAX_BYTES = 512 * 1024 * 1024
_fetches: dict[int, dict] = {}


def _purge_expired_fetches() -> None:
    cutoff = time.time() - _FETCH_TTL_SEC
    for fetch_id in [k for k, v in _fetches.items() if v["created_at"] < cutoff]:
        del _fetches[fetch_id]


class FetchSignal(BaseModel):
    url: str


def _queue_fetch_signal(url: str) -> int:
    _purge_expired_nav_signals()
    _purge_expired_fetches()
    fetch_id = _next_nav_signal_id()
    _fetches[fetch_id] = {"state": "pending", "created_at": time.time()}
    _pending_nav_signals.append({
        "type": "fetch",
        "id": fetch_id,
        "url": url,
        "created_at": time.time(),
    })
    _wake_nav_waiters()
    return fetch_id


@app.post("/signal/fetch")
async def signal_fetch(sig: FetchSignal):
    if not sig.url.startswith(("https://", "http://")):
        raise HTTPException(400, "only http(s) URLs can be fetched")
    return {"id": _queue_fetch_signal(sig.url)}


@app.put("/fetch/{fetch_id}")
async def fetch_put(fetch_id: int, request: Request):
    """Extension upload: the body is the fetched bytes, or with an
    `X-Fetch-Error` header, the reason the fetch failed. An empty PUT with
    `X-Fetch-Started` acknowledges the signal before a long download, so the
    script can tell a silent extension from a slow source."""
    _purge_expired_fetches()
    entry = _fetches.get(fetch_id)
    if entry is None:
        raise HTTPException(404, "unknown or expired fetch")
    if entry["state"] not in ("pending", "started"):
        # Another browser with the same tab open answered first.
        return {"accepted": False}
    if request.headers.get("x-fetch-started"):
        entry["state"] = "started"
        return {"accepted": True}
    error = request.headers.get("x-fetch-error")
    if error:
        entry.update(state="error", error=error[:500])
        return {"accepted": True}
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > _FETCH_MAX_BYTES:
            entry.update(state="error", error="source larger than 512 MB")
            raise HTTPException(413, "too large")
    entry.update(
        state="done",
        body=bytes(body),
        content_type=request.headers.get("x-source-content-type", ""),
        disposition=request.headers.get("x-source-content-disposition", ""),
    )
    return {"accepted": True}


@app.get("/fetch/{fetch_id}")
async def fetch_get(fetch_id: int):
    """Convert-script collection: 202 with {"state": "pending"|"started"} until
    the extension answers, then 200 with the source bytes
    (Content-Disposition passed through for filename resolution), 502 with the
    extension's error. A collected result is removed."""
    _purge_expired_fetches()
    entry = _fetches.get(fetch_id)
    if entry is None:
        raise HTTPException(404, "unknown or expired fetch")
    if entry["state"] in ("pending", "started"):
        return JSONResponse({"state": entry["state"]}, status_code=202)
    del _fetches[fetch_id]
    if entry["state"] == "error":
        return JSONResponse({"error": entry["error"]}, status_code=502)
    headers = {}
    if entry["disposition"]:
        headers["Content-Disposition"] = entry["disposition"]
    return Response(
        entry["body"],
        media_type=entry["content_type"] or "application/octet-stream",
        headers=headers,
    )


# -----------------------------------------------------------------------------
# Reader delivery relay — a sign-in-gated PDF still ends up in the reader.
#
# In reader mode a URL the daemon cannot download itself (the host answers its
# cookie-less request with a sign-in page) goes back to the browser with the
# passthrough marker, so the tab shows the native viewer at that exact URL.
# The relay then asks the extension for that tab's bytes through the fetch
# signal above, stores them as the entry's `_source/` PDF, registers the entry
# and queues a navigate signal that swaps the tab to the reader. A later click
# on the link finds the stored source and opens the reader directly.
#
# The extension fetches only a URL open in one of its tabs, so the daemon
# still stores bytes only for a URL the browser itself had open. The signal
# can reach the extension before the tab has followed the 307, and the
# extension drops a signal for good once handled, so the relay asks again with
# a fresh id while nothing has answered and gives up quietly after the bounds
# below. One relay runs per hash at a time.
# -----------------------------------------------------------------------------

# The first ask waits for the tab to follow the 307; each ask then waits this
# long for an acknowledgement before the next, about 20 s of silence in all.
_RELAY_FIRST_ASK_SEC = 0.4
_RELAY_ANSWER_WAIT_SEC = (1.0, 2.0, 3.0, 5.0, 8.0)
# Bound on the download once the extension has acknowledged.
_RELAY_DOWNLOAD_SEC = 300
_RELAY_POLL_SEC = 0.1
_relays: dict[str, asyncio.Task] = {}


def _request_relay(hash_: str, tab_url: str, source_ref: str, base_url: str) -> None:
    """Start a relay from any thread; a no-op without the daemon's loop."""
    if _loop is None or _loop.is_closed():
        return
    if _off_loop():
        _loop.call_soon_threadsafe(_start_relay, hash_, tab_url, source_ref, base_url)
    else:
        _start_relay(hash_, tab_url, source_ref, base_url)


def _start_relay(hash_: str, tab_url: str, source_ref: str, base_url: str) -> Optional[asyncio.Task]:
    current = _relays.get(hash_)
    if current is not None and not current.done():
        return None
    if catalog.is_disabled(hash_):
        return None
    task = asyncio.get_running_loop().create_task(
        _relay_source(hash_, tab_url, source_ref, base_url))
    _relays[hash_] = task

    def forget(done: asyncio.Task) -> None:
        if _relays.get(hash_) is done:
            del _relays[hash_]
    task.add_done_callback(forget)
    return task


def _store_relayed_source(hash_: str, source_ref: str, body: bytes, disposition: str) -> None:
    # A source stored meanwhile (another tab's relay, a direct download) wins.
    existing = catalog.cached_source(hash_)
    name = existing.name if existing else sources.save(
        body, source_ref, disposition, catalog.root / hash_ / "_source")
    catalog.register(hash_, source_ref, pathlib.PurePath(name).stem)


async def _relay_source(hash_: str, tab_url: str, source_ref: str, base_url: str) -> bool:
    loop = asyncio.get_running_loop()
    waits = list(_RELAY_ANSWER_WAIT_SEC)
    ids: list[int] = []
    next_ask = loop.time() + _RELAY_FIRST_ASK_SEC
    download_deadline: Optional[float] = None
    result: Optional[dict] = None
    try:
        while result is None:
            if catalog.is_disabled(hash_):
                return False
            answers = {i: _fetches[i] for i in ids if i in _fetches}
            result = next((e for e in answers.values() if e["state"] == "done"), None)
            if result is not None:
                break
            error = next((e for e in answers.values() if e["state"] == "error"), None)
            if error is not None:
                print(f"reader relay: extension could not fetch {source_ref}: {error['error']}", flush=True)
                return False
            now = loop.time()
            started = [i for i, e in answers.items() if e["state"] == "started"]
            if started:
                if download_deadline is None:
                    download_deadline = now + _RELAY_DOWNLOAD_SEC
                    # Unanswered retries would start a second download.
                    for i in ids:
                        if i not in started:
                            _fetches.pop(i, None)
                elif now >= download_deadline:
                    print(f"reader relay: download of {source_ref} timed out", flush=True)
                    return False
            elif now >= next_ask:
                if not waits:
                    print(f"reader relay: no browser tab answered for {source_ref}", flush=True)
                    return False
                ids.append(_queue_fetch_signal(tab_url))
                next_ask = now + waits.pop(0)
            await asyncio.sleep(_RELAY_POLL_SEC)
    finally:
        for i in ids:
            _fetches.pop(i, None)
    try:
        await asyncio.to_thread(_store_relayed_source, hash_, source_ref,
                                result["body"], result.get("disposition", ""))
    except (sources.SourceError, OSError, InvalidCatalogInput) as error:
        print(f"reader relay: could not store {source_ref}: {error}", flush=True)
        return False
    if catalog.is_disabled(hash_):
        return False
    _queue_navigate_signal(tab_url, f"{base_url}/r/{hash_}/")
    return True


@app.get("/healthz")
def healthz():
    entries = 0
    if CACHE_DIR.is_dir():
        entries = sum(
            1 for p in CACHE_DIR.iterdir()
            if p.is_dir() and not p.name.startswith("_")
        )
    return {
        "status": "ok",
        "cache_dir": str(CACHE_DIR),
        "cache_exists": CACHE_DIR.is_dir(),
        "entries": entries,
        # The extension installs its generic file:// rule only for the reader.
        "engine": "reader" if _prefer_reader() else "pdf2htmlex",
    }


# Three representation choices (environment preference, light, canonical),
# each reachable as `?path=`/`?url=` or as a raw query string. The routes only
# pick the representation; _view_query and _raw_url hold the shared rules.

def _view_query(path: Optional[str], url: Optional[str], background: BackgroundTasks, *,
                light: bool, reader_first: bool = False, base_url: Optional[str] = None):
    if (path is None) == (url is None):
        raise HTTPException(400, "provide exactly one of: path, url")
    if path is not None:
        return _view_path(path, background, light=light, reader_first=reader_first)
    return _view_url(url, background, light=light, reader_first=reader_first, base_url=base_url)


def _raw_url(request: Request) -> str:
    """The whole raw query string as an absolute http(s) URL.

    declarativeNetRequest regex substitutions cannot percent-encode captures,
    so the extension redirects to `/view-raw?<original-url>`; reading the raw
    query keeps signed query strings containing `&` intact.
    """
    raw_query = request.scope.get("query_string", b"")
    if not raw_query:
        raise HTTPException(400, "missing raw URL query string")
    try:
        url = raw_query.decode("ascii")
    except UnicodeDecodeError:
        raise HTTPException(400, "raw URL must be ASCII / percent-encoded")
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise HTTPException(400, "raw URL must be an absolute http(s) URL")
    return url


def _raw_file_path(request: Request) -> str:
    """The local path of a raw `file://` URL query string.

    The extension's generic file rule redirects `file://….pdf` to
    `/view-file-raw?<file-url>` for the same reason as `/view-raw`: its
    substitution cannot percent-encode the capture. Only local `.pdf` paths
    are accepted, the files that rule matches.
    """
    raw_query = request.scope.get("query_string", b"")
    if not raw_query:
        raise HTTPException(400, "missing raw file URL query string")
    try:
        url = raw_query.decode("ascii")
    except UnicodeDecodeError:
        raise HTTPException(400, "raw file URL must be ASCII / percent-encoded")
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "file" or parsed.netloc not in {"", "localhost"}:
        raise HTTPException(400, "raw URL must be a local file:// URL")
    try:
        path = urllib.parse.unquote(parsed.path, errors="strict")
    except UnicodeDecodeError:
        raise HTTPException(400, "raw file URL path is not UTF-8")
    if not path.startswith("/") or "\x00" in path or not path.lower().endswith(".pdf"):
        raise HTTPException(400, "raw file URL must name an absolute .pdf path")
    return path


@app.get("/view")
def view(
    background: BackgroundTasks,
    path: Optional[str] = Query(None, description="absolute local path"),
    url: Optional[str] = Query(None, description="http(s) URL"),
    # Injected by FastAPI from the annotation; last so direct callers can omit it.
    request: Request = None,  # type: ignore[assignment]
):
    return _view_query(path, url, background, light=_prefer_light_from_environment(),
                       reader_first=_prefer_reader(),
                       base_url=_base_url(request) if request else None)


@app.get("/read")
def read(
    background: BackgroundTasks,
    path: Optional[str] = Query(None, description="absolute local path"),
    url: Optional[str] = Query(None, description="http(s) URL"),
    # Injected by FastAPI from the annotation; last so direct callers can omit it.
    request: Request = None,  # type: ignore[assignment]
):
    """Open any PDF in the reader, converted or not: a local file is read in
    place, a remote one is downloaded once into its entry."""
    return _view_query(path, url, background, light=True, reader_first=True,
                       base_url=_base_url(request) if request else None)


@app.get("/read-raw")
def read_raw(request: Request, background: BackgroundTasks):
    return _view_url(_raw_url(request), background, light=True, reader_first=True,
                     base_url=_base_url(request))


@app.get("/view-light")
def view_light(
    background: BackgroundTasks,
    path: Optional[str] = Query(None, description="absolute local path"),
    url: Optional[str] = Query(None, description="http(s) URL"),
):
    return _view_query(path, url, background, light=True)


@app.get("/view-canonical")
def view_canonical(
    background: BackgroundTasks,
    path: Optional[str] = Query(None, description="absolute local path"),
    url: Optional[str] = Query(None, description="http(s) URL"),
):
    return _view_query(path, url, background, light=False)


@app.get("/view-raw")
def view_raw(request: Request, background: BackgroundTasks):
    """Remote URL view route for extension redirects."""
    return _view_url(_raw_url(request), background, light=_prefer_light_from_environment(),
                     reader_first=_prefer_reader(), base_url=_base_url(request))


@app.get("/view-file-raw")
def view_file_raw(request: Request, background: BackgroundTasks):
    """Local file view route for the extension's generic file:// rule."""
    return _view_path(_raw_file_path(request), background, light=_prefer_light_from_environment(),
                      reader_first=_prefer_reader())


@app.get("/view-light-raw")
def view_light_raw(request: Request, background: BackgroundTasks):
    return _view_url(_raw_url(request), background, light=True)


@app.get("/view-canonical-raw")
def view_canonical_raw(request: Request, background: BackgroundTasks):
    return _view_url(_raw_url(request), background, light=False)


def _open_local_in_reader(pdf: pathlib.Path, hash_: str):
    """Register a local PDF (no conversion) and send the tab to its reader."""
    catalog.register(hash_, str(pdf), pdf.stem)
    return RedirectResponse(f"/r/{hash_}/", status_code=307)


def _view_path(path: str, background: BackgroundTasks, *, light: bool, reader_first: bool = False):
    try:
        p = pathlib.Path(path).expanduser().resolve(strict=True)
    except FileNotFoundError:
        raise HTTPException(404, f"file not found: {path}")
    if not p.is_file():
        raise HTTPException(400, f"not a regular file: {path}")

    resolved = catalog.resolve_source(p, prefer_light=light)
    if reader_first and resolved.hash and not resolved.disabled:
        return _open_local_in_reader(p, resolved.hash)
    if resolved.representation is not None:
        if resolved.disabled:
            return FileResponse(
                p,
                media_type="application/pdf",
                filename=p.name,
                content_disposition_type="inline",
            )
        background.add_task(visits.record, resolved.hash, "path")
        return FileResponse(resolved.representation.selected, media_type="text/html; charset=utf-8")

    # Cache miss. Chromium blocks http→file: redirects, so we can't 307 to
    # file://. Stream the bytes as application/pdf — browser opens native
    # viewer. User can then run Raycast convert to escalate into HTML.
    return FileResponse(
        p,
        media_type="application/pdf",
        filename=p.name,
        content_disposition_type="inline",
    )


def _view_url(url: str, background: BackgroundTasks, *, light: bool, reader_first: bool = False,
              base_url: Optional[str] = None):
    try:
        resolved = catalog.resolve_source(url, prefer_light=light)
    except InvalidCatalogInput as error:
        raise HTTPException(400, str(error)) from error
    if reader_first and not resolved.disabled:
        if catalog.source_pdf(resolved.hash) is None:
            try:
                name = sources.download(url, CACHE_DIR / resolved.hash / "_source")
            except sources.SourceError as error:
                # No bytes (sign-in page, network): the browser's own viewer
                # opens the original URL, and the relay fetches it from that
                # tab's session to swap the tab to the reader.
                print(f"reader: download failed for {resolved.source_ref}: {error}", flush=True)
                fallback = with_passthrough(url)
                if base_url:
                    _request_relay(resolved.hash, fallback, resolved.source_ref, base_url)
                return RedirectResponse(fallback, status_code=307)
            catalog.register(resolved.hash, resolved.source_ref, pathlib.PurePath(name).stem)
        elif resolved.hash not in catalog.mappings():
            cached = catalog.source_pdf(resolved.hash)
            catalog.register(resolved.hash, resolved.source_ref, cached.stem if cached else resolved.hash)
        return RedirectResponse(f"/r/{resolved.hash}/", status_code=307)
    if resolved.representation is not None:
        if resolved.disabled:
            return RedirectResponse(
                with_passthrough(strip_passthrough(url)),
                status_code=307,
            )
        background.add_task(visits.record, resolved.hash, "url")
        return FileResponse(resolved.representation.selected, media_type="text/html; charset=utf-8")
    # Cache miss: 307 to the original URL, but tag it with a marker so the
    # browser extension's allow-rule short-circuits the redirect match —
    # otherwise clicks on .pdf links would loop (ext redirects → daemon 307s
    # → ext redirects → ...) until Chromium ERR_TOO_MANY_REDIRECTS.
    return RedirectResponse(with_passthrough(url), status_code=307)


# -----------------------------------------------------------------------------
# Reader — PDFium rasters under a transparent text layer (daemon/reader.py).
# Built on demand from the entry's source PDF; nothing is converted ahead.
# -----------------------------------------------------------------------------

def _reader_source(hash_: str) -> pathlib.Path:
    pdf = catalog.source_pdf(hash_)
    if pdf is None:
        raise HTTPException(404, f"no source PDF on disk for hash {hash_}")
    return pdf


def _saved_page(hash_: str) -> Optional[int]:
    """The reading position the daemon holds for an entry, if any."""
    try:
        page = state.get_all(hash_).get("position", {}).get("value", {}).get("page")
    except Exception:
        return None
    return page if isinstance(page, int) and page > 1 else None


@app.get("/r/{hash_}/")
def reader_shell(hash_: str, background: BackgroundTasks):
    pdf = _reader_source(hash_)
    saved = _saved_page(hash_)
    try:
        shell = reader.shell(hash_, pdf, catalog.entry_name(hash_), near_pages=(saved,) if saved else ())
    except Exception as error:
        raise HTTPException(502, f"could not read PDF: {error}") from error
    background.add_task(visits.record, hash_, "reader")
    headers = {"Cache-Control": "no-cache"}
    if isinstance(shell, str):
        # Text still loading: the overlay fetches the rest by range.
        return Response(shell, media_type="text/html; charset=utf-8", headers=headers)
    return FileResponse(shell, media_type="text/html; charset=utf-8", headers=headers)


@app.get("/r/{hash_}/text/{index}.json")
def reader_text(hash_: str, index: int, background: BackgroundTasks):
    pdf = _reader_source(hash_)
    try:
        first, pages = reader.text_range(hash_, pdf, index)
    except IndexError:
        raise HTTPException(404, f"no text range {index}")
    except Exception as error:
        raise HTTPException(502, f"could not read text range {index}: {error}") from error
    background.add_task(reader.finish_shell, hash_, pdf, catalog.entry_name(hash_))
    return JSONResponse({"first": first, "pages": pages, "ocr": [first + i for i, body in enumerate(pages) if getattr(body, "scanned", False)]}, headers={"Cache-Control": "no-cache"})


def _page_ranges(spec: str, limit: int) -> list[int]:
    """"1-4,7" → [1, 2, 3, 4, 7], clipped to 1..limit, at most 512 pages."""
    pages: list[int] = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        first, _, last = part.partition("-")
        try:
            start = int(first)
            stop = int(last) if last else start
        except ValueError:
            raise HTTPException(400, f"bad page range {part!r}")
        for page in range(max(1, start), min(limit, stop) + 1):
            pages.append(page)
            if len(pages) >= 512:
                return pages
    return pages


@app.get("/r/{hash_}/ocr")
def reader_ocr(hash_: str, pages: str = "", wait: float = 0.0):
    """Recognized text of scanned pages (daemon/ocr.py), as `.t ocr` markup.

    `pages` is a range list ("1-4,7"); `wait` (seconds, at most 30) moves
    those pages to the front of the queue and waits for them. The first call
    for a document queues all its scanned pages in the background."""
    pdf = _reader_source(hash_)
    name = catalog.entry_name(hash_)
    try:
        count = len(reader.sizes(pdf))
        return reader.ocr_status(hash_, pdf, name, _page_ranges(pages, count), max(0.0, min(30.0, wait)))
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(502, f"could not read PDF: {error}") from error


@app.get("/r/{hash_}/p/{page}/{width}.png")
def reader_raster(hash_: str, page: int, width: int):
    pdf = _reader_source(hash_)
    try:
        path = reader.raster(hash_, pdf, page, width)
    except IndexError:
        raise HTTPException(404, f"no page {page}")
    except Exception as error:
        raise HTTPException(502, f"could not render page {page}: {error}") from error
    # Keyed by content hash, page and width, so the bytes never change.
    return FileResponse(path, media_type="image/png",
                        headers={"Cache-Control": "public, max-age=31536000, immutable"})


def _require_cached_entry(hash_: str) -> str:
    """The entry's viewer path, or 400/404."""
    try:
        catalog.validate_hash(hash_)
    except InvalidCatalogInput as error:
        raise HTTPException(400, str(error)) from error
    href = catalog.viewer_href(hash_, prefer_reader=_prefer_reader())
    if href is None:
        raise HTTPException(404, f"no cached PDF viewer entry for hash {hash_}")
    return href


def _base_url(request: Request) -> str:
    return str(request.base_url).rstrip("/")


def _viewer_url_for_hash(hash_: str, request: Request) -> str:
    return f"{_base_url(request)}{urllib.parse.quote(_require_cached_entry(hash_))}"


def _file_url_for_path(path: str) -> str:
    return pathlib.Path(path).expanduser().resolve().as_uri()


def _native_browser_url_for_hash(hash_: str, request: Request) -> str:
    _require_cached_entry(hash_)
    source_ref = catalog.source_ref(hash_)
    if source_ref and source_ref.startswith("/"):
        return _file_url_for_path(source_ref)
    if source_ref and source_ref.startswith(("http://", "https://")):
        return with_passthrough(source_ref)
    return _native_url_for_hash(hash_, request)


def _native_url_for_hash(hash_: str, request: Request) -> str:
    _require_cached_entry(hash_)
    return f"{_base_url(request)}/native?hash={urllib.parse.quote(hash_)}"


def _native_response_for_hash(hash_: str):
    try:
        native = catalog.native_source(hash_)
    except InvalidCatalogInput as error:
        raise HTTPException(400, str(error)) from error
    except EntryNotFound as error:
        raise HTTPException(404, str(error)) from error
    if native.kind == "url":
        return RedirectResponse(str(native.value), status_code=307)
    path = pathlib.Path(native.value)
    return FileResponse(path, media_type="application/pdf", filename=path.name,
                        content_disposition_type="inline")


@app.get("/native")
def native_pdf(
    hash_: Optional[str] = Query(None, alias="hash"),
    path: Optional[str] = Query(None, description="absolute local path"),
    url: Optional[str] = Query(None, description="http(s) URL"),
):
    provided = [v is not None for v in (hash_, path, url)].count(True)
    if provided != 1:
        raise HTTPException(400, "provide exactly one of: hash, path, url")

    if hash_ is not None:
        return _native_response_for_hash(hash_)
    if path is not None:
        try:
            p = pathlib.Path(path).expanduser().resolve(strict=True)
        except FileNotFoundError:
            raise HTTPException(404, f"file not found: {path}")
        if not p.is_file():
            raise HTTPException(400, f"not a regular file: {path}")
        return FileResponse(
            p,
            media_type="application/pdf",
            filename=p.name,
            content_disposition_type="inline",
        )

    assert url is not None
    hash_for_url = url_hash(url)
    cached_pdf = catalog.cached_source(hash_for_url)
    if cached_pdf is not None:
        return FileResponse(
            cached_pdf,
            media_type="application/pdf",
            filename=cached_pdf.name,
            content_disposition_type="inline",
        )
    return RedirectResponse(with_passthrough(url), status_code=307)


class DisabledRequest(BaseModel):
    disabled: bool
    current_url: Optional[str] = None


@app.put("/entry/{hash_}/disabled")
def update_entry_disabled(hash_: str, body: DisabledRequest, request: Request):
    _require_cached_entry(hash_)
    disabled = catalog.set_disabled(hash_, body.disabled)
    _queue_extension_sync_signal(hash_, "entry-disabled")
    target_url = (
        _native_browser_url_for_hash(hash_, request)
        if disabled else _viewer_url_for_hash(hash_, request)
    )
    extension_navigation_queued = False
    if disabled and body.current_url:
        _queue_navigate_signal(body.current_url, target_url)
        extension_navigation_queued = True
    return {
        "hash": hash_,
        "disabled": disabled,
        "target_url": target_url,
        "native_url": _native_url_for_hash(hash_, request),
        "native_browser_url": _native_browser_url_for_hash(hash_, request),
        "viewer_url": _viewer_url_for_hash(hash_, request),
        "extension_navigation_queued": extension_navigation_queued,
    }


class ExtensionToggleRequest(BaseModel):
    url: str


@app.post("/extension/toggle")
def extension_toggle(body: ExtensionToggleRequest, request: Request):
    hash_ = catalog.hash_for_browser_url(body.url)
    if not hash_:
        raise HTTPException(404, "could not resolve current tab to a cached PDF")
    _require_cached_entry(hash_)

    disabled = catalog.set_disabled(hash_, not catalog.is_disabled(hash_))
    _queue_extension_sync_signal(hash_, "extension-toggle")
    target_url = (
        _native_browser_url_for_hash(hash_, request)
        if disabled else _viewer_url_for_hash(hash_, request)
    )
    return {
        "hash": hash_,
        "disabled": disabled,
        "target_url": target_url,
        "native_url": _native_url_for_hash(hash_, request),
        "native_browser_url": _native_browser_url_for_hash(hash_, request),
        "viewer_url": _viewer_url_for_hash(hash_, request),
    }


@app.delete("/mapping/{hash_}")
def delete_mapping(hash_: str):
    """Wipe a cache entry: drop its mappings.tsv row, rmtree the dir, forget visits.

    Returns {source_ref, removed_dir, mapping_dropped, visits_deleted} so the
    overlay can redirect back to the original URL/path. Idempotent: a missing
    dir or row is not an error — we report what we actually removed.

    Hash is anchored to ^[a-f0-9]{6,32}$ to keep rmtree inside CACHE_DIR.
    """
    was_disabled = catalog.is_disabled(hash_)
    try:
        reader.ocr_forget(hash_)
        result = catalog.delete(hash_)
    except InvalidCatalogInput as error:
        raise HTTPException(400, str(error)) from error
    except EntryNotFound as error:
        raise HTTPException(404, str(error)) from error
    result["state_deleted"] = state.forget(hash_)
    if was_disabled:
        _queue_extension_sync_signal(hash_, "mapping-delete")
    return result


class RenameRequest(BaseModel):
    name: str


@app.put("/entry/{hash_}/name")
def rename_entry(hash_: str, body: RenameRequest):
    """Rename a cache entry's HTML file so its search name (`html.stem`)
    becomes `body.name`. Updates mappings.tsv and rewrites the HTML
    `<title>` so a fresh load shows the new name in the tab.

    Hash is anchored to ^[a-f0-9]{6,32}$ so all path joins stay inside
    CACHE_DIR. 409 if another file in the entry already uses the target
    name; no-op (200 with renamed=False) when the name is unchanged.
    """
    try:
        return catalog.rename(hash_, body.name)
    except InvalidCatalogInput as error:
        raise HTTPException(400, str(error)) from error
    except EntryNotFound as error:
        raise HTTPException(404, str(error)) from error
    except NameConflict as error:
        raise HTTPException(409, str(error)) from error


@app.get("/")
def home():
    """The library as a keyboard-first start page (assets/home.{html,js,css})."""
    return FileResponse(ASSETS_DIR / "home.html", media_type="text/html; charset=utf-8",
                        headers={"Cache-Control": "no-cache"})


@app.get("/library")
def library():
    """All cached docs, sorted by zoxide-style frecency. Drives `:open`.

    palette command. Joins mappings.tsv (authoritative source ref) with
    visit-derived frecency metrics. Entries whose on-disk dir is gone are
    dropped.
    """
    return catalog.list_entries(prefer_reader=_prefer_reader())


@app.get("/stats")
def stats():
    s = visits.summary()
    mappings = catalog.mappings()
    for row in s["top"]:
        mapping = mappings.get(row["hash"])
        row["name"] = mapping.name if mapping else row["hash"]
        row["source_ref"] = mapping.source_ref if mapping else None
    return s


@app.get("/stats/recent")
def stats_recent(limit: int = Query(100, ge=1, le=1000)):
    rows = visits.recent(limit)
    mappings = catalog.mappings()
    for row in rows:
        mapping = mappings.get(row["hash"])
        row["name"] = mapping.name if mapping else row["hash"]
        row["source_ref"] = mapping.source_ref if mapping else None
    return rows


# -----------------------------------------------------------------------------
# Static mounts. Registered after routes so /view, /healthz take precedence.
# -----------------------------------------------------------------------------

# Overlay assets — repo-backed so edits to overlay*.{css,js} go live on
# refresh. StaticFiles already emits ETag + Last-Modified and honors
# If-None-Match / If-Modified-Since (304). `no-cache` makes the browser
# revalidate every load: only overlay.js and overlay.css carry the injected
# ?v= cache-buster, so the modules overlay.js imports must never be served
# from a stale cache next to a newer entry module. Revalidation is a local
# 304, so it costs nothing measurable.
class _RevalidatingStatic(StaticFiles):
    async def get_response(self, path, scope):
        resp = await super().get_response(path, scope)
        resp.headers.setdefault("Cache-Control", "no-cache")
        return resp


app.mount("/_assets", _RevalidatingStatic(directory=ASSETS_DIR), name="assets")

# The whole cache. Any /<hash>/<file> request (the URL pdf2html-convert.sh
# navigates Comet to) falls through to this mount. `html=False` prevents
# index.html auto-serve at the root.
app.mount("/", StaticFiles(directory=CACHE_DIR, html=False), name="cache")


if __name__ == "__main__":
    import argparse
    import uvicorn

    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=7435)
    parser.add_argument("--reload", action="store_true")
    args = parser.parse_args()

    uvicorn.run(
        "main:app" if args.reload else app,
        host=args.host,
        port=args.port,
        reload=args.reload,
        log_level="info",
    )

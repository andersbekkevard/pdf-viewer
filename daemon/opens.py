"""Local, content-free open attempts and page-load measurements.

ASGI instrumentation owns redirect correlation; no source identifiers are persisted.
All telemetry writes fail closed and never change delivery of a document.
"""
from __future__ import annotations
import asyncio
import functools
import contextlib
import contextvars
import json
import logging
import math
import os
from pathlib import Path
import re
import sqlite3
import time
from urllib.parse import parse_qs, urlsplit
import uuid

DB_PATH = Path(os.environ.get('PDF_VIEWER_CACHE_DIR') or Path.home()/'.cache/pdf_viewer')/'opens.db'
_HASH = re.compile(r'^[a-f0-9]{6,64}$')
_hint = contextvars.ContextVar('open_failure', default=None)

def resolved(entry):
    if _hint.get() is not None:
        _hint.get().update(hash=entry.hash, disabled=entry.disabled)
        try:
            path = Path(entry.source_ref)
            if path.is_absolute():
                _hint.get()['size'] = path.stat().st_size
        except (OSError, ValueError, TypeError):
            pass

def hint(error):
    """One-line route hook. Never retain exception text."""
    text = str(error).lower()
    code = getattr(error.__cause__, 'code', None)
    if code in (401, 403):
        value = 'needs-session'
    elif code in (404, 410):
        value = 'not-found'
    elif 'not a pdf' in text or 'not pdf' in text:
        value = 'not-a-pdf'
    elif 'sign-in' in text or 'login' in text:
        value = 'needs-session'
    else:
        value = 'download-failed'
    if _hint.get() is not None:
        _hint.get()['failure'] = value

@contextlib.contextmanager
def connect():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DB_PATH, timeout=0.25, isolation_level=None)
    try:
        db.execute('PRAGMA journal_mode=WAL')
        db.execute('PRAGMA synchronous=NORMAL')
        db.executescript('''CREATE TABLE IF NOT EXISTS opens (
          id TEXT PRIMARY KEY, ts REAL NOT NULL, hash TEXT, route TEXT NOT NULL,
          outcome TEXT NOT NULL, class TEXT, pages INTEGER, source_size INTEGER, shell_ms REAL);
          CREATE INDEX IF NOT EXISTS opens_ts ON opens(ts);
          CREATE TABLE IF NOT EXISTS timing (
          load_id TEXT PRIMARY KEY, ts REAL NOT NULL, hash TEXT NOT NULL, open_id TEXT,
          first_page_ms REAL, text_ms REAL, raster_failures INTEGER, timeouts INTEGER, errors TEXT);
          CREATE INDEX IF NOT EXISTS timing_ts ON timing(ts);''')
        yield db
    finally:
        db.close()

def record(id_, hash_, route, outcome, class_=None, ms=0, pages=None, size=None):
    try:
        with connect() as db:
            db.execute('''INSERT INTO opens VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
                  hash=excluded.hash, route=excluded.route, outcome=excluded.outcome,
                  class=excluded.class, pages=excluded.pages, source_size=excluded.source_size,
                  shell_ms=excluded.shell_ms''',
                       (id_, time.time(), hash_ if hash_ and _HASH.fullmatch(hash_) else None, route, outcome, class_, pages, size, ms))
    except (OSError, sqlite3.Error):
        pass

def timing(hash_, value):
    if not _HASH.fullmatch(hash_) or not isinstance(value, dict):
        raise ValueError('invalid timing')
    load = value.get('load_id', '')
    if not isinstance(load, str) or not re.fullmatch(r'[a-f0-9-]{16,64}', load):
        raise ValueError('invalid load id')
    def number(key, integer=False):
        v = value.get(key)
        if v is None:
            return None
        if isinstance(v, bool) or not isinstance(v, (float, int)) or not math.isfinite(v) or not 0 <= v <= 86400000:
            raise ValueError('invalid measurement')
        return int(v) if integer else v
    errors = value.get('errors', [])
    if not isinstance(errors, list) or any(e not in ('type-error', 'range-error', 'syntax-error', 'overlay-error', 'unhandled-rejection') for e in errors) or len(errors)>10:
        raise ValueError('invalid error classes')
    with connect() as db:
        db.execute('''INSERT INTO timing VALUES (?,?,?,?,?,?,?,?,?)
          ON CONFLICT(load_id) DO UPDATE SET
          first_page_ms=COALESCE(timing.first_page_ms,excluded.first_page_ms),
          text_ms=COALESCE(timing.text_ms,excluded.text_ms),
          raster_failures=MAX(COALESCE(timing.raster_failures,0),COALESCE(excluded.raster_failures,0)),
          timeouts=MAX(COALESCE(timing.timeouts,0),COALESCE(excluded.timeouts,0)),
          errors=CASE WHEN length(excluded.errors)>length(timing.errors) THEN excluded.errors ELSE timing.errors END
          WHERE timing.hash=excluded.hash''',
                   (load, time.time(), hash_, None, number('first_page_ms'), number('text_ms'), number('raster_failures', True), number('timeouts', True), json.dumps(errors)))

def relay(fn):
    """Relay delivery is a separate attempt; success means bytes ready, not painted."""
    @functools.wraps(fn)
    async def wrapped(hash_, *args, **kwargs):
        if _hint.get() is None:
            return await fn(hash_, *args, **kwargs)
        started = time.perf_counter()
        ok = False
        try:
            ok = await fn(hash_, *args, **kwargs)
            return ok
        finally:
            await asyncio.to_thread(record, uuid.uuid4().hex, hash_, 'relay',
                                    'relay-ready' if ok else 'error', None if ok else 'relay-failed',
                                    (time.perf_counter()-started)*1000)
    return wrapped

def percentile(values, p):
    values = sorted(v for v in values if v is not None)
    if not values:
        return None
    return round(values[max(0, math.ceil(len(values)*p)-1)], 1)

def summary():
    out = {}
    with connect() as db:
        for days in (1, 7, 30):
            cutoff = time.time()-days*86400
            rows = db.execute('SELECT route,outcome,class,shell_ms FROM opens WHERE ts>=?', (cutoff,)).fetchall()
            timings = [r[0] for r in db.execute('SELECT first_page_ms FROM timing WHERE ts>=?', (cutoff,))]
            n = len(rows)
            classes = {}
            for _, outcome, class_, _ in rows:
                if outcome == 'fallback':
                    classes[class_ or 'cache-miss'] = classes.get(class_ or 'cache-miss', 0)+1
            routes = []
            for route in sorted({r[0] for r in rows}):
                times = [r[3] for r in rows if r[0] == route]
                routes.append(dict(route=route, opens=len(times), p50_shell_ms=percentile(times,.5), p95_shell_ms=percentile(times,.95)))
            out[str(days)] = dict(opens=n, reader_share=sum(r[1]=='reader' for r in rows)/n if n else 0,
                fallback_by_class={k:dict(count=v, share=v/n) for k,v in classes.items()},
                errors=sum(r[1]=='error' for r in rows), timing_samples=sum(t is not None for t in timings),
                p50_first_page_ms=percentile(timings,.5), p95_first_page_ms=percentile(timings,.95),
                slowest_routes=sorted(routes,key=lambda r:r['p95_shell_ms'] or 0,reverse=True))
    return out

def configure_logging():
    # Uvicorn configures its handlers before importing main (including launchd's CLI).
    for name in ('uvicorn', 'uvicorn.error', 'uvicorn.access'):
        for handler in logging.getLogger(name).handlers:
            handler.setFormatter(logging.Formatter('%(asctime)s %(levelname)s %(message)s'))
    # Polling routes would otherwise be most of the log: several lines a second per open tab.
    logging.getLogger('uvicorn.access').addFilter(_quiet_polls)

_POLLED = ('/local-file/check', '/healthz', '/cache-urls', '/signal/navigate/wait')

def _quiet_polls(record):
    args = record.args
    if isinstance(args, tuple) and len(args) >= 5 and args[4] in (200, 304):
        return not str(args[2]).startswith(_POLLED)
    return True

class OpenMiddleware:
    """One attempt across /read -> /r redirects; direct /r loads are reopens."""
    def __init__(self, app, catalog):
        self.app, self.catalog = app, catalog

    async def __call__(self, scope, receive, send):
        path = scope.get('path', '')
        shell = re.fullmatch(r'/r/([a-f0-9]{6,64})/', path)
        cached = re.fullmatch(r'/([a-f0-9]{6,64})/[^/]+\.html', path)
        initial = path in ('/', '/read', '/read-raw', '/view', '/view-raw', '/view-file-raw')
        if scope['type'] != 'http' or scope.get('method') != 'GET' or not (initial or shell or cached):
            return await self.app(scope, receive, send)
        started = time.perf_counter()
        token = _hint.set({})
        query = parse_qs(scope.get('query_string', b'').decode('ascii', 'replace'))
        id_ = uuid.uuid4().hex
        hash_ = (shell or cached)[1] if shell or cached else None
        route = 'home' if path=='/' else 'cached reopen' if shell or cached else 'file' if 'path' in query or 'file' in path else 'url'
        previous_ms = 0
        supplied = query.get('_open', [''])[0]
        if shell and re.fullmatch(r'[a-f0-9]{32}', supplied):
            try:
                with connect() as db:
                    row = db.execute("SELECT route,shell_ms FROM opens WHERE id=? AND hash=? AND outcome='pending' AND ts>?", (supplied, hash_, time.time()-300)).fetchone()
                if row:
                    id_, route, previous_ms = supplied, row[0], row[1]
            except (OSError, sqlite3.Error):
                pass
        async def capture(message):
            nonlocal hash_
            hash_ = hash_ or _hint.get().get('hash')
            if message['type']=='http.response.start':
                status = message['status']
                headers = dict(message.get('headers', []))
                location = headers.get(b'location', b'').decode('latin1')
                target = re.fullmatch(r'/r/([a-f0-9]{6,64})/', location)
                outcome, failure = ('error', 'pdfium-failed' if shell else 'not-found' if status==404 else 'invalid-input' if status<500 else 'internal-error') if status>=400 else ('reader' if shell else 'home' if path=='/' else 'converted', None)
                if target:
                    hash_ = target[1]
                    outcome = 'pending'
                    message['headers'] = [(k,v) for k,v in message['headers'] if k!=b'location']+[(b'location', (location+'?_open='+id_).encode())]
                elif location or b'application/pdf' in headers.get(b'content-type', b''):
                    outcome, failure = 'fallback', _hint.get().get('failure') or ('disabled' if _hint.get().get('disabled') else 'cache-miss')
                pages, size = None, _hint.get().get('size')
                try:
                    if hash_:
                        pdf = self.catalog.source_pdf(hash_)
                        size = pdf.stat().st_size if pdf else size
                        # sizes are already cached by shell generation; never call PDFium here.
                        meta = self.catalog.root/hash_/'meta.json'
                        if meta.is_file():
                            pages = json.loads(meta.read_text()).get('pages')
                except (OSError, ValueError, TypeError):
                    pass
                await asyncio.to_thread(record, id_, hash_, route, outcome, failure, previous_ms+(time.perf_counter()-started)*1000, pages, size)
            await send(message)
        try:
            await self.app(scope, receive, capture)
        except Exception:
            record(id_, hash_, route, 'error', 'internal-error', (time.perf_counter()-started)*1000)
            raise
        finally:
            _hint.reset(token)

"""The reader representation: PDFium page rasters under a transparent text layer.

A reader page is the DOM the overlay already understands (`#page-container`
of `.pf` frames, `.pc`, `img.bi`, `.t` lines, `#outline`), built straight from
the PDF instead of converted by pdf2htmlEX:

- pixels come from PDFium at the device width the browser asks for, so text,
  figures and math are as sharp as in Chrome's own viewer;
- text is one transparent `.t` element per line, fitted by the overlay to the
  width PDFium reports, for selection, find, copy and Vimium.

Nothing is converted ahead of time. The shell and every raster are derived
artifacts under `<hash>/reader/`, rebuilt on demand and safe to delete.
PDFium runs in worker processes only (`pdfium_doc`).

Text arrives in ranges of TEXT_RANGE_PAGES pages. The first open of a
document gets every page frame but text only for the first range (and the
saved position's); the overlay fetches the other ranges from
`/r/<hash>/text/<k>.json` and inserts them. Ranges are cached under
`<hash>/reader/text/`; once all exist, the complete shell is written and
later opens get everything in one response.
"""
from __future__ import annotations

import concurrent.futures
import functools
import heapq
import html
import json
import multiprocessing
import os
import pathlib
import threading

import ocr
import pdfium_doc

# Bump when the shell markup changes, so cached shells are rebuilt.
SHELL_VERSION = 7
REPRESENTATION = "raster-v1"
MIN_RASTER_WIDTH = 64
MAX_RASTER_WIDTH = 6000
MAX_RASTER_PIXELS = 48_000_000
# Width baked into the shell for a page's first paint, as a multiple of its
# CSS width. The overlay replaces it with the exact device width.
SHELL_RASTER_SCALE = 2
# Pages per text range: the unit of `/r/<hash>/text/<k>.json` and its cache.
TEXT_RANGE_PAGES = 32
# Pages per worker task, so that one range spreads over several workers.
TEXT_TASK_PAGES = 8

BASE_CSS = """
html,body{margin:0;padding:0;height:100%}
#sidebar{position:absolute;top:0;left:0;bottom:0;width:250px;padding:0;margin:0;overflow:auto}
#outline ul{padding:0}
#outline li{list-style-type:none}
#outline li>ul{margin-left:1em}
#outline a{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-decoration:none}
#page-container{position:absolute;top:0;left:0;bottom:0;right:0;margin:0;padding:0;border:0;overflow:auto}
.pf{position:relative;background-color:#fff;overflow:hidden;margin:13px auto;border:0;box-shadow:1px 1px 3px 1px #333}
.pc{position:absolute;top:0;left:0;width:100%;height:100%;overflow:hidden}
.bi{position:absolute;top:0;left:0;width:100%;height:100%;border:0;margin:0;user-select:none}
.t{position:absolute;white-space:pre;line-height:1;transform-origin:0 0;color:transparent;
font-family:sans-serif;font-kerning:none;font-variant-ligatures:none;cursor:text}
.t.fs{font-family:serif}.t.fm{font-family:monospace}.t.fb{font-weight:bold}.t.fi{font-style:italic}
.t .g{font-size:0}
.t::selection,.t *::selection{color:transparent;background:rgba(0,100,163,.4)}
.pc>a.l{position:absolute;display:block;margin:0;padding:0;border:0;background:transparent;cursor:pointer;
-webkit-user-drag:none;user-select:none}
#page-container.pdf2html-link-pass .pc>a.l{pointer-events:none}
@media print{#sidebar{display:none}#page-container{position:static;overflow:visible}.pf{margin:0;box-shadow:none;page-break-after:always}}
"""

_ROTATIONS = {1: "rotate(90deg)", 2: "rotate(180deg)", 3: "rotate(-90deg)"}


def _num(value: float) -> str:
    text = f"{value:.2f}".rstrip("0").rstrip(".")
    return text if text and text != "-0" else "0"


def _line_html(line: dict) -> str:
    style = f"left:{_num(line['x'])}px;top:{_num(line['y'])}px;font-size:{_num(line['h'])}px"
    rotation = _ROTATIONS.get(line.get("dir", 0))
    if rotation:
        style += f";transform:{rotation}"
    segments = line["segs"]
    # Fallback family and style (pdfium_doc.font_style): fs, fm, fb, fi.
    classes = "t" + "".join(f" f{letter}" for letter in line.get("f", ""))
    if line.get("ocr"):
        classes += " ocr"
    attrs = ""
    if line.get("rtl"):
        attrs = ' dir="rtl"'
    if len(segments) == 1:
        seg = segments[0]
        return f'<div class="{classes}" style="{style}"{attrs} data-w="{_num(seg["w"])}">{html.escape(seg["t"], quote=False)}<br></div>'
    parts = []
    for i, seg in enumerate(segments):
        if i:
            space = " " if seg["sp"] else ""
            parts.append(f'<span class="g" style="padding-left:{_num(max(0.0, seg["gap"]))}px">{space}</span>')
        parts.append(f'<span data-w="{_num(seg["w"])}">{html.escape(seg["t"], quote=False)}</span>')
    return f'<div class="{classes}" style="{style}"{attrs}>{"".join(parts)}<br></div>'


def _outline_html(entries: list[dict]) -> str:
    if not entries:
        return ""
    out = []
    depth = -1
    for entry in entries:
        level = max(0, int(entry["level"]))
        level = min(level, depth + 1)
        if level > depth:
            out.append("<ul>" * (level - depth))
        else:
            out.append("</li>" + "</ul></li>" * (depth - level))
        depth = level
        dest = json.dumps([entry["page"], "XYZ", entry["x"], entry["y"], None])
        out.append(
            f'<li><a class="l" href="#pf{entry["page"]:x}" data-reader-dest=\'{html.escape(dest, quote=True)}\'>'
            f'{html.escape(entry["title"].strip() or "Untitled", quote=False)}</a>'
        )
    out.append("</li>" + "</ul></li>" * depth + "</ul>")
    return "".join(out)


def _link_html(link: dict) -> str:
    """One link annotation as a positioned, empty anchor over the raster."""
    style = (f"left:{_num(link['x'])}px;top:{_num(link['y'])}px;"
             f"width:{_num(link['w'])}px;height:{_num(link['h'])}px")
    dest = link.get("dest")
    if dest is not None:
        page = int(dest["page"])
        detail = json.dumps([page, "XYZ", dest.get("x"), dest.get("y"), None])
        return (f'<a class="l" href="#pf{page:x}" style="{style}" aria-label="Page {page}" '
                f"data-reader-dest='{html.escape(detail, quote=True)}'></a>")
    uri = html.escape(link["uri"], quote=True)
    return (f'<a class="l" href="{uri}" style="{style}" target="_blank" '
            f'rel="noopener noreferrer" title="{uri}" aria-label="{uri}"></a>')


def raster_width(page_width: float, requested: int, page_height: float) -> int:
    """Clamp a requested device width to what one page may cost."""
    width = max(MIN_RASTER_WIDTH, min(MAX_RASTER_WIDTH, int(requested)))
    pixels = width * width * (page_height / page_width)
    if pixels > MAX_RASTER_PIXELS:
        width = int((MAX_RASTER_PIXELS * page_width / page_height) ** 0.5)
    return max(MIN_RASTER_WIDTH, width)


def page_body(lines: list[dict], links: list[dict]) -> str:
    """A page's markup inside `.pc` after its raster: text lines, then links."""
    return "".join(_line_html(line) for line in lines) + "".join(_link_html(link) for link in links)


class PageBody(str):
    """Worker markup with its scan decision; disk caches store it explicitly."""
    def __new__(cls, markup, scanned=False):
        obj = super().__new__(cls, markup)
        obj.scanned = scanned
        return obj


def range_bodies(path: str, start: int, stop: int) -> list[str]:
    sizes = pdfium_doc.page_sizes(path)
    out = []
    for index, (lines, links) in enumerate(pdfium_doc.pages_layer(path, start, stop), start):
        w, h = sizes[index]
        scanned = (ocr.may_need_ocr(lines, w, h) and
                   ocr.needs_ocr(lines, w, h, pdfium_doc.page_image_coverage(path, index)))
        out.append(PageBody(page_body(lines, links), scanned))
    return out


def build_shell(hash_: str, title: str, sizes: list[tuple[float, float]],
                outline: list[dict], texts: list[list[dict]],
                links: list[list[dict]] | None = None) -> str:
    """The complete shell from extracted lines and links."""
    bodies = [page_body(texts[i] if i < len(texts) else [],
                        links[i] if links and i < len(links) else [])
              for i in range(len(sizes))]
    return shell_html(hash_, title, sizes, outline, bodies)


def shell_html(hash_: str, title: str, sizes: list[tuple[float, float]],
               outline: list[dict], bodies: list[str | None]) -> str:
    """The shell markup. A page whose body is None has no text yet: its
    frame carries `data-reader-pending`, and the root names where the
    overlay fetches it."""
    pending = any(body is None for body in bodies)
    loading = ' data-reader-text="complete"'
    if pending:
        loading = (f' data-reader-text="loading" data-reader-text-src="/r/{html.escape(hash_, quote=True)}/text/"'
                   f' data-reader-text-range="{TEXT_RANGE_PAGES}"')
    parts = [
        "<!DOCTYPE html>\n"
        f'<html data-pdf2html-representation="{REPRESENTATION}" data-pdf2html-text-mode="transparent"{loading}>'
        '<head><meta charset="utf-8">'
        f"<title>{html.escape(title)}</title>"
        f'<meta id="pdf2html-hash" name="pdf2html-hash" content="{html.escape(hash_, quote=True)}">'
        f"<style>{BASE_CSS}</style>"
        '<link id="pdf2html-favicon" rel="icon" type="image/svg+xml" href="/_assets/favicon.svg">'
        '<link id="pdf2html-overlay-css" rel="stylesheet" href="/_assets/overlay.css">'
        '<script id="pdf2html-overlay-js" type="module" src="/_assets/overlay.js"></script>'
        "</head><body>"
        f'<div id="sidebar"><div id="outline">{_outline_html(outline)}</div></div>'
        '<div id="page-container">'
    ]
    for index, (width, height) in enumerate(sizes):
        number = index + 1
        body = bodies[index] if index < len(bodies) else None
        base = f"/r/{hash_}/p/{number}/"
        first = raster_width(width, round(width * SHELL_RASTER_SCALE), height)
        parts.append(
            f'<div id="pf{number:x}" class="pf" data-page-no="{number:x}"'
            + (' data-reader-pending=""' if body is None else "")
            + (' data-reader-ocr="pending"' if getattr(body, 'scanned', False) else "")
            + f' style="width:{_num(width)}px;height:{_num(height)}px">'
            f'<div class="pc"><img class="bi" alt="" data-pdf2html-src="{base}{first}.png" '
            f'data-reader-raster="{base}">'
            + (body or "")
            + "</div></div>"
        )
    parts.append("</div></body></html>\n")
    return "".join(parts)


def ocr_workers() -> int:
    """Pages recognized at once. Vision spreads one page over several cores
    and the Neural Engine, so two keep it busy without starving rendering."""
    try:
        return max(1, int(os.environ.get("PDF_VIEWER_OCR_WORKERS", "2")))
    except ValueError:
        return 2


class Reader:
    """Derived reader artifacts for cache entries, built on demand."""

    def __init__(self, cache_root: pathlib.Path, *, workers: int | None = None,
                 raster_cache_bytes: int | None = None):
        self.root = cache_root
        self.workers = workers or max(2, min(6, (os.cpu_count() or 4) - 2))
        if raster_cache_bytes is None:
            raster_cache_bytes = int(os.environ.get("PDF_VIEWER_RASTER_CACHE_MB", "1500")) * 1024 * 1024
        self.raster_cache_bytes = raster_cache_bytes
        self._pool: concurrent.futures.ProcessPoolExecutor | None = None
        self._lock = threading.Lock()
        self._building: dict[str, threading.Lock] = {}
        self._sizes: dict[tuple[str, int, int], list[tuple[float, float]]] = {}
        self._writes = 0
        self._ocr_queue = None
        self._ocr_sources = {}
        self._ocr_generation = {}
        self._ocr_revision = {}
        # Tasks wait here, most urgent first, until a worker is free; the
        # pool itself never holds more than one task per worker, so a page
        # render never queues behind a backlog of text ranges.
        self._queue: list[tuple] = []
        self._queued = threading.Condition(threading.Lock())
        self._active = 0
        self._sequence = 0
        self._dispatcher: threading.Thread | None = None

    # ------------------------------------------------------------- plumbing
    def pool(self) -> concurrent.futures.ProcessPoolExecutor:
        with self._lock:
            if self._pool is None:
                self._pool = concurrent.futures.ProcessPoolExecutor(
                    max_workers=self.workers, mp_context=multiprocessing.get_context("spawn"))
            return self._pool

    def _discard(self, pool: concurrent.futures.ProcessPoolExecutor) -> None:
        """Forget a broken pool; the next task starts a fresh one. Only the
        pool that broke is dropped, never one another thread just made."""
        with self._lock:
            if self._pool is pool:
                self._pool = None

    def _submit(self, fn, *args, urgent: bool = True, priority: int | None = None) -> concurrent.futures.Future:
        """Queue a worker task. Urgent tasks (rasters, the shell) run before
        background ones (text ranges), then OCR image preparation (priority 2).
        Each kind runs in submission order."""
        future: concurrent.futures.Future = concurrent.futures.Future()
        with self._queued:
            self._sequence += 1
            heapq.heappush(self._queue, (priority if priority is not None else (0 if urgent else 1), self._sequence, fn, args, future))
            if self._dispatcher is None or not self._dispatcher.is_alive():
                self._dispatcher = threading.Thread(target=self._dispatch, name="reader-dispatch", daemon=True)
                self._dispatcher.start()
            self._queued.notify()
        return future

    def _dispatch(self) -> None:
        while True:
            with self._queued:
                while not (self._queue and self._active < self.workers):
                    self._queued.wait()
                _, _, fn, args, future = heapq.heappop(self._queue)
                self._active += 1
            if not future.set_running_or_notify_cancel():
                self._task_done()
                continue
            try:
                pool = self.pool()
                try:
                    inner = pool.submit(fn, *args)
                except concurrent.futures.process.BrokenProcessPool:
                    self._discard(pool)
                    pool = self.pool()
                    inner = pool.submit(fn, *args)
            except BaseException as error:  # noqa: BLE001 - handed to the caller
                future.set_exception(error)
                self._task_done()
                continue
            inner.add_done_callback(functools.partial(self._finished, pool, future))

    def _task_done(self) -> None:
        with self._queued:
            self._active -= 1
            self._queued.notify()

    def _finished(self, pool, future: concurrent.futures.Future, inner: concurrent.futures.Future) -> None:
        self._task_done()
        error = inner.exception()
        if error is None:
            future.set_result(inner.result())
            return
        if isinstance(error, concurrent.futures.process.BrokenProcessPool):
            # A PDF that crashes PDFium takes its worker down; start fresh.
            self._discard(pool)
        future.set_exception(error)

    def _run(self, fn, *args):
        return self._submit(fn, *args).result()

    def _key_lock(self, key: str) -> threading.Lock:
        with self._lock:
            return self._building.setdefault(key, threading.Lock())

    def entry_dir(self, hash_: str) -> pathlib.Path:
        return self.root / hash_ / "reader"

    def sizes(self, pdf: pathlib.Path) -> list[tuple[float, float]]:
        stat = pdf.stat()
        key = (str(pdf), stat.st_mtime_ns, stat.st_size)
        cached = self._sizes.get(key)
        if cached is None:
            cached = self._run(pdfium_doc.page_sizes, str(pdf))
            self._sizes[key] = cached
        return cached

    # ------------------------------------------------------------------ text
    def range_count(self, pdf: pathlib.Path) -> int:
        return -(-len(self.sizes(pdf)) // TEXT_RANGE_PAGES)

    def _range_path(self, hash_: str, index: int) -> pathlib.Path:
        return self.entry_dir(hash_) / "text" / f"{index}.json"

    def _text_stamp(self, pdf: pathlib.Path) -> list:
        stat = pdf.stat()
        return [SHELL_VERSION, pdfium_doc.TEXT_LAYER_VERSION, TEXT_RANGE_PAGES,
                str(pdf), stat.st_mtime_ns, stat.st_size]

    def _cached_range(self, hash_: str, index: int, stamp: list) -> list[str] | None:
        try:
            data = json.loads(self._range_path(hash_, index).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        if not isinstance(data, dict) or data.get("stamp") != stamp or not isinstance(data.get("pages"), list):
            return None
        return [PageBody(body, i in data.get("ocr", [])) for i, body in enumerate(data["pages"])]

    def _extract_start(self, pdf: pathlib.Path, index: int, count: int, urgent: bool = False) -> list:
        start = index * TEXT_RANGE_PAGES
        stop = min(count, start + TEXT_RANGE_PAGES)
        return [(task, min(stop, task + TEXT_TASK_PAGES),
                 self._submit(range_bodies, str(pdf), task, min(stop, task + TEXT_TASK_PAGES), urgent=urgent))
                for task in range(start, stop, TEXT_TASK_PAGES)]

    def _extract_finish(self, pdf: pathlib.Path, tasks: list) -> tuple[list[str], bool]:
        """Collect a range's tasks: (bodies, complete). A task lost to a
        crashed worker is redone page by page; a page that crashes again
        gets no text and makes the range incomplete, so it is not cached."""
        bodies: list[str] = []
        complete = True
        for start, stop, future in tasks:
            try:
                bodies.extend(future.result())
                continue
            except concurrent.futures.process.BrokenProcessPool:
                pass
            for page in range(start, stop):
                try:
                    bodies.extend(self._run(range_bodies, str(pdf), page, page + 1))
                except concurrent.futures.process.BrokenProcessPool:
                    bodies.append("")
                    complete = False
        return bodies, complete

    def _store_range(self, hash_: str, index: int, stamp: list, bodies: list[str]) -> None:
        if not (self.root / hash_).is_dir():
            return  # deleted while extracting: do not bring it back
        path = self._range_path(hash_, index)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(f".{os.getpid()}.{threading.get_ident()}.tmp")
        tmp.write_text(json.dumps({"stamp": stamp, "pages": bodies, "ocr": [i for i, body in enumerate(bodies) if getattr(body, "scanned", False)]}, ensure_ascii=False), encoding="utf-8")
        tmp.replace(path)

    def text_range(self, hash_: str, pdf: pathlib.Path, index: int) -> tuple[int, list[str]]:
        """(first page, page bodies) of text range `index`, from the cache or
        extracted once, however many requests ask for it at the same time."""
        count = len(self.sizes(pdf))
        if index < 0 or index * TEXT_RANGE_PAGES >= count:
            raise IndexError(index)
        first = index * TEXT_RANGE_PAGES + 1
        stamp = self._text_stamp(pdf)
        cached = self._cached_range(hash_, index, stamp)
        if cached is not None:
            return first, cached
        with self._key_lock(f"text:{hash_}:{index}"):
            cached = self._cached_range(hash_, index, stamp)
            if cached is not None:
                return first, cached
            bodies, complete = self._extract_finish(pdf, self._extract_start(pdf, index, count))
            if complete:
                self._store_range(hash_, index, stamp, bodies)
            return first, bodies

    # ----------------------------------------------------------------- shell
    def shell_path(self, hash_: str) -> pathlib.Path:
        return self.entry_dir(hash_) / "shell.html"

    def _shell_stamp(self, pdf: pathlib.Path, title: str) -> str:
        stat = pdf.stat()
        return json.dumps([SHELL_VERSION, pdfium_doc.TEXT_LAYER_VERSION, str(pdf), stat.st_mtime_ns, stat.st_size, title])

    def shell(self, hash_: str, pdf: pathlib.Path, title: str,
              near_pages: tuple[int, ...] = ()) -> pathlib.Path | str:
        """The reader shell for an entry.

        The complete shell (a file) when every text range is cached. Before
        that, the markup itself: every page frame, text for the first range,
        for the ranges of `near_pages` (1-based, such as the saved position)
        and for any range already cached, and a pending marker on the rest.
        """
        path = self.shell_path(hash_)
        stamp_path = path.with_suffix(".stamp")
        stamp = self._shell_stamp(pdf, title)
        with self._key_lock("shell:" + hash_):
            if self._shell_current(path, stamp):
                return path
            sizes = self.sizes(pdf)
            count = len(sizes)
            ranges = -(-count // TEXT_RANGE_PAGES)
            text_stamp = self._text_stamp(pdf)
            cached = {k: self._cached_range(hash_, k, text_stamp) for k in range(ranges)}
            wanted = {0} | {(page - 1) // TEXT_RANGE_PAGES for page in near_pages if 1 <= page <= count}
            # The outline and metadata first: they are quick, and the pool
            # runs tasks in the order they were submitted.
            outline_task = self._submit(pdfium_doc.outline, str(pdf))
            meta_task = None if (self.root / hash_ / "meta.json").exists() else \
                self._submit(pdfium_doc.metadata, str(pdf))
            started = {k: self._extract_start(pdf, k, count, urgent=True)
                       for k in sorted(wanted) if k < ranges and cached[k] is None}
            outline = outline_task.result()
            if meta_task is not None:
                self._store_meta(hash_, pdf, meta_task)
            degraded = False
            for k, tasks in started.items():
                bodies, complete = self._extract_finish(pdf, tasks)
                if complete:
                    self._store_range(hash_, k, text_stamp, bodies)
                degraded = degraded or not complete
                cached[k] = bodies
            page_bodies: list[str | None] = []
            for k in range(ranges):
                part = cached[k]
                size = min(count, (k + 1) * TEXT_RANGE_PAGES) - k * TEXT_RANGE_PAGES
                page_bodies.extend(part if part is not None and len(part) == size else [None] * size)
            document = shell_html(hash_, title, sizes, outline, page_bodies)
            # Only complete text is written: a page that lost its text to a
            # crashed worker is retried on the next open.
            if degraded or any(body is None for body in page_bodies):
                return document
            if not self._write_shell(hash_, path, stamp_path, stamp, document):
                return document
            return path

    def _write_shell(self, hash_: str, path: pathlib.Path, stamp_path: pathlib.Path,
                     stamp: str, document: str) -> bool:
        if not (self.root / hash_).is_dir():
            return False  # deleted while building: do not bring it back
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(document, encoding="utf-8")
        tmp.replace(path)
        stamp_path.write_text(stamp, encoding="utf-8")
        return True

    def _shell_current(self, path: pathlib.Path, stamp: str) -> bool:
        try:
            return path.is_file() and path.with_suffix(".stamp").read_text(encoding="utf-8") == stamp
        except OSError:
            return False

    def finish_shell(self, hash_: str, pdf: pathlib.Path, title: str) -> None:
        """Write the complete shell once every text range is cached, so the
        next open needs one response. Cheap until the last range lands."""
        ranges = self.range_count(pdf)
        try:
            if sum(1 for _ in (self.entry_dir(hash_) / "text").glob("*.json")) < ranges:
                return
        except OSError:
            return
        if self._shell_current(self.shell_path(hash_), self._shell_stamp(pdf, title)):
            return
        text_stamp = self._text_stamp(pdf)
        if all(self._cached_range(hash_, k, text_stamp) is not None for k in range(ranges)):
            self.shell(hash_, pdf, title)

    def _store_meta(self, hash_: str, pdf: pathlib.Path, task) -> None:
        """The sidebar header reads `<hash>/meta.json`. Converted entries get
        it from pdfinfo; an entry opened on demand gets PDFium's copy."""
        path = self.root / hash_ / "meta.json"
        try:
            meta = task.result()
            meta["file_size"] = pdf.stat().st_size
            tmp = path.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            tmp.replace(path)
        except Exception:
            pass  # the header falls back to the document title

    def ocr_store(self, hash_: str, pdf: pathlib.Path | None = None) -> ocr.OcrStore:
        stamp = None
        if pdf is not None:
            stat = pdf.stat()
            stamp = [str(pdf), stat.st_mtime_ns, stat.st_size, pdfium_doc.TEXT_LAYER_VERSION]
        return ocr.OcrStore(self.entry_dir(hash_), stamp=stamp)

    def ocr_pages(self, hash_: str, pdf: pathlib.Path, title: str) -> list[int]:
        # Pending ranges have no scan decision yet.
        stamp = self._text_stamp(pdf)
        pages = []
        for k in range(self.range_count(pdf)):
            bodies = self._cached_range(hash_, k, stamp)
            if bodies is not None:
                pages.extend(k * TEXT_RANGE_PAGES + i + 1 for i, body in enumerate(bodies)
                             if getattr(body, "scanned", False))
        return pages

    def _ocr(self) -> ocr.OcrQueue:
        with self._lock:
            if self._ocr_queue is None:
                self._ocr_queue = ocr.OcrQueue(self._ocr_page, workers=ocr_workers())
            return self._ocr_queue

    def _ocr_page(self, key: str, page: int, background: bool) -> None:
        """Recognize one 1-based page and store it (an OcrQueue job)."""
        hash_, generation = key.split(":")
        if int(generation) != self._ocr_generation.get(hash_, 0) or not (self.root / hash_).is_dir():
            return
        pdf = self._ocr_sources[key]
        store = self.ocr_store(hash_, pdf)
        if store.has(page):
            return
        tool = ocr.tool_path()
        if tool is None:
            raise RuntimeError(ocr.unavailable_reason())
        width, height = self.sizes(pdf)[page - 1]

        def render(*args):
            return self._submit(pdfium_doc.render_for_ocr, *args, priority=2).result()

        result = ocr.recognize_page(str(pdf), page - 1, width, height, tool=tool, render=render,
                                    background=background)
        if int(generation) != self._ocr_generation.get(hash_, 0) or not (self.root / hash_).is_dir():
            raise FileNotFoundError(hash_)  # deleted meanwhile: do not bring it back
        result["version"] = ocr.OCR_VERSION
        with self._key_lock("ocr-write:" + hash_):
            if int(generation) == self._ocr_generation.get(hash_, 0) and (self.root / hash_).is_dir():
                store.put(page, result)

    def ocr_status(self, hash_: str, pdf: pathlib.Path, title: str, pages: list[int],
                   wait: float) -> dict:
        """Recognized text for 1-based pages, as the OCR route answers it.

        The first call for a document queues all its marked pages in the
        background; pages asked for with `wait` > 0 go to the front and are
        waited for up to `wait` seconds. Each page answers with a state:
        "done" (with the lines' markup in "html"), "pending", "failed", "none" (not a scanned
        page) or "unavailable"."""
        stat = pdf.stat()
        revision = (str(pdf), stat.st_mtime_ns, stat.st_size, pdfium_doc.TEXT_LAYER_VERSION, ocr.OCR_VERSION)
        with self._key_lock("ocr-source:" + hash_):
            previous = self._ocr_revision.get(hash_)
            if previous is not None and previous != revision:
                self.ocr_forget(hash_)
            self._ocr_revision[hash_] = revision
            key = f"{hash_}:{self._ocr_generation.get(hash_, 0)}"
        self.shell(hash_, pdf, title)
        marked = set(self.ocr_pages(hash_, pdf, title))
        store = self.ocr_store(hash_, pdf)
        reason = ocr.unavailable_reason() if marked else None
        out: dict = {"version": ocr.OCR_VERSION, "available": reason is None, "total": len(marked)}
        if reason is not None:
            out["reason"] = reason
        wanted = [p for p in pages if p in marked]
        if reason is None and marked:
            queue = self._ocr()
            self._ocr_sources[key] = pdf
            missing = [p for p in sorted(marked) if not store.has(p)]
            queue.submit(key, missing, ocr.BACKGROUND)
            todo = [p for p in wanted if not store.has(p)]
            if todo and wait > 0:
                queue.submit(key, todo, ocr.VISIBLE)
                queue.wait(key, todo, wait)
        states: dict = {}
        for page in pages:
            if page not in marked:
                states[str(page)] = {"state": "none"}
                continue
            result = store.get(page)
            if result is not None:
                lines = result.get("lines", [])
                states[str(page)] = {"state": "done", "lines": len(lines),
                                     "html": "".join(_line_html(line) for line in lines)}
            elif reason is not None:
                states[str(page)] = {"state": "unavailable"}
            else:
                state = self._ocr().state(key, page)
                states[str(page)] = {"state": "failed" if state == "failed" else "pending"}
        out["pages"] = states
        out["done"] = sum(1 for p in marked if store.has(p)) if marked else 0
        return out

    def ocr_forget(self, hash_: str) -> None:
        with self._key_lock("ocr-write:" + hash_):
            generation = self._ocr_generation.get(hash_, 0)
            self._ocr_generation[hash_] = generation + 1
        if self._ocr_queue is not None:
            self._ocr_queue.forget(f"{hash_}:{generation}")

    # --------------------------------------------------------------- rasters
    def raster(self, hash_: str, pdf: pathlib.Path, page: int, width: int) -> pathlib.Path:
        """PNG of a 1-based page at a device width, rendered when not cached."""
        sizes = self.sizes(pdf)
        if page < 1 or page > len(sizes):
            raise IndexError(page)
        page_width, page_height = sizes[page - 1]
        width = raster_width(page_width, width, page_height)
        path = self.entry_dir(hash_) / "px" / str(width) / f"{page}.png"
        if path.is_file():
            try:
                os.utime(path)
            except OSError:
                pass
            return path
        with self._key_lock(f"px:{hash_}:{width}:{page}"):
            if path.is_file():
                return path
            data = self._run(pdfium_doc.render_png, str(pdf), page - 1, width)
            if not (self.root / hash_).is_dir():
                # Deleted while this page rendered: do not bring it back.
                raise FileNotFoundError(hash_)
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(f".{os.getpid()}.{threading.get_ident()}.tmp")
            tmp.write_bytes(data)
            tmp.replace(path)
        self._writes += 1
        if self._writes % 100 == 0:
            self.evict()
        return path

    def evict(self) -> int:
        """Drop least-recently-used rasters until the cache fits its budget."""
        files = []
        total = 0
        for path in self.root.glob("*/reader/px/*/*.png"):
            try:
                stat = path.stat()
            except OSError:
                continue
            files.append((stat.st_mtime, stat.st_size, path))
            total += stat.st_size
        removed = 0
        if total <= self.raster_cache_bytes:
            return removed
        files.sort()
        target = self.raster_cache_bytes * 0.8
        for _mtime, size, path in files:
            if total <= target:
                break
            try:
                path.unlink()
                total -= size
                removed += 1
            except OSError:
                pass
        return removed

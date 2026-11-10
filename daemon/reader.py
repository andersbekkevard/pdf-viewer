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
"""
from __future__ import annotations

import concurrent.futures
import html
import json
import multiprocessing
import os
import pathlib
import threading

import pdfium_doc

# Bump when the shell markup changes, so cached shells are rebuilt.
SHELL_VERSION = 2
REPRESENTATION = "raster-v1"
MIN_RASTER_WIDTH = 64
MAX_RASTER_WIDTH = 6000
MAX_RASTER_PIXELS = 48_000_000
# Width baked into the shell for a page's first paint, as a multiple of its
# CSS width. The overlay replaces it with the exact device width.
SHELL_RASTER_SCALE = 2

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
.t .g{font-size:0}
.t::selection,.t *::selection{color:transparent;background:rgba(0,100,163,.4)}
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
    attrs = ""
    if line.get("rtl"):
        attrs = ' dir="rtl"'
    if len(segments) == 1:
        seg = segments[0]
        return f'<div class="t" style="{style}"{attrs} data-w="{_num(seg["w"])}">{html.escape(seg["t"], quote=False)}<br></div>'
    parts = []
    for i, seg in enumerate(segments):
        if i:
            space = " " if seg["sp"] else ""
            parts.append(f'<span class="g" style="padding-left:{_num(max(0.0, seg["gap"]))}px">{space}</span>')
        parts.append(f'<span data-w="{_num(seg["w"])}">{html.escape(seg["t"], quote=False)}</span>')
    return f'<div class="t" style="{style}"{attrs}>{"".join(parts)}<br></div>'


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


def raster_width(page_width: float, requested: int, page_height: float) -> int:
    """Clamp a requested device width to what one page may cost."""
    width = max(MIN_RASTER_WIDTH, min(MAX_RASTER_WIDTH, int(requested)))
    pixels = width * width * (page_height / page_width)
    if pixels > MAX_RASTER_PIXELS:
        width = int((MAX_RASTER_PIXELS * page_width / page_height) ** 0.5)
    return max(MIN_RASTER_WIDTH, width)


def build_shell(hash_: str, title: str, sizes: list[tuple[float, float]],
                outline: list[dict], texts: list[list[dict]]) -> str:
    parts = [
        "<!DOCTYPE html>\n"
        f'<html data-pdf2html-representation="{REPRESENTATION}" data-pdf2html-text-mode="transparent">'
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
        lines = texts[index] if index < len(texts) else []
        base = f"/r/{hash_}/p/{number}/"
        first = raster_width(width, round(width * SHELL_RASTER_SCALE), height)
        parts.append(
            f'<div id="pf{number:x}" class="pf" data-page-no="{number:x}" '
            f'style="width:{_num(width)}px;height:{_num(height)}px">'
            f'<div class="pc"><img class="bi" alt="" data-pdf2html-src="{base}{first}.png" '
            f'data-reader-raster="{base}">'
            + "".join(_line_html(line) for line in lines)
            + "</div></div>"
        )
    parts.append("</div></body></html>\n")
    return "".join(parts)


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

    # ------------------------------------------------------------- plumbing
    def pool(self) -> concurrent.futures.ProcessPoolExecutor:
        with self._lock:
            if self._pool is None:
                self._pool = concurrent.futures.ProcessPoolExecutor(
                    max_workers=self.workers, mp_context=multiprocessing.get_context("spawn"))
            return self._pool

    def _run(self, fn, *args):
        try:
            return self.pool().submit(fn, *args).result()
        except concurrent.futures.process.BrokenProcessPool:
            # A PDF that crashes PDFium takes its worker down; start fresh.
            with self._lock:
                self._pool = None
            raise

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

    # ----------------------------------------------------------------- shell
    def shell_path(self, hash_: str) -> pathlib.Path:
        return self.entry_dir(hash_) / "shell.html"

    def _shell_stamp(self, pdf: pathlib.Path, title: str) -> str:
        stat = pdf.stat()
        return json.dumps([SHELL_VERSION, pdfium_doc.TEXT_LAYER_VERSION, str(pdf), stat.st_mtime_ns, stat.st_size, title])

    def shell(self, hash_: str, pdf: pathlib.Path, title: str) -> pathlib.Path:
        """The reader shell for an entry, built when missing or stale."""
        path = self.shell_path(hash_)
        stamp_path = path.with_suffix(".stamp")
        stamp = self._shell_stamp(pdf, title)
        with self._key_lock("shell:" + hash_):
            try:
                if path.is_file() and stamp_path.read_text(encoding="utf-8") == stamp:
                    return path
            except OSError:
                pass
            sizes = self.sizes(pdf)
            count = len(sizes)
            pool = self.pool()
            chunk = max(4, -(-count // (self.workers * 2)))
            futures = [pool.submit(pdfium_doc.pages_text, str(pdf), start, min(count, start + chunk))
                       for start in range(0, count, chunk)]
            outline = self._run(pdfium_doc.outline, str(pdf))
            texts: list[list[dict]] = []
            for future in futures:
                texts.extend(future.result())
            document = build_shell(hash_, title, sizes, outline, texts)
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(".tmp")
            tmp.write_text(document, encoding="utf-8")
            tmp.replace(path)
            stamp_path.write_text(stamp, encoding="utf-8")
            return path

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

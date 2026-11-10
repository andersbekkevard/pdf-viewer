"""PDFium access for the reader: page sizes, outline, text lines and rasters.

Everything here is a plain function of a PDF path, safe to run in a worker
process (PDFium is not thread-safe, so the daemon never calls it from its
request threads). Coordinates leave this module in *page px*: top-left origin,
1 PDF point = 1 px, page rotation and crop box already applied. That is the
unit of a `.pf` page frame in the reader shell.

Text model. A page is a list of lines in PDFium's text order. A line is a
list of segments; a segment is a run of characters with no large horizontal
gap, carrying the exact width it occupies on the page. The browser lays the
segment out in a fallback font and fits it to that width, so selection and
find highlights land on the rastered glyphs without any embedded font.
"""
from __future__ import annotations

import ctypes
import functools
import io
import math
import statistics
import unicodedata

import pypdfium2 as pdfium
import pypdfium2.raw as raw

# A horizontal gap wider than this many line heights starts a new segment
# (table columns, a running head and its page number). Word spaces in
# justified text stay well below it.
SEGMENT_GAP_EM = 1.0
# Characters whose centre leaves the line by more than this many line heights
# belong to another line, even when PDFium reports no line break.
LINE_DRIFT_EM = 0.7
TEXT_LAYER_VERSION = 1


@functools.lru_cache(maxsize=6)
def _open(path: str, mtime_ns: int, size: int) -> pdfium.PdfDocument:
    del mtime_ns, size  # cache key only: a replaced file is reopened
    return pdfium.PdfDocument(path)


def open_document(path: str) -> pdfium.PdfDocument:
    import os

    stat = os.stat(path)
    return _open(path, stat.st_mtime_ns, stat.st_size)


def page_sizes(path: str) -> list[tuple[float, float]]:
    pdf = open_document(path)
    return [pdf.get_page_size(i) for i in range(len(pdf))]


def outline(path: str) -> list[dict]:
    """Bookmarks in document order: {level, title, page (1-based), x, y}.

    x and y are page px from the top-left corner, or None when the
    destination names no position.
    """
    pdf = open_document(path)
    sizes: dict[int, tuple[float, float]] = {}
    out = []
    try:
        items = list(pdf.get_toc(max_depth=12))
    except Exception:
        return out
    for item in items:
        try:
            title = item.get_title()
            dest = item.get_dest()
            index = dest.get_index() if dest is not None else None
            if index is None or index < 0 or index >= len(pdf):
                continue
            x = y = None
            try:
                pos = dest.get_view()[1]
                if index not in sizes:
                    sizes[index] = pdf.get_page_size(index)
                if len(pos) >= 2:
                    px, py = pos[0], pos[1]
                    if px is not None and math.isfinite(px):
                        x = max(0.0, float(px))
                    if py is not None and math.isfinite(py):
                        y = max(0.0, sizes[index][1] - float(py))
            except Exception:
                pass
            out.append({"level": item.level, "title": title or "", "page": index + 1, "x": x, "y": y})
        except Exception:
            continue
    return out


# ----------------------------------------------------------------------------
# Text
# ----------------------------------------------------------------------------

def _device_affine(page: pdfium.PdfPage, width: float, height: float):
    """Page space → page px as (a, b, c, d, e, f): x' = a·x + c·y + e."""
    scale = 1000
    sx, sy = int(round(width * scale)), int(round(height * scale))
    x = ctypes.c_int()
    y = ctypes.c_int()

    def to_device(px: float, py: float) -> tuple[float, float]:
        raw.FPDF_PageToDevice(page, 0, 0, sx, sy, 0, px, py, x, y)
        return x.value / scale, y.value / scale

    ox, oy = to_device(0, 0)
    ax, ay = to_device(100, 0)
    bx, by = to_device(0, 100)
    return ((ax - ox) / 100, (ay - oy) / 100, (bx - ox) / 100, (by - oy) / 100, ox, oy)


def _is_rtl(text: str) -> bool:
    strong = [unicodedata.bidirectional(ch) for ch in text]
    rtl = sum(1 for c in strong if c in ("R", "AL"))
    ltr = sum(1 for c in strong if c == "L")
    return rtl > ltr


def _direction(boxed: list[tuple]) -> int:
    """Dominant advance direction of a line: 0 → +x, 1 → +y, 2 → −x, 3 → −y."""
    if len(boxed) < 2:
        return 0
    votes = [0, 0, 0, 0]
    for (_, ax0, ay0, ax1, ay1), (_, bx0, by0, bx1, by1) in zip(boxed, boxed[1:]):
        dx = (bx0 + bx1) / 2 - (ax0 + ax1) / 2
        dy = (by0 + by1) / 2 - (ay0 + ay1) / 2
        if abs(dx) >= abs(dy):
            votes[0 if dx >= 0 else 2] += 1
        else:
            votes[1 if dy >= 0 else 3] += 1
    return max(range(4), key=lambda k: votes[k])


def _to_local(direction: int, box: tuple[float, float, float, float]):
    """Rotate a device box into a frame where the line advances along +x."""
    x0, y0, x1, y1 = box
    if direction == 0:
        return x0, y0, x1, y1
    if direction == 1:   # advancing down the page: local x = y, local y = −x
        return y0, -x1, y1, -x0
    if direction == 2:   # upside down
        return -x1, -y1, -x0, -y0
    return -y1, x0, -y0, x1  # advancing up the page


def _from_local(direction: int, x: float, y: float) -> tuple[float, float]:
    if direction == 0:
        return x, y
    if direction == 1:
        return -y, x
    if direction == 2:
        return -x, -y
    return y, -x


def _build_line(chars: list[tuple]) -> list[dict]:
    """One PDFium line → one or more positioned lines of segments."""
    boxed = [c for c in chars if c[1] is not None]
    if not boxed:
        return []
    text_all = "".join(c[0] for c in chars)
    rtl = _is_rtl(text_all)
    direction = 0 if rtl else _direction(boxed)

    out: list[dict] = []
    segments: list[dict] = []
    current: dict | None = None
    pending_space = False
    heights: list[float] = []
    tops: list[float] = []

    def flush_line() -> None:
        nonlocal segments, current, heights, tops, pending_space
        if current is not None:
            segments.append(current)
            current = None
        if segments:
            height = statistics.median(heights)
            top = statistics.median(tops)
            x0 = segments[0]["x0"]
            ox, oy = _from_local(direction, x0, top)
            out.append({
                "x": ox, "y": oy, "h": height, "dir": direction,
                "segs": [{"t": s["t"], "w": s["x1"] - s["x0"], "gap": s["gap"], "sp": s["sp"]} for s in segments],
            })
        segments, heights, tops, pending_space = [], [], [], False

    if rtl:
        # Logical order with decreasing x: fit the whole line as one segment.
        x0 = min(c[1] for c in boxed)
        x1 = max(c[3] for c in boxed)
        y0 = statistics.median(c[2] for c in boxed)
        height = statistics.median(c[4] - c[2] for c in boxed)
        return [{"x": x0, "y": y0, "h": height, "dir": 0, "rtl": True,
                 "segs": [{"t": text_all.strip(), "w": x1 - x0, "gap": 0.0, "sp": False}]}]

    last_x0 = last_x1 = 0.0
    for ch in chars:
        if ch[1] is None:
            pending_space = current is not None or bool(segments)
            continue
        lx0, ly0, lx1, ly1 = _to_local(direction, ch[1:5])
        h = max(0.5, ly1 - ly0)
        if current is not None or segments:
            line_h = statistics.median(heights)
            centre = (ly0 + ly1) / 2
            line_centre = statistics.median(tops) + line_h / 2
            gap = lx0 - last_x1
            # PDFium expands a ligature into characters that share one box,
            # so a character starting inside the previous box is no jump back.
            behind = lx0 < last_x0 - 0.5 * max(line_h, h)
            if abs(centre - line_centre) > LINE_DRIFT_EM * max(line_h, h) or behind:
                flush_line()
            elif gap > SEGMENT_GAP_EM * line_h:
                if current is not None:
                    segments.append(current)
                current = {"t": "", "x0": lx0, "x1": lx1, "gap": gap, "sp": pending_space}
                pending_space = False
        if current is None:
            current = {"t": "", "x0": lx0, "x1": lx1, "gap": 0.0, "sp": False}
            pending_space = False
        if pending_space:
            current["t"] += " "
            pending_space = False
        current["t"] += ch[0]
        current["x1"] = max(current["x1"], lx1)
        last_x0, last_x1 = lx0, max(lx1, last_x1) if lx0 < last_x1 else lx1
        heights.append(h)
        tops.append(ly0)
    flush_line()
    return out


def page_text(path: str, index: int) -> list[dict]:
    """Positioned text lines of one page (see the module docstring)."""
    pdf = open_document(path)
    page = pdf[index]
    try:
        width, height = page.get_size()
        a, b, c, d, e, f = _device_affine(page, width, height)
        textpage = page.get_textpage()
        try:
            count = raw.FPDFText_CountChars(textpage)
            rect = raw.FS_RECTF()
            lines: list[dict] = []
            chars: list[tuple] = []
            for i in range(count):
                code = raw.FPDFText_GetUnicode(textpage, i)
                if code in (0x0A, 0x0D):
                    if chars:
                        lines.extend(_build_line(chars))
                        chars = []
                    continue
                if code == 0xFFFE or code == 0x02:
                    code = 0x2D  # PDFium's marker for a line-end hyphen
                if code < 0x20 or code == 0xFFFF or 0xD800 <= code <= 0xDFFF:
                    if code == 0x09:
                        chars.append((" ", None))
                    continue
                ch = chr(code)
                if ch.isspace():
                    chars.append((" ", None))
                    continue
                if not raw.FPDFText_GetLooseCharBox(textpage, i, rect) or rect.right <= rect.left or rect.top <= rect.bottom:
                    # No usable box: keep the character in the text flow.
                    if chars and chars[-1][1] is not None:
                        last = chars[-1]
                        chars[-1] = (last[0] + ch,) + last[1:]
                    continue
                xs = (a * rect.left + c * rect.bottom + e, a * rect.right + c * rect.top + e)
                ys = (b * rect.left + d * rect.bottom + f, b * rect.right + d * rect.top + f)
                chars.append((ch, min(xs), min(ys), max(xs), max(ys)))
            if chars:
                lines.extend(_build_line(chars))
            return lines
        finally:
            textpage.close()
    finally:
        page.close()


def pages_text(path: str, start: int, stop: int) -> list[list[dict]]:
    """Text of pages [start, stop). A page that fails yields an empty list."""
    out = []
    for index in range(start, stop):
        try:
            out.append(page_text(path, index))
        except Exception:
            out.append([])
    return out


# ----------------------------------------------------------------------------
# Rasters
# ----------------------------------------------------------------------------

def render_png(path: str, index: int, width_px: int) -> bytes:
    """One page, annotations and forms drawn as Chrome's viewer draws them."""
    pdf = open_document(path)
    page = pdf[index]
    try:
        page_width, _ = page.get_size()
        scale = width_px / page_width
        try:
            pdf.init_forms()
        except Exception:
            pass
        bitmap = page.render(scale=scale, may_draw_forms=True)
        try:
            image = bitmap.to_pil()
            buffer = io.BytesIO()
            image.save(buffer, format="PNG", compress_level=1)
            return buffer.getvalue()
        finally:
            bitmap.close()
    finally:
        page.close()

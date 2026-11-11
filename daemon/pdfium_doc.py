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
import re
import os
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
TEXT_LAYER_VERSION = 4

# The text layer is laid out in a fallback font and fitted to each segment's
# width. The closer the fallback's proportions are to the document's font, the
# closer a highlight sits to the glyphs inside a line, so each line names a
# generic family and style. PDF font flags are unreliable (TeX fonts rarely
# set "serif"), so the font's name decides first.
_MONO_RE = re.compile(r"mono|courier|cmtt|sftt|lmtt|consol|menlo|typewriter|inconsolata|firacode|sourcecode", re.I)
_SERIF_RE = re.compile(
    r"times|nimbusrom|cmr\d|cmbx|cmti|cmsl|cmmi|cmsy|cmex|sfrm|sfbx|sfti|sfrb|sfsl|lmroman|lmr\d|serif|georgia|garamond"
    r"|minion|palatin|bookman|charter|utopia|cambria|caslon|baskerv|libertine|stix|century|didot|bodoni|mtsy|mtmi", re.I)
_SANS_RE = re.compile(r"sans|helvet|arial|myriad|calibri|verdana|tahoma|gothic|grotesk|roboto|inter\b|cmss|sfss|lmsans", re.I)
_BOLD_RE = re.compile(r"bold|black|heavy|cmbx|sfbx|sfrb|demi|medi$", re.I)
_ITALIC_RE = re.compile(r"ital|obli|cmti|cmsl|cmmi|sfti|sfsl|-it$", re.I)


def font_style(name: str, flags: int, weight: int) -> str:
    """Fallback font for a PDF font: letters from "m" (monospace), "s" (serif),
    "b" (bold) and "i" (italic); the empty string is upright sans-serif."""
    out = ""
    if _MONO_RE.search(name) or flags & 1:
        out += "m"
    elif _SANS_RE.search(name):
        pass
    elif _SERIF_RE.search(name) or flags & 2:
        out += "s"
    if weight >= 600 or _BOLD_RE.search(name):
        out += "b"
    if flags & 64 or _ITALIC_RE.search(name):
        out += "i"
    return out


@functools.lru_cache(maxsize=6)
def _open(path: str, mtime_ns: int, size: int) -> pdfium.PdfDocument:
    del mtime_ns, size  # cache key only: a replaced file is reopened
    return pdfium.PdfDocument(path)


def _doc_key(path: str) -> tuple[str, int, int]:
    stat = os.stat(path)
    return path, stat.st_mtime_ns, stat.st_size


def open_document(path: str) -> pdfium.PdfDocument:
    return _open(*_doc_key(path))


@functools.lru_cache(maxsize=6)
def _affines(path: str, mtime_ns: int, size: int) -> dict[int, tuple]:
    """Page index → page-space-to-page-px affine, per document and worker.

    A link's target page must be loaded to get its transform, and loading
    a page parses its content, so every transform is computed once."""
    del path, mtime_ns, size
    return {}


def _page_affine(key: tuple[str, int, int], index: int, page: pdfium.PdfPage | None = None) -> tuple:
    cache = _affines(*key)
    affine = cache.get(index)
    if affine is None:
        if page is not None:
            affine = _device_affine(page, *page.get_size())
        else:
            target = _open(*key)[index]
            try:
                affine = _device_affine(target, *target.get_size())
            finally:
                target.close()
        cache[index] = affine
    return affine


def page_sizes(path: str) -> list[tuple[float, float]]:
    pdf = open_document(path)
    return [pdf.get_page_size(i) for i in range(len(pdf))]


def metadata(path: str) -> dict:
    """Document information in meta.json's keys (see scripts/extract-meta.py):
    title, author, subject, keywords, producer, creator and pages. Empty
    fields are left out."""
    pdf = open_document(path)
    out: dict = {}
    try:
        info = pdf.get_metadata_dict(skip_empty=True)
    except Exception:
        info = {}
    for source, key in (("Title", "title"), ("Author", "author"), ("Subject", "subject"),
                        ("Keywords", "keywords"), ("Producer", "producer"), ("Creator", "creator")):
        value = str(info.get(source, "")).strip()
        if value:
            out[key] = value
    out["pages"] = len(pdf)
    return out


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
    for a, b in zip(boxed, boxed[1:]):
        ax0, ay0, ax1, ay1 = a[1:5]
        bx0, by0, bx1, by1 = b[1:5]
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

    indices: list[int] = []

    def flush_line() -> None:
        nonlocal segments, current, heights, tops, pending_space, indices
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
                # The middle character names the line's font: a line often
                # starts with a variable or a bullet in another one.
                "i": indices[len(indices) // 2],
                "segs": [{"t": s["t"], "w": s["x1"] - s["x0"], "gap": s["gap"], "sp": s["sp"]} for s in segments],
            })
        segments, heights, tops, pending_space = [], [], [], False
        indices = []

    if rtl:
        # Logical order with decreasing x: fit the whole line as one segment.
        x0 = min(c[1] for c in boxed)
        x1 = max(c[3] for c in boxed)
        y0 = statistics.median(c[2] for c in boxed)
        height = statistics.median(c[4] - c[2] for c in boxed)
        return [{"x": x0, "y": y0, "h": height, "dir": 0, "rtl": True, "i": boxed[len(boxed) // 2][5],
                 "segs": [{"t": text_all.strip(), "w": x1 - x0, "gap": 0.0, "sp": False}]}]

    # The hot loop of text extraction. Comparisons stand in for max() and
    # min() with the same results (`b if b > a else a` is max(a, b)).
    last_x0 = last_x1 = 0.0
    line_h = line_top = 0.0
    median = statistics.median
    for ch in chars:
        if ch[1] is None:
            pending_space = current is not None or bool(segments)
            continue
        if direction == 0:
            lx0, ly0, lx1, ly1 = ch[1], ch[2], ch[3], ch[4]
        else:
            lx0, ly0, lx1, ly1 = _to_local(direction, ch[1:5])
        h = ly1 - ly0
        if not h > 0.5:
            h = 0.5
        if current is not None or segments:
            # The line's height and top are medians over its characters; they
            # settle after a few, so refresh them at 1, 2, 4, 8… characters.
            count = len(heights)
            if count & (count - 1) == 0:
                line_h = median(heights)
                line_top = median(tops)
            centre = (ly0 + ly1) / 2
            line_centre = line_top + line_h / 2
            gap = lx0 - last_x1
            em = h if h > line_h else line_h
            # PDFium expands a ligature into characters that share one box,
            # so a character starting inside the previous box is no jump back.
            behind = lx0 < last_x0 - 0.5 * em
            if abs(centre - line_centre) > LINE_DRIFT_EM * em or behind:
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
        if lx1 > current["x1"]:
            current["x1"] = lx1
        if lx0 < last_x1:
            if not last_x1 > lx1:
                last_x1 = lx1
        else:
            last_x1 = lx1
        last_x0 = lx0
        heights.append(h)
        tops.append(ly0)
        indices.append(ch[5])
    flush_line()
    return out


def page_text(path: str, index: int) -> list[dict]:
    """Positioned text lines of one page (see the module docstring)."""
    key = _doc_key(path)
    page = _open(*key)[index]
    try:
        return _page_lines(page, _page_affine(key, index, page))
    finally:
        page.close()


def _page_lines(page: pdfium.PdfPage, affine: tuple) -> list[dict]:
    a, b, c, d, e, f = affine
    textpage = page.get_textpage()
    try:
        handle = textpage.raw
        get_unicode = raw.FPDFText_GetUnicode
        get_box = raw.FPDFText_GetLooseCharBox
        count = raw.FPDFText_CountChars(handle)
        rect = raw.FS_RECTF()
        lines: list[dict] = []
        chars: list[tuple] = []
        for i in range(count):
            code = get_unicode(handle, i)
            if code == 0x0A or code == 0x0D:
                if chars:
                    lines.extend(_build_line(chars))
                    chars = []
                continue
            if code == 0xFFFE or code == 0x02:
                code = 0x2D  # PDFium's marker for a line-end hyphen
            if 0xD800 <= code <= 0xDBFF and i + 1 < count:
                # PDFium hands out UTF-16 units: a character outside the
                # BMP (mathematical italics, script letters) is a
                # surrogate pair whose box is on the first unit.
                low = get_unicode(handle, i + 1)
                if 0xDC00 <= low <= 0xDFFF:
                    code = 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00)
            if code < 0x20 or code == 0xFFFF or 0xD800 <= code <= 0xDFFF:
                if code == 0x09:
                    chars.append((" ", None))
                continue
            ch = chr(code)
            if ch.isspace():
                chars.append((" ", None))
                continue
            if not get_box(handle, i, rect):
                left = right = top = bottom = 0.0
            else:
                left, bottom, right, top = rect.left, rect.bottom, rect.right, rect.top
            if right <= left or top <= bottom:
                # No usable box: keep the character in the text flow.
                if chars and chars[-1][1] is not None:
                    last = chars[-1]
                    chars[-1] = (last[0] + ch,) + last[1:]
                continue
            x0 = a * left + c * bottom + e
            x1 = a * right + c * top + e
            y0 = b * left + d * bottom + f
            y1 = b * right + d * top + f
            # min() and max() of each pair, exactly as those return them.
            if x1 < x0:
                x0, x1 = x1, x0
            elif not x1 > x0:
                x1 = x0
            if y1 < y0:
                y0, y1 = y1, y0
            elif not y1 > y0:
                y1 = y0
            chars.append((ch, x0, y0, x1, y1, i))
        if chars:
            lines.extend(_build_line(chars))
        # One font lookup per line.
        name = ctypes.create_string_buffer(256)
        flags = ctypes.c_int()
        styles: dict[tuple, str] = {}
        for line in lines:
            index = line.pop("i", -1)
            if index < 0:
                continue
            flags.value = 0
            name.value = b""
            raw.FPDFText_GetFontInfo(handle, index, name, 256, flags)
            key = (name.value, flags.value, raw.FPDFText_GetFontWeight(handle, index))
            if key not in styles:
                styles[key] = font_style(key[0].decode("utf-8", "replace"), key[1], key[2])
            if styles[key]:
                line["f"] = styles[key]
        return lines
    finally:
        textpage.close()


def pages_text(path: str, start: int, stop: int) -> list[list[dict]]:
    """Text of pages [start, stop). A page that fails yields an empty list."""
    out = []
    for index in range(start, stop):
        try:
            out.append(page_text(path, index))
        except Exception:
            out.append([])
    return out


def pages_layer(path: str, start: int, stop: int) -> list[tuple[list[dict], list[dict]]]:
    """(text lines, links) of pages [start, stop), each page loaded once.

    The same values as pages_text and pages_links; a part that fails
    yields an empty list."""
    key = _doc_key(path)
    pdf = _open(*key)
    out = []
    for index in range(start, stop):
        try:
            page = pdf[index]
        except Exception:
            out.append(([], []))
            continue
        try:
            try:
                affine = _page_affine(key, index, page)
            except Exception:
                out.append(([], []))
                continue
            try:
                lines = _page_lines(page, affine)
            except Exception:
                lines = []
            try:
                links = _page_links(pdf, key, page, affine)
            except Exception:
                links = []
            out.append((lines, links))
        finally:
            page.close()
    return out


# ----------------------------------------------------------------------------
# Links
# ----------------------------------------------------------------------------

# External link schemes the shell may emit. Anything else (javascript:,
# file:, data:, launch and remote-goto actions) is dropped.
LINK_SCHEMES = ("http", "https", "mailto")
_URI_MAX = 8192


def safe_uri(uri: str | None) -> str | None:
    """The URI when its scheme is allowed and it has no control characters."""
    if not uri:
        return None
    uri = uri.strip()
    if not uri or len(uri) > _URI_MAX or any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in uri):
        return None
    scheme, sep, rest = uri.partition(":")
    if not sep or not rest or scheme.lower() not in LINK_SCHEMES:
        return None
    return uri


def _box(affine, left: float, bottom: float, right: float, top: float) -> tuple[float, float, float, float]:
    """A page-space rectangle → its page px bounding box (x, y, w, h)."""
    a, b, c, d, e, f = affine
    xs, ys = [], []
    for px, py in ((left, bottom), (left, top), (right, bottom), (right, top)):
        xs.append(a * px + c * py + e)
        ys.append(b * px + d * py + f)
    return min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys)


def _dest_target(pdf: pdfium.PdfDocument, dest, key: tuple[str, int, int]) -> dict | None:
    """A destination → {page (1-based), x, y} in the target page's px."""
    index = raw.FPDFDest_GetDestPageIndex(pdf, dest)
    if index < 0 or index >= len(pdf):
        return None
    has_x, has_y, has_zoom = ctypes.c_int(), ctypes.c_int(), ctypes.c_int()
    x, y, zoom = ctypes.c_float(), ctypes.c_float(), ctypes.c_float()
    out = {"page": index + 1, "x": None, "y": None}
    if not raw.FPDFDest_GetLocationInPage(dest, has_x, has_y, has_zoom, x, y, zoom):
        return out
    if not (has_x.value or has_y.value):
        return out
    a, b, c, d, e, f = _page_affine(key, index)
    # A missing coordinate keeps the page edge it names: left or top.
    px = float(x.value) if has_x.value and math.isfinite(x.value) else None
    py = float(y.value) if has_y.value and math.isfinite(y.value) else None
    # The target page's own transform, so rotation and crop box apply as they
    # do to the text; for an upright page this is (x, height − y).
    if px is not None:
        dx = a * px + c * (py if py is not None else 0.0) + e
        out["x"] = max(0.0, dx)
    if py is not None:
        dy = b * (px if px is not None else 0.0) + d * py + f
        out["y"] = max(0.0, dy)
    return out


def _uri(pdf: pdfium.PdfDocument, action) -> str | None:
    size = raw.FPDFAction_GetURIPath(pdf, action, None, 0)
    if size <= 1 or size > _URI_MAX:
        return None
    buffer = ctypes.create_string_buffer(size)
    raw.FPDFAction_GetURIPath(pdf, action, buffer, size)
    return buffer.value.decode("latin-1")


def page_links(path: str, index: int) -> list[dict]:
    """Link annotations of one page: {x, y, w, h} in page px plus a target.

    The target is either "dest": {page (1-based), x, y} (page px of the
    target page, None when the destination names no position) or "uri". Links with any
    other action, a disallowed scheme or no usable rectangle are skipped.
    """
    key = _doc_key(path)
    pdf = _open(*key)
    page = pdf[index]
    try:
        return _page_links(pdf, key, page, _page_affine(key, index, page))
    finally:
        page.close()


def _page_links(pdf: pdfium.PdfDocument, key: tuple[str, int, int], page: pdfium.PdfPage,
                affine: tuple) -> list[dict]:
    out: list[dict] = []
    pos = ctypes.c_int(0)
    link = raw.FPDF_LINK()
    rect = raw.FS_RECTF()
    while raw.FPDFLink_Enumerate(page, pos, link):
        try:
            if not raw.FPDFLink_GetAnnotRect(link, rect):
                continue
            x, y, w, h = _box(affine, rect.left, rect.bottom, rect.right, rect.top)
            if not (w > 0.5 and h > 0.5) or not all(map(math.isfinite, (x, y, w, h))):
                continue
            item: dict = {"x": x, "y": y, "w": w, "h": h}
            dest = raw.FPDFLink_GetDest(pdf, link)
            if dest:
                target = _dest_target(pdf, dest, key)
                if target is None:
                    continue
                item["dest"] = target
            else:
                action = raw.FPDFLink_GetAction(link)
                if not action:
                    continue
                kind = raw.FPDFAction_GetType(action)
                if kind == raw.PDFACTION_GOTO:
                    dest = raw.FPDFAction_GetDest(pdf, action)
                    target = _dest_target(pdf, dest, key) if dest else None
                    if target is None:
                        continue
                    item["dest"] = target
                elif kind == raw.PDFACTION_URI:
                    uri = safe_uri(_uri(pdf, action))
                    if uri is None:
                        continue
                    item["uri"] = uri
                else:
                    continue
            out.append(item)
        except Exception:
            continue
    return out


def pages_links(path: str, start: int, stop: int) -> list[list[dict]]:
    """Links of pages [start, stop). A page that fails yields an empty list."""
    out = []
    for index in range(start, stop):
        try:
            out.append(page_links(path, index))
        except Exception:
            out.append([])
    return out


# ----------------------------------------------------------------------------
# Images (for the scanned-page rule in ocr.py)
# ----------------------------------------------------------------------------

def _has_image(page: pdfium.PdfPage, form) -> bool:
    for _ in page.get_objects(filter=(raw.FPDF_PAGEOBJ_IMAGE,), form=form, max_depth=4):
        return True
    return False


def page_image_coverage(path: str, index: int) -> float:
    """Share of the page area covered by images, 0–1.

    Top-level image objects count by their bounds; a form XObject that
    contains an image counts by the form's bounds (a scan is often wrapped in
    one). Overlaps are summed, so the result is capped at 1."""
    pdf = open_document(path)
    page = pdf[index]
    try:
        width, height = page.get_size()
        if width <= 0 or height <= 0:
            return 0.0
        affine = _device_affine(page, width, height)
        covered = 0.0
        for obj in page.get_objects(filter=(raw.FPDF_PAGEOBJ_IMAGE, raw.FPDF_PAGEOBJ_FORM), max_depth=0):
            if obj.type == raw.FPDF_PAGEOBJ_FORM and not _has_image(page, obj):
                continue
            try:
                left, bottom, right, top = obj.get_bounds()
            except Exception:
                continue
            x, y, w, h = _box(affine, left, bottom, right, top)
            x0, y0 = max(0.0, x), max(0.0, y)
            x1, y1 = min(width, x + w), min(height, y + h)
            if x1 > x0 and y1 > y0:
                covered += (x1 - x0) * (y1 - y0)
        return min(1.0, covered / (width * height))
    finally:
        page.close()


def pages_image_coverage(path: str, indices: list[int]) -> list[float]:
    """Image coverage of the given 0-based pages. A page that fails yields 0."""
    out = []
    for index in indices:
        try:
            out.append(page_image_coverage(path, index))
        except Exception:
            out.append(0.0)
    return out


# ----------------------------------------------------------------------------
# Rasters
# ----------------------------------------------------------------------------

def render_for_ocr(path: str, index: int, scale: float, rotation: int, out_path: str) -> dict:
    """Write one page as a grayscale PNG for text recognition.

    `scale` is device px per page px; `rotation` (0, 90, 180, 270) turns the
    image clockwise, for text that reads sideways on the page. Annotations are drawn, forms are not. Returns
    the page size in page px and, for rotation 0, the page's own text lines
    (ocr.py drops recognized lines that repeat them)."""
    pdf = open_document(path)
    page = pdf[index]
    try:
        page_width, page_height = page.get_size()
        bitmap = page.render(scale=scale, rotation=rotation, grayscale=True,
                             may_draw_forms=False)
        try:
            bitmap.to_pil().save(out_path, format="PNG", compress_level=1)
        finally:
            bitmap.close()
    finally:
        page.close()
    return {"w": page_width, "h": page_height,
            "lines": page_text(path, index) if rotation == 0 else None}


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

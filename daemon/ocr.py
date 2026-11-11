"""On-device text recognition for scanned pages (Apple Vision).

A scanned page has no text objects, so PDFium gives the reader no text layer
and nothing on it can be selected, copied or found. This module recognizes
the text in the page image and returns it in the reader's line format
(`pdfium_doc` module docstring), so the rest of the reader treats it like any
other text. See docs/reader.md, "Scanned pages".

Pieces, from pure to stateful:

- `needs_ocr`: the scanned-page rule, a function of a page's PDFium lines and
  image coverage.
- `lines_from_vision`: Vision's observations → line dicts, through
  `pdfium_doc._build_line`, so segments split at the same gaps as PDFium text.
- `recognize_page`: render (in a PDFium worker), run the Vision tool (a child
  process), build lines. A pure function of the PDF and the page.
- `OcrStore`: results on disk, `<hash>/reader/ocr/v<OCR_VERSION>/<page>.json`.
- `OcrQueue`: bounded background threads that work through pages by
  priority, so the visible page goes first and the rest of a document follows.

Vision runs in `ocr_vision.swift`, compiled once with swiftc into a tool
directory and started as a child process per page: a Vision failure costs that
process, never the daemon, and the daemon needs no Python binding for it.
Nothing leaves the machine.
"""
from __future__ import annotations

import fcntl
import hashlib
import heapq
import itertools
import json
import os
import pathlib
import platform
import shutil
import subprocess
import tempfile
import threading
import time
from typing import Callable

import pdfium_doc

# Bump when recognition or line building changes: cached results under
# another version are ignored (and can be deleted).
OCR_VERSION = 1

# The scanned-page rule. A page is scanned when images cover at least this
# share of it and its PDFium text covers less than SCAN_TEXT_AREA of it. Text
# area is the sum of segment width × line height, so a library stamp or a
# page number over a scan does not count as a text layer, while a producer's
# invisible OCR layer (render mode 3, which PDFium returns) does.
SCAN_IMAGE_COVERAGE = 0.5
SCAN_TEXT_AREA = 0.015

# Render size for recognition. Vision's accuracy was flat from 1.5 to 4 px
# per point on clean renders (docs/reader.md, "Scanned pages"); 2 px per point
# leaves a margin for real scans. Narrow pages are rendered at least
# OCR_MIN_WIDTH wide, since Vision loses small text below that.
OCR_SCALE = 2.0
OCR_MIN_WIDTH = 1600
OCR_MAX_WIDTH = 2600
OCR_MAX_PIXELS = 16_000_000

# Vision lines below this confidence are dropped (mostly texture in photos).
MIN_CONFIDENCE = 0.3
# A recognized line is dropped when this share of its box lies on PDFium text.
OVERLAP_DROP = 0.5
TOOL_TIMEOUT_S = 120

_SOURCE = pathlib.Path(__file__).with_name("ocr_vision.swift")


# ----------------------------------------------------------------------------
# The scanned-page rule
# ----------------------------------------------------------------------------

def text_area(lines: list[dict]) -> float:
    """Page px² covered by text: segment width × line height, summed."""
    return sum(seg["w"] * line["h"] for line in lines for seg in line["segs"] if seg["t"].strip())


def needs_ocr(lines: list[dict], page_w: float, page_h: float, image_coverage: float) -> bool:
    """Whether a page is a scan without a usable text layer."""
    area = page_w * page_h
    if area <= 0 or image_coverage < SCAN_IMAGE_COVERAGE:
        return False
    return text_area(lines) < SCAN_TEXT_AREA * area


def may_need_ocr(lines: list[dict], page_w: float, page_h: float) -> bool:
    """The text half of the rule. A page for which it is False has a text
    layer, so its image coverage need not be looked up."""
    area = page_w * page_h
    return area > 0 and text_area(lines) < SCAN_TEXT_AREA * area


def ocr_width(page_w: float, page_h: float) -> int:
    """Device px width at which a page is rendered for recognition."""
    width = max(OCR_MIN_WIDTH, min(OCR_MAX_WIDTH, round(page_w * OCR_SCALE)))
    if page_w > 0 and width * width * page_h / page_w > OCR_MAX_PIXELS:
        width = int((OCR_MAX_PIXELS * page_w / page_h) ** 0.5)
    return max(64, width)


# ----------------------------------------------------------------------------
# Vision observations → reader lines
# ----------------------------------------------------------------------------

def _to_page(rotation: int, page_w: float, page_h: float, u: float, v: float) -> tuple[float, float]:
    """A point of the page image turned `rotation` degrees clockwise → page px.

    Turning clockwise by 90 maps page (x, y) to image (H − y, x); by 270 to
    (y, W − x); by 180 to (W − x, H − y)."""
    if rotation == 90:
        return v, page_h - u
    if rotation == 180:
        return page_w - u, page_h - v
    if rotation == 270:
        return page_w - v, u
    return u, v


def _page_point(rotation: int, page_w: float, page_h: float, nx: float, ny: float) -> tuple[float, float]:
    """A normalized, bottom-left point of the turned image → page px."""
    frame_w, frame_h = (page_h, page_w) if rotation in (90, 270) else (page_w, page_h)
    return _to_page(rotation, page_w, page_h, nx * frame_w, (1.0 - ny) * frame_h)


def _page_box(box, rotation: int, page_w: float, page_h: float) -> tuple[float, float, float, float] | None:
    """Vision's normalized, bottom-left box → (x0, y0, x1, y1) in page px."""
    if not box or len(box) != 4:
        return None
    x, y, w, h = (float(n) for n in box)
    if not (w > 0 and h > 0):
        return None
    ax, ay = _page_point(rotation, page_w, page_h, x, y)
    bx, by = _page_point(rotation, page_w, page_h, x + w, y + h)
    return min(ax, bx), min(ay, by), max(ax, bx), max(ay, by)


def _advance(quad, rotation: int, page_w: float, page_h: float) -> int | None:
    """Direction the text of a quad advances on the page: 0 → +x, 1 → +y,
    2 → −x, 3 → −y (pdfium_doc's line directions). Vision reads sideways text
    on its own; its corners say which way it runs."""
    if not quad or len(quad) != 8:
        return None
    ax, ay = _page_point(rotation, page_w, page_h, quad[0], quad[1])
    bx, by = _page_point(rotation, page_w, page_h, quad[2], quad[3])
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return None
    if abs(dx) >= abs(dy):
        return 0 if dx > 0 else 2
    return 1 if dy > 0 else 3


def _split(box: tuple[float, float, float, float], direction: int, count: int, k: int):
    """The k-th of `count` equal slices of a box along an advance direction."""
    x0, y0, x1, y1 = box
    if direction in (0, 2):
        step = (x1 - x0) / count
        a = x0 + k * step if direction == 0 else x1 - (k + 1) * step
        return a, y0, a + step, y1
    step = (y1 - y0) / count
    a = y0 + k * step if direction == 1 else y1 - (k + 1) * step
    return x0, a, x1, a + step


def _line_chars(observation: dict, rotation: int, page_w: float, page_h: float) -> list[tuple] | None:
    """Characters of one Vision line as pdfium_doc._build_line takes them:
    (ch, x0, y0, x1, y1, index) in page px, spaces as (" ", None). Each word's
    box is shared out evenly among its characters along the way the text
    runs; without usable word boxes, the line's box is shared out among the
    line's characters, spaces taking no room."""
    line_box = _page_box(observation.get("b"), rotation, page_w, page_h)
    if line_box is None:
        return None
    direction = _advance(observation.get("q"), rotation, page_w, page_h)
    if direction is None:
        direction = 0
    along = 0 if direction in (0, 2) else 1
    line_len = line_box[2 + along] - line_box[along]
    words = [w for w in observation.get("words") or [] if w.get("t")]
    boxes = [_page_box(w.get("b"), rotation, page_w, page_h) for w in words]
    usable = bool(words) and all(b is not None for b in boxes)
    if usable and len(words) > 1:
        # Some Vision revisions answer a word range with the whole line's box.
        usable = not any(b[2 + along] - b[along] > 0.9 * line_len for b in boxes)
    chars: list[tuple] = []
    if usable:
        for i, (word, box) in enumerate(zip(words, boxes)):
            if i:
                chars.append((" ", None))
            letters = list(word["t"])
            for k, ch in enumerate(letters):
                chars.append((ch,) + _split(box, direction, len(letters), k) + (len(chars),))
        return chars
    text = " ".join(observation.get("t", "").split())
    count = sum(1 for ch in text if ch != " ")
    if not count:
        return None
    k = 0
    for ch in text:
        if ch == " ":
            chars.append((" ", None))
        else:
            chars.append((ch,) + _split(line_box, direction, count, k) + (len(chars),))
            k += 1
    return chars


def lines_from_vision(result: dict, page_w: float, page_h: float, *, rotation: int = 0,
                      min_confidence: float = MIN_CONFIDENCE) -> list[dict]:
    """One image's tool output → reader lines in page px, marked `ocr`.

    `result` is what ocr_vision.swift prints for an image of the page turned
    `rotation` degrees clockwise. Character boxes are mapped back onto the
    page and grouped by `pdfium_doc._build_line`, which picks the advance
    direction, splits segments at wide gaps and starts a new line where a
    skewed baseline drifts by more than LINE_DRIFT_EM."""
    out: list[dict] = []
    for observation in result.get("lines") or []:
        if float(observation.get("c", 1.0)) < min_confidence:
            continue
        chars = _line_chars(observation, rotation, page_w, page_h)
        if not chars:
            continue
        for line in pdfium_doc._build_line(chars):
            line.pop("i", None)
            line["ocr"] = True
            out.append(line)
    return out


def line_box(line: dict) -> tuple[float, float, float, float]:
    """A reader line's bounding box in page px (x0, y0, x1, y1)."""
    length = sum(seg.get("gap", 0.0) + seg["w"] for seg in line["segs"])
    x, y, h = line["x"], line["y"], line["h"]
    direction = line.get("dir", 0)
    if direction == 1:
        return x - h, y, x, y + length
    if direction == 2:
        return x - length, y - h, x, y
    if direction == 3:
        return x, y - length, x + h, y
    return x, y, x + length, y + h


def drop_covered(ocr_lines: list[dict], pdf_lines: list[dict]) -> list[dict]:
    """Recognized lines minus those that repeat the page's own text."""
    if not pdf_lines:
        return ocr_lines
    known = [line_box(line) for line in pdf_lines]
    out = []
    for line in ocr_lines:
        x0, y0, x1, y1 = line_box(line)
        area = max(1e-6, (x1 - x0) * (y1 - y0))
        hit = 0.0
        for a0, b0, a1, b1 in known:
            w = min(x1, a1) - max(x0, a0)
            h = min(y1, b1) - max(y0, b0)
            if w > 0 and h > 0:
                hit += w * h
        if hit / area < OVERLAP_DROP:
            out.append(line)
    return out


def char_count(lines: list[dict]) -> int:
    return sum(len(seg["t"].replace(" ", "")) for line in lines for seg in line["segs"])


# ----------------------------------------------------------------------------
# The Vision tool
# ----------------------------------------------------------------------------

def tool_dir() -> pathlib.Path:
    configured = os.environ.get("PDF_VIEWER_OCR_TOOL_DIR")
    if configured:
        return pathlib.Path(configured).expanduser()
    return pathlib.Path.home() / "Library" / "Caches" / "pdf_viewer" / "ocr-tool"


def _swiftc() -> str | None:
    # launchd's PATH may lack Xcode's; /usr/bin/swiftc is the xcrun shim.
    return shutil.which("swiftc") or ("/usr/bin/swiftc" if os.path.exists("/usr/bin/swiftc") else None)


_tool_lock = threading.Lock()
_tool_state: dict = {}


def tool_path() -> pathlib.Path | None:
    """The compiled Vision tool, built from ocr_vision.swift on first use.

    Keyed by the source's hash, so an edited source is rebuilt. None when not
    on macOS, when swiftc is missing or the build fails; the failure is kept
    for the life of the process."""
    if os.environ.get("PDF_VIEWER_OCR", "").strip().lower() in ("0", "off", "false", "no"):
        _tool_state["error"] = "turned off (PDF_VIEWER_OCR)"
        return None
    with _tool_lock:
        if "path" in _tool_state:
            return _tool_state["path"]
        _tool_state["path"] = path = _build_tool()
        return path


def unavailable_reason() -> str | None:
    """Why recognition is unavailable, or None when it is available."""
    if tool_path() is not None:
        return None
    return _tool_state.get("error") or "unavailable"


def _build_tool() -> pathlib.Path | None:
    if platform.system() != "Darwin":
        _tool_state["error"] = "on-device OCR needs macOS"
        return None
    try:
        source = _SOURCE.read_bytes()
    except OSError as error:
        _tool_state["error"] = f"no tool source: {error}"
        return None
    digest = hashlib.sha256(source).hexdigest()[:12]
    folder = tool_dir()
    target = folder / f"pdfv-ocr-{digest}"
    if os.access(target, os.X_OK):
        return target
    swiftc = _swiftc()
    if swiftc is None:
        _tool_state["error"] = "swiftc not found (install the Xcode Command Line Tools)"
        return None
    try:
        folder.mkdir(parents=True, exist_ok=True)
        with open(folder / ".build.lock", "w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            if os.access(target, os.X_OK):
                return target
            tmp = folder / f".pdfv-ocr-{digest}.{os.getpid()}"
            env = dict(os.environ)
            env["PATH"] = env.get("PATH", "") + ":/usr/bin:/bin"
            done = subprocess.run([swiftc, "-O", "-o", str(tmp), str(_SOURCE)], capture_output=True,
                                  text=True, timeout=300, env=env)
            if done.returncode != 0 or not tmp.exists():
                _tool_state["error"] = "swiftc failed: " + (done.stderr or done.stdout).strip()[-400:]
                tmp.unlink(missing_ok=True)
                return None
            tmp.replace(target)
            for old in folder.glob("pdfv-ocr-*"):
                if old != target:
                    old.unlink(missing_ok=True)
            return target
    except (OSError, subprocess.SubprocessError) as error:
        _tool_state["error"] = f"could not build the OCR tool: {error}"
        return None


def run_tool(tool: pathlib.Path, image: str, *, background: bool = False,
             timeout: float = TOOL_TIMEOUT_S) -> dict:
    """Recognize one image. Background work runs at utility QoS, so it keeps
    to the efficiency cores while the visible page's work does not."""
    command = [str(tool), image]
    if background and os.path.exists("/usr/sbin/taskpolicy"):
        command = ["/usr/sbin/taskpolicy", "-c", "utility"] + command
    done = subprocess.run(command, capture_output=True, text=True, timeout=timeout)
    if done.returncode != 0:
        raise RuntimeError(f"OCR tool exited {done.returncode}: {done.stderr.strip()[-200:]}")
    first = done.stdout.splitlines()[0] if done.stdout else "{}"
    result = json.loads(first)
    if "error" in result:
        raise RuntimeError(f"OCR tool: {result['error']}")
    return result


# ----------------------------------------------------------------------------
# One page
# ----------------------------------------------------------------------------

def recognize_page(path: str, index: int, page_w: float, page_h: float, *, tool: pathlib.Path,
                   render: Callable[..., dict] = pdfium_doc.render_for_ocr,
                   background: bool = False) -> dict:
    """Recognized text of one 0-based page: {"lines", "width", "ms"}.

    `page_w` and `page_h` are the page size in page px. `render(path, index,
    scale, rotation, out_path)` writes the page image (pdfium_doc.render_for_ocr);
    the daemon passes one that runs in its PDFium worker pool. The page is
    rendered upright as it displays (its /Rotate applied): Vision's
    revision 3 reads text in all four orientations by itself, and its corner
    points give each line's direction."""
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="pdfv-ocr-") as scratch:
        image = os.path.join(scratch, "page.png")
        width = ocr_width(page_w, page_h)
        info = render(path, index, width / page_w, 0, image)
        page_w, page_h = info["w"], info["h"]
        lines = lines_from_vision(run_tool(tool, image, background=background), page_w, page_h)
        lines = drop_covered(lines, info["lines"] or [])
    return {"lines": lines, "width": width, "ms": round((time.monotonic() - started) * 1000)}


# ----------------------------------------------------------------------------
# Results on disk
# ----------------------------------------------------------------------------

class OcrStore:
    """Recognized pages of one cache entry, `<entry>/reader/ocr/v<N>/<page>.json`.

    A page's file is written once, atomically, and never redone while
    OCR_VERSION stays the same. Other versions' folders are ignored."""

    def __init__(self, reader_dir: pathlib.Path, version: int | None = None):
        self.dir = reader_dir / "ocr" / f"v{OCR_VERSION if version is None else version}"

    def path(self, page: int) -> pathlib.Path:
        return self.dir / f"{page}.json"

    def has(self, page: int) -> bool:
        return self.path(page).is_file()

    def get(self, page: int) -> dict | None:
        try:
            return json.loads(self.path(page).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def put(self, page: int, result: dict) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        path = self.path(page)
        tmp = path.with_suffix(f".{os.getpid()}.{threading.get_ident()}.tmp")
        tmp.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        tmp.replace(path)


# ----------------------------------------------------------------------------
# Scheduling
# ----------------------------------------------------------------------------

# Priorities: a page someone is waiting for goes before the rest of its
# document, which is worked through in page order.
VISIBLE = 0
BACKGROUND = 1


class OcrQueue:
    """Bounded worker threads that recognize pages in priority order.

    `run(key, page, background)` does one page and stores its result; the
    queue only orders the work, remembers what is done or failed in this
    process, and lets callers wait. A page asked for again at a higher
    priority moves up; a page that is done or running is never queued again.
    """

    def __init__(self, run: Callable[[str, int, bool], None], workers: int = 2):
        self._run = run
        self._workers = workers
        self._heap: list[tuple[int, int, str, int]] = []
        self._priority: dict[tuple[str, int], int] = {}
        self._running: set[tuple[str, int]] = set()
        self._done: set[tuple[str, int]] = set()
        self.failed: dict[tuple[str, int], str] = {}
        self._seq = itertools.count()
        self._cond = threading.Condition()
        self._threads: list[threading.Thread] = []

    def _start(self) -> None:
        while len(self._threads) < self._workers:
            thread = threading.Thread(target=self._loop, name=f"ocr-{len(self._threads)}", daemon=True)
            self._threads.append(thread)
            thread.start()

    def submit(self, key: str, pages, priority: int) -> None:
        with self._cond:
            for page in pages:
                job = (key, page)
                if job in self._done or job in self._running or job in self.failed:
                    continue
                if self._priority.get(job, 1 << 30) <= priority:
                    continue
                self._priority[job] = priority
                heapq.heappush(self._heap, (priority, next(self._seq), key, page))
            self._start()
            self._cond.notify_all()

    def mark_done(self, key: str, page: int) -> None:
        with self._cond:
            self._done.add((key, page))

    def state(self, key: str, page: int) -> str:
        with self._cond:
            job = (key, page)
            if job in self._done:
                return "done"
            if job in self.failed:
                return "failed"
            if job in self._running or job in self._priority:
                return "pending"
            return "idle"

    def wait(self, key: str, pages, timeout: float) -> None:
        """Until every page is done or failed, or the timeout passes."""
        deadline = time.monotonic() + timeout
        jobs = [(key, page) for page in pages]
        with self._cond:
            while True:
                if all(job in self._done or job in self.failed for job in jobs):
                    return
                left = deadline - time.monotonic()
                if left <= 0:
                    return
                self._cond.wait(left)

    def forget(self, key: str) -> None:
        """Drop queued work and memory for a document (its entry was deleted)."""
        with self._cond:
            self._heap = [item for item in self._heap if item[2] != key]
            heapq.heapify(self._heap)
            for table in (self._priority, self.failed):
                for job in [job for job in table if job[0] == key]:
                    del table[job]
            self._done = {job for job in self._done if job[0] != key}

    def _loop(self) -> None:
        while True:
            with self._cond:
                while True:
                    while self._heap:
                        priority, _seq, key, page = self._heap[0]
                        job = (key, page)
                        if self._priority.get(job) != priority:
                            heapq.heappop(self._heap)  # superseded or forgotten
                            continue
                        break
                    if self._heap:
                        break
                    self._cond.wait()
                priority, _seq, key, page = heapq.heappop(self._heap)
                job = (key, page)
                del self._priority[job]
                self._running.add(job)
            error = None
            try:
                self._run(key, page, priority > VISIBLE)
            except Exception as exc:  # one page failing must not stop the queue
                error = f"{type(exc).__name__}: {exc}"[:300]
            with self._cond:
                self._running.discard(job)
                if error is None:
                    self._done.add(job)
                else:
                    self.failed[job] = error
                self._cond.notify_all()

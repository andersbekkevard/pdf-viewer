"""PDFium reference side of the reader bench, run as `python -I pdfium_ref.py <mode> <pdf> <spec.json>`.

Corpus PDFs are untrusted, so the bench never opens them in its own process:
each call is a separate isolated interpreter with a time limit set by the
caller (the same rule as bench/corpus/probe/pdfium_worker.py).

Modes (each prints one JSON object on stdout):

  info <pdf> <spec>
      Page count and page sizes (PDF points after rotation, as the reader's
      `.pf` frames are sized).

  text <pdf> <spec>     spec: {"pages": [1-based], "words": 8}
      For each page: PDFium's get_text_range() text, the number of chars,
      and up to `words` sampled words with the union of their loose
      character boxes in top-left page px (rotation applied with
      FPDF_PageToDevice, as daemon/pdfium_doc.py does). The text leaves this
      process only on stdout to the driver, which never writes it to disk.

  compare <pdf> <spec>  spec: {"jobs": [{page, shot, scale, artifacts}], "dark", "radius", "save"}
      Render each page at `scale` device px per point and compare it with the
      reader screenshot with bench/corpus/probe/pdfium_worker.py's
      ink_compare (imported, not copied), so the numbers are those of the
      stored `visual-diff-high` class.
"""
from __future__ import annotations

import ctypes
import json
import pathlib
import re
import sys
import time

HERE = pathlib.Path(__file__).resolve().parent
PROBE_DIR = HERE.parent / "corpus" / "probe"
sys.path.insert(0, str(PROBE_DIR))

WORD_RE = re.compile(r"[^\W\d_]{5,}")


def open_doc(path):
    import pypdfium2 as pdfium
    doc = pdfium.PdfDocument(path)
    try:
        doc.init_forms()
    except Exception:
        pass
    return doc


def mode_info(pdf: str, spec: dict) -> dict:
    t0 = time.perf_counter()
    try:
        doc = open_doc(pdf)
    except Exception as exc:
        return {"open_error": f"{type(exc).__name__}: {exc}"[:300]}
    sizes, errors = [], []
    for i in range(len(doc)):
        try:
            sizes.append([round(v, 3) for v in doc.get_page_size(i)])
        except Exception as exc:
            errors.append(f"page {i + 1}: {exc}"[:200])
            sizes.append([0.0, 0.0])
    out = {"pages": len(doc), "page_sizes": sizes, "errors": errors,
           "ms": round((time.perf_counter() - t0) * 1000, 1)}
    doc.close()
    return out


def device_affine(page, width: float, height: float):
    """Page space → top-left page px, mirroring daemon/pdfium_doc.py::_device_affine."""
    import pypdfium2.raw as raw
    scale = 1000
    sx, sy = int(round(width * scale)), int(round(height * scale))
    x, y = ctypes.c_int(), ctypes.c_int()

    def to_device(px, py):
        raw.FPDF_PageToDevice(page, 0, 0, sx, sy, 0, px, py, x, y)
        return x.value / scale, y.value / scale

    ox, oy = to_device(0, 0)
    ax, ay = to_device(100, 0)
    bx, by = to_device(0, 100)
    return ((ax - ox) / 100, (ay - oy) / 100, (bx - ox) / 100, (by - oy) / 100, ox, oy)


def sample_words(chars: str, limit: int) -> list[tuple[str, int]]:
    """Distinct letter-only words of ≥5 letters that occur exactly once in the
    page's character string (as a case-sensitive substring, so the first
    window.find hit on the page is this occurrence). Up to `limit`, spread
    evenly over the page in reading order."""
    seen, cands = set(), []
    for m in WORD_RE.finditer(chars):
        w = m.group(0)
        if w in seen:
            continue
        seen.add(w)
        if chars.count(w) == 1:
            cands.append((w, m.start()))
    if len(cands) <= limit:
        return cands
    step = len(cands) / limit
    return [cands[int(i * step)] for i in range(limit)]


def mode_text(pdf: str, spec: dict) -> dict:
    import pypdfium2.raw as raw
    try:
        doc = open_doc(pdf)
    except Exception as exc:
        return {"open_error": f"{type(exc).__name__}: {exc}"[:300]}
    out = []
    for n in spec["pages"]:
        entry = {"page": n}
        try:
            page = doc[n - 1]
            width, height = page.get_size()
            a, b, c, d, e, f = device_affine(page, width, height)
            tp = page.get_textpage()
            entry["text"] = tp.get_text_range()
            count = raw.FPDFText_CountChars(tp)
            entry["count"] = count
            # One string position per PDFium char index (generated \r\n included),
            # so a word's string offsets are its char indices.
            chars = []
            for i in range(count):
                code = raw.FPDFText_GetUnicode(tp, i)
                chars.append(chr(code) if 0 < code < 0x110000 and not 0xD800 <= code <= 0xDFFF else "�")
            chars = "".join(chars)
            rect = raw.FS_RECTF()

            def word_boxes(start, length):
                boxes = []
                for i in range(start, start + length):
                    if not raw.FPDFText_GetLooseCharBox(tp, i, rect) or rect.right <= rect.left or rect.top <= rect.bottom:
                        continue
                    xs = (a * rect.left + c * rect.bottom + e, a * rect.right + c * rect.top + e)
                    ys = (b * rect.left + d * rect.bottom + f, b * rect.right + d * rect.top + f)
                    boxes.append([min(xs), min(ys), max(xs), max(ys)])
                return boxes

            def on_page(boxes):
                # Every box inside the page (1 px tolerance): off-page text
                # objects are invisible, so their highlight geometry is moot.
                return bool(boxes) and all(x0 >= -1 and y0 >= -1 and x1 <= width + 1 and y1 <= height + 1
                                           for x0, y0, x1, y1 in boxes)

            limit = spec.get("words", 8)
            words, offpage = [], 0
            for w, start in sample_words(chars, 10_000):
                boxes = word_boxes(start, len(w))
                if on_page(boxes):
                    words.append({"word": w, "boxes": boxes})
                else:
                    offpage += 1
            if len(words) > limit:
                step = len(words) / limit
                words = [words[int(i * step)] for i in range(limit)]
            entry["words"] = words
            entry["offpage_candidates"] = offpage
            tp.close()
            page.close()
        except Exception as exc:
            entry["error"] = f"{type(exc).__name__}: {exc}"[:300]
        out.append(entry)
    doc.close()
    return {"pages": out}


def mode_compare(pdf: str, spec: dict) -> dict:
    import numpy as np
    from PIL import Image
    from pdfium_worker import ink_compare, save_artifacts
    Image.MAX_IMAGE_PIXELS = 400_000_000
    try:
        doc = open_doc(pdf)
    except Exception as exc:
        return {"open_error": f"{type(exc).__name__}: {exc}"[:300]}
    results = []
    for job in spec["jobs"]:
        entry = {"page": job["page"]}
        try:
            shot = Image.open(job["shot"]).convert("RGB")
            page = doc[job["page"] - 1]
            bitmap = page.render(scale=job["scale"], may_draw_forms=True)
            ref = bitmap.to_pil().convert("RGB")
            bitmap.close()
            page.close()
            metrics, extra, missing, blocks = ink_compare(np.asarray(shot), np.asarray(ref),
                                                          spec.get("dark", 128), spec.get("radius", 2))
            entry.update(metrics)
            if job.get("artifacts"):
                prefix = pathlib.Path(job["artifacts"]) / f"p{job['page']}"
                save_artifacts(prefix, shot, ref, extra, missing, blocks)
                entry["artifacts"] = f"{prefix}-sheet.jpg"
        except Exception as exc:
            entry["error"] = f"{type(exc).__name__}: {exc}"[:300]
        results.append(entry)
    doc.close()
    return {"pages": results}


def main() -> int:
    mode, pdf, spec_path = sys.argv[1], sys.argv[2], sys.argv[3]
    spec = json.loads(pathlib.Path(spec_path).read_text())
    fn = {"info": mode_info, "text": mode_text, "compare": mode_compare}.get(mode)
    if fn is None:
        raise SystemExit(f"unknown mode {mode}")
    sys.stdout.write(json.dumps(fn(pdf, spec)) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())

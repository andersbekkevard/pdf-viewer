"""Scanned-page recognition (daemon/ocr.py).

The rule and the conversion from Vision's boxes are pure and tested without
Vision. Tests that run the Vision tool skip where it is unavailable (not
macOS, no swiftc, PDF_VIEWER_OCR=off).
"""
from __future__ import annotations

import io
import json
import os
import pathlib
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import ocr  # noqa: E402
import pdfium_doc  # noqa: E402
import reader  # noqa: E402

PAGE_W, PAGE_H = 612, 792
TEXT_LINES = [
    (72, 700, "Recognition turns pixels into words"),
    (72, 660, "Selection and find work on scans"),
    (72, 620, "Norwegian letters: blåbær og rødgrøt"),
]
# Two columns on one line: a gap far wider than a line height.
COLUMNS = ((72, 560, "Alpha"), (400, 560, "Omega"))


def _pdf(objects: list[bytes]) -> bytes:
    """A PDF whose object N (1-based) is objects[N-1], with a correct xref."""
    out = bytearray(b"%PDF-1.7\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % number + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    for offset in offsets:
        out += b"%010d 00000 n \n" % offset
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, xref)
    return bytes(out)


def _stream(data: bytes, extra: bytes = b"") -> bytes:
    return b"<< /Length %d " % len(data) + extra + b">>\nstream\n" + data + b"\nendstream"


def _text_ops(mode: int = 0) -> bytes:
    ops = [b"BT %d Tr /F1 24 Tf" % mode]
    for x, y, text in TEXT_LINES + list(COLUMNS):
        ops.append(b"1 0 0 1 %d %d Tm (%s) Tj" % (x, y, text.encode("latin-1")))
    ops.append(b"ET")
    return b"\n".join(ops)


FONT = b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"


def text_pdf() -> bytes:
    """A born-digital page: visible Helvetica text, no images."""
    return _pdf([
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R "
        b"/Resources << /Font << /F1 5 0 R >> >> >>",
        _stream(_text_ops()),
        FONT,
    ])


def scan_image(pdf_bytes: bytes, dpi: int = 150, rotate: int = 0):
    """The page rendered to a grayscale image, as a scanner would see it."""
    with tempfile.NamedTemporaryFile(suffix=".pdf") as handle:
        handle.write(pdf_bytes)
        handle.flush()
        pdf = pdfium_doc.pdfium.PdfDocument(handle.name)
        try:
            page = pdf[0]
            image = page.render(scale=dpi / 72, grayscale=True, rotation=rotate).to_pil()
            page.close()
        finally:
            pdf.close()
    return image


def pillow_scan_pdf(image, dpi: int = 150) -> bytes:
    """A scanned page as an image-to-PDF tool writes it (Pillow's writer)."""
    buffer = io.BytesIO()
    image.save(buffer, format="PDF", resolution=dpi)
    return buffer.getvalue()


def scan_with_invisible_text_pdf(image) -> bytes:
    """A scan with a producer's OCR layer: the image plus render-mode-3 text."""
    jpeg = io.BytesIO()
    image.save(jpeg, format="JPEG", quality=85)
    data = jpeg.getvalue()
    content = b"q 612 0 0 792 0 0 cm /Im1 Do Q\n" + _text_ops(mode=3)
    return _pdf([
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R "
        b"/Resources << /Font << /F1 5 0 R >> /XObject << /Im1 6 0 R >> >> >>",
        _stream(content),
        FONT,
        _stream(data, b"/Type /XObject /Subtype /Image /Width %d /Height %d /ColorSpace /DeviceGray "
                b"/BitsPerComponent 8 /Filter /DCTDecode " % image.size),
    ])


def blank_pdf() -> bytes:
    return _pdf([
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
    ])


class Fixtures:
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        root = pathlib.Path(cls.temp.name)
        text = text_pdf()
        image = scan_image(text)
        cls.paths = {}
        for name, data in (("text", text), ("scan", pillow_scan_pdf(image)),
                           ("invisible", scan_with_invisible_text_pdf(image)), ("blank", blank_pdf()),
                           ("sideways", pillow_scan_pdf(scan_image(text, rotate=270)))):
            path = root / f"{name}.pdf"
            path.write_bytes(data)
            cls.paths[name] = str(path)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def rule(self, name: str) -> bool:
        path = self.paths[name]
        width, height = pdfium_doc.page_sizes(path)[0]
        return ocr.needs_ocr(pdfium_doc.page_text(path, 0), width, height,
                             pdfium_doc.page_image_coverage(path, 0))


class ScannedPageRuleTest(Fixtures, unittest.TestCase):
    def test_scan_needs_ocr(self):
        self.assertEqual(pdfium_doc.page_text(self.paths["scan"], 0), [])
        self.assertGreater(pdfium_doc.page_image_coverage(self.paths["scan"], 0), 0.95)
        self.assertTrue(self.rule("scan"))

    def test_born_digital_page_does_not(self):
        self.assertEqual(pdfium_doc.page_image_coverage(self.paths["text"], 0), 0.0)
        self.assertFalse(self.rule("text"))

    def test_invisible_ocr_layer_is_left_alone(self):
        lines = pdfium_doc.page_text(self.paths["invisible"], 0)
        self.assertTrue(any("Recognition" in seg["t"] for line in lines for seg in line["segs"]))
        self.assertGreater(pdfium_doc.page_image_coverage(self.paths["invisible"], 0), 0.95)
        self.assertFalse(self.rule("invisible"))

    def test_blank_page_does_not(self):
        self.assertFalse(self.rule("blank"))

    def test_stamp_over_scan_still_needs_ocr(self):
        stamp = [{"x": 10, "y": 780, "h": 8, "dir": 0,
                  "segs": [{"t": "Downloaded from somewhere on some date", "w": 160, "gap": 0, "sp": False}]}]
        self.assertTrue(ocr.needs_ocr(stamp, PAGE_W, PAGE_H, 1.0))
        self.assertFalse(ocr.needs_ocr(stamp, PAGE_W, PAGE_H, 0.3))

    def test_shell_marks_only_the_scan(self):
        with tempfile.TemporaryDirectory() as cache:
            r = reader.Reader(pathlib.Path(cache), workers=2)
            try:
                for name, marked in (("scan", True), ("text", False), ("invisible", False)):
                    hash_ = f"{name:0<16}"[:16]
                    (pathlib.Path(cache) / hash_).mkdir()
                    shell = r.shell(hash_, pathlib.Path(self.paths[name]), name).read_text()
                    self.assertEqual('data-reader-ocr="pending"' in shell, marked, name)
                    self.assertEqual(r.ocr_pages(hash_, pathlib.Path(self.paths[name]), name), [1] if marked else [])
            finally:
                if r._pool is not None:
                    r._pool.shutdown()

    def test_ocr_width(self):
        self.assertEqual(ocr.ocr_width(612, 792), ocr.OCR_MIN_WIDTH)
        self.assertEqual(ocr.ocr_width(1053, 1404), 2106)
        self.assertEqual(ocr.ocr_width(1404, 1889), ocr.OCR_MAX_WIDTH)
        tall = ocr.ocr_width(1215, 6531)
        self.assertLessEqual(tall * tall * 6531 / 1215, ocr.OCR_MAX_PIXELS)


def upright(box):
    """The corners of an upright box: top-left, top-right, bottom-right, bottom-left."""
    x, y, w, h = box
    return [x, y + h, x + w, y + h, x + w, y, x, y]


def vision_line(text, box, words=None, confidence=1.0):
    """A tool output line. Boxes are normalized with a bottom-left origin."""
    words = words if words is not None else [{"t": text, "b": box}]
    for word in words:
        if word.get("b") and "q" not in word:
            word["q"] = upright(word["b"])
    return {"t": text, "c": confidence, "b": box, "q": upright(box), "words": words}


def norm(x, y, w, h, page_w=PAGE_W, page_h=PAGE_H):
    """Page px (top-left origin) → Vision's normalized bottom-left box."""
    return [x / page_w, 1 - (y + h) / page_h, w / page_w, h / page_h]


class LinesFromVisionTest(unittest.TestCase):
    def test_one_line_maps_to_page_px(self):
        result = {"lines": [vision_line("Hello world", norm(100, 200, 110, 20),
                                        [{"t": "Hello", "b": norm(100, 200, 50, 20)},
                                         {"t": "world", "b": norm(160, 200, 50, 20)}])]}
        lines = ocr.lines_from_vision(result, PAGE_W, PAGE_H)
        self.assertEqual(len(lines), 1)
        line = lines[0]
        self.assertTrue(line["ocr"])
        self.assertNotIn("i", line)
        self.assertEqual(line["dir"], 0)
        self.assertAlmostEqual(line["x"], 100, places=3)
        self.assertAlmostEqual(line["y"], 200, places=3)
        self.assertAlmostEqual(line["h"], 20, places=3)
        self.assertEqual([s["t"] for s in line["segs"]], ["Hello world"])
        self.assertAlmostEqual(line["segs"][0]["w"], 110, places=3)

    def test_wide_gap_splits_segments_like_pdfium(self):
        words = [{"t": "Name", "b": norm(72, 300, 48, 12)},
                 {"t": "Value", "b": norm(400, 300, 50, 12)}]
        result = {"lines": [vision_line("Name Value", norm(72, 300, 378, 12), words)]}
        (line,) = ocr.lines_from_vision(result, PAGE_W, PAGE_H)
        self.assertEqual([s["t"] for s in line["segs"]], ["Name", "Value"])
        self.assertAlmostEqual(line["segs"][1]["gap"], 400 - 120, places=3)
        self.assertTrue(line["segs"][1]["sp"])
        html = reader._line_html(line)
        self.assertTrue(html.startswith('<div class="t ocr" '))
        self.assertIn('<span class="g" style="padding-left:280px"> </span>', html)

    def test_low_confidence_lines_are_dropped(self):
        result = {"lines": [vision_line("noise", norm(10, 10, 40, 10), confidence=0.1),
                            vision_line("text", norm(10, 40, 40, 10), confidence=0.9)]}
        self.assertEqual([l["segs"][0]["t"] for l in ocr.lines_from_vision(result, PAGE_W, PAGE_H)], ["text"])

    def test_missing_word_boxes_share_out_the_line(self):
        words = [{"t": "ab", "b": None}, {"t": "cd", "b": None}]
        result = {"lines": [vision_line("ab cd", norm(0, 0, 50, 10), words)]}
        (line,) = ocr.lines_from_vision(result, PAGE_W, PAGE_H)
        self.assertEqual(line["segs"][0]["t"], "ab cd")
        self.assertAlmostEqual(line["segs"][0]["w"], 50, places=3)

    def test_whole_line_word_boxes_count_as_missing(self):
        box = norm(0, 0, 100, 10)
        words = [{"t": "ab", "b": box}, {"t": "cd", "b": box}]
        (line,) = ocr.lines_from_vision({"lines": [vision_line("ab cd", box, words)]}, PAGE_W, PAGE_H)
        self.assertEqual(line["segs"][0]["t"], "ab cd")
        self.assertAlmostEqual(line["segs"][0]["w"], 100, places=3)

    def test_quarter_turned_image_maps_back(self):
        # The page image was turned 90° clockwise to make sideways text upright.
        # In the turned image (792 wide, 612 high) a word at u=100..200,
        # v=50..70 is, on the page, a box x=50..70 running y=692 down to 592:
        # text that reads up the page.
        frame_w, frame_h = PAGE_H, PAGE_W
        box = norm(100, 50, 100, 20, frame_w, frame_h)
        result = {"lines": [vision_line("Upward", box)]}
        (line,) = ocr.lines_from_vision(result, PAGE_W, PAGE_H, rotation=90)
        self.assertEqual(line["dir"], 3)
        x0, y0, x1, y1 = ocr.line_box(line)
        self.assertAlmostEqual(x0, 50, places=2)
        self.assertAlmostEqual(x1, 70, places=2)
        self.assertAlmostEqual(y0, PAGE_H - 200, places=2)
        self.assertAlmostEqual(y1, PAGE_H - 100, places=2)

    def test_text_vision_read_sideways(self):
        # Vision reads text running up an upright image itself; its corners
        # say so. Top-left (100, 700) to top-right (100, 500) in page px.
        box = norm(100, 500, 20, 200)
        x, y, w, h = box
        quad = [x, y, x, y + h, x + w, y + h, x + w, y]  # advancing +y in Vision = up the page
        words = [{"t": "Up", "b": norm(100, 600, 20, 100), "q": [x, 1 - 700 / PAGE_H, x, 1 - 600 / PAGE_H,
                                                                 x + w, 1 - 600 / PAGE_H, x + w, 1 - 700 / PAGE_H]},
                 {"t": "here", "b": norm(100, 500, 20, 90)}]
        words[1]["q"] = [x, 1 - 590 / PAGE_H, x, 1 - 500 / PAGE_H, x + w, 1 - 500 / PAGE_H, x + w, 1 - 590 / PAGE_H]
        result = {"lines": [{"t": "Up here", "c": 1.0, "b": box, "q": quad, "words": words}]}
        (line,) = ocr.lines_from_vision(result, PAGE_W, PAGE_H)
        self.assertEqual(line["dir"], 3)
        self.assertEqual(line["segs"][0]["t"], "Up here")
        x0, y0, x1, y1 = ocr.line_box(line)
        self.assertAlmostEqual(x0, 100, places=2)
        self.assertAlmostEqual(y1, 700, places=2)
        self.assertAlmostEqual(y0, 500, places=2)
        self.assertIn("transform:rotate(-90deg)", reader._line_html(line))

    def test_skewed_baseline_starts_new_lines(self):
        # Five words stepping down 6 px each: the line drifts by more than
        # LINE_DRIFT_EM of its 10 px height and is split.
        words = [{"t": "word", "b": norm(50 + 60 * k, 100 + 6 * k, 40, 10)} for k in range(5)]
        result = {"lines": [vision_line("word word word word word", norm(50, 100, 280, 34), words)]}
        lines = ocr.lines_from_vision(result, PAGE_W, PAGE_H)
        self.assertGreater(len(lines), 1)
        for line in lines:
            self.assertAlmostEqual(line["h"], 10, places=3)

    def test_lines_repeating_page_text_are_dropped(self):
        pdf_lines = [{"x": 100, "y": 200, "h": 20, "dir": 0,
                      "segs": [{"t": "Stamp", "w": 100, "gap": 0, "sp": False}]}]
        result = {"lines": [vision_line("Stamp", norm(102, 201, 96, 18)),
                            vision_line("Body", norm(100, 400, 60, 18))]}
        lines = ocr.drop_covered(ocr.lines_from_vision(result, PAGE_W, PAGE_H), pdf_lines)
        self.assertEqual([l["segs"][0]["t"] for l in lines], ["Body"])


class StoreAndQueueTest(Fixtures, unittest.TestCase):
    """Caching and versioning with a fake tool: no Vision needed."""

    def fake_result(self):
        return {"w": 1600, "h": 2071, "lines": [vision_line("Fake text that is long enough", [0.1, 0.8, 0.3, 0.02])]}

    def make_reader(self, cache):
        r = reader.Reader(pathlib.Path(cache), workers=2)
        self.addCleanup(lambda: r._pool is not None and r._pool.shutdown())
        hash_ = "scan000000000000"
        (pathlib.Path(cache) / hash_).mkdir()
        return r, hash_, pathlib.Path(self.paths["scan"])

    def test_page_is_recognized_once_and_cached_by_version(self):
        calls = []

        def fake_tool(tool, image, background=False, timeout=0):
            calls.append(background)
            self.assertTrue(os.path.getsize(image) > 0)
            return self.fake_result()

        with tempfile.TemporaryDirectory() as cache, \
                mock.patch.object(ocr, "tool_path", return_value=pathlib.Path("/fake/tool")), \
                mock.patch.object(ocr, "unavailable_reason", return_value=None), \
                mock.patch.object(ocr, "run_tool", side_effect=fake_tool):
            r, hash_, pdf = self.make_reader(cache)
            first = r.ocr_status(hash_, pdf, "scan", [1], wait=20)
            self.assertTrue(first["available"])
            self.assertEqual((first["total"], first["done"]), (1, 1))
            page = first["pages"]["1"]
            self.assertEqual(page["state"], "done")
            self.assertIn('class="t ocr"', page["html"])
            self.assertIn("Fake text", page["html"])
            self.assertEqual(len(calls), 1)
            stored = pathlib.Path(cache) / hash_ / "reader" / "ocr" / f"v{ocr.OCR_VERSION}" / "1.json"
            self.assertEqual(json.loads(stored.read_text())["version"], ocr.OCR_VERSION)

            # A second daemon (fresh Reader) serves it from disk.
            r2 = reader.Reader(pathlib.Path(cache), workers=2)
            self.addCleanup(lambda: r2._pool is not None and r2._pool.shutdown())
            again = r2.ocr_status(hash_, pdf, "scan", [1], wait=20)
            self.assertEqual(again["pages"]["1"]["html"], page["html"])
            self.assertEqual(len(calls), 1)

            # A new OCR version ignores the old result and recognizes again.
            with mock.patch.object(ocr, "OCR_VERSION", ocr.OCR_VERSION + 1):
                r3 = reader.Reader(pathlib.Path(cache), workers=2)
                self.addCleanup(lambda: r3._pool is not None and r3._pool.shutdown())
                self.assertFalse(r3.ocr_store(hash_).has(1))
                r3.ocr_status(hash_, pdf, "scan", [1], wait=20)
                self.assertEqual(len(calls), 2)
                self.assertTrue(r3.ocr_store(hash_).has(1))

    def test_born_digital_pages_answer_none(self):
        with tempfile.TemporaryDirectory() as cache:
            r = reader.Reader(pathlib.Path(cache), workers=2)
            self.addCleanup(lambda: r._pool is not None and r._pool.shutdown())
            (pathlib.Path(cache) / "text000000000000").mkdir()
            out = r.ocr_status("text000000000000", pathlib.Path(self.paths["text"]), "t", [1], wait=5)
            self.assertEqual(out["pages"]["1"], {"state": "none"})
            self.assertEqual(out["total"], 0)

    def test_unavailable_answers_unavailable(self):
        with tempfile.TemporaryDirectory() as cache, \
                mock.patch.object(ocr, "unavailable_reason", return_value="on-device OCR needs macOS"):
            r, hash_, pdf = self.make_reader(cache)
            out = r.ocr_status(hash_, pdf, "scan", [1], wait=5)
            self.assertFalse(out["available"])
            self.assertEqual(out["reason"], "on-device OCR needs macOS")
            self.assertEqual(out["pages"]["1"], {"state": "unavailable"})
            # The shell is the same either way.
            self.assertIn('data-reader-ocr="pending"', r.shell_path(hash_).read_text())

    def test_failed_page_is_reported_not_retried(self):
        with tempfile.TemporaryDirectory() as cache, \
                mock.patch.object(ocr, "tool_path", return_value=pathlib.Path("/fake/tool")), \
                mock.patch.object(ocr, "unavailable_reason", return_value=None), \
                mock.patch.object(ocr, "run_tool", side_effect=RuntimeError("boom")) as tool:
            r, hash_, pdf = self.make_reader(cache)
            self.assertEqual(r.ocr_status(hash_, pdf, "scan", [1], wait=20)["pages"]["1"], {"state": "failed"})
            calls = tool.call_count
            self.assertEqual(r.ocr_status(hash_, pdf, "scan", [1], wait=1)["pages"]["1"], {"state": "failed"})
            self.assertEqual(tool.call_count, calls)

    def test_store_rejects_changed_source_or_text_model(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            old = ocr.OcrStore(root, stamp=["pdf", 1, 100, 4])
            old.put(1, {"lines": []})
            self.assertTrue(old.has(1))
            self.assertFalse(ocr.OcrStore(root, stamp=["pdf", 2, 100, 4]).has(1))
            self.assertFalse(ocr.OcrStore(root, stamp=["pdf", 1, 100, 5]).has(1))

    def test_queue_orders_by_priority(self):
        import threading
        order = []
        gate = threading.Event()

        def run(key, page, background):
            gate.wait(5)
            order.append((page, background))

        queue = ocr.OcrQueue(run, workers=1)
        queue.submit("doc", [1, 2, 3, 4], ocr.BACKGROUND)
        queue.submit("doc", [4], ocr.VISIBLE)
        gate.set()
        queue.wait("doc", [1, 2, 3, 4], 5)
        # Page 1 may already be running when page 4 is moved up.
        self.assertIn(order.index((4, False)), (0, 1))
        self.assertEqual(sorted(p for p, _ in order), [1, 2, 3, 4])


class ProgressiveOcrTest(Fixtures, unittest.TestCase):
    def test_mixed_range_and_complete_shell_markers(self):
        from test_reader import _text_pdf
        import pypdfium2 as pdfium
        import main
        from fastapi import BackgroundTasks
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            pdf = root / "mixed.pdf"
            digital = pdfium.PdfDocument(_text_pdf(40))
            scan = pdfium.PdfDocument(self.paths["scan"])
            digital.del_page(35)
            digital.import_pages(scan, [0], index=35)
            digital.save(str(pdf))
            digital.close()
            scan.close()
            hash_ = "abcdef0123456789"
            (root / hash_).mkdir()
            r = reader.Reader(root, workers=2)
            try:
                first = r.shell(hash_, pdf, "Mixed")
                self.assertIsInstance(first, str)
                self.assertNotIn("data-reader-ocr", first)
                self.assertIn('id="pf24" class="pf" data-page-no="24" data-reader-pending', first)
                with mock.patch.object(main, "reader", r), mock.patch.object(main, "_reader_source", return_value=pdf), \
                        mock.patch.object(main.catalog, "entry_name", return_value="Mixed"):
                    response = main.reader_text(hash_, 1, BackgroundTasks())
                data = json.loads(response.body)
                self.assertEqual(data["ocr"], [36])
                self.assertEqual(data["first"], 33)
                self.assertEqual(r.ocr_pages(hash_, pdf, "Mixed"), [36])
                r.finish_shell(hash_, pdf, "Mixed")
                shell = r.shell_path(hash_).read_text()
                self.assertIn('data-reader-text="complete"', shell)
                self.assertEqual(shell.count('data-reader-ocr="pending"'), 1)
                self.assertIn('id="pf24" class="pf" data-page-no="24" data-reader-ocr="pending"', shell)
                # A fresh Reader reads the same decisions from disk.
                self.assertEqual(reader.Reader(root).ocr_pages(hash_, pdf, "Mixed"), [36])
            finally:
                if r._pool is not None:
                    r._pool.shutdown()

    def test_source_change_requeues_completed_recognition(self):
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(ocr, "tool_path", return_value=pathlib.Path("/fake")), \
                mock.patch.object(ocr, "unavailable_reason", return_value=None), \
                mock.patch.object(ocr, "recognize_page", return_value={"lines": []}) as recognize:
            root = pathlib.Path(tmp)
            pdf = root / "source.pdf"
            pdf.write_bytes(pathlib.Path(self.paths["scan"]).read_bytes())
            hash_ = "abcdef0123456789"
            (root / hash_).mkdir()
            r = reader.Reader(root, workers=2)
            try:
                r.ocr_status(hash_, pdf, "Scan", [1], wait=10)
                stat = pdf.stat()
                os.utime(pdf, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1000000000))
                out = r.ocr_status(hash_, pdf, "Scan", [1], wait=10)
                self.assertEqual(out["pages"]["1"]["state"], "done")
                self.assertEqual(recognize.call_count, 2)
            finally:
                if r._pool is not None:
                    r._pool.shutdown()

    def test_delete_during_recognition_does_not_recreate_entry(self):
        import threading
        import shutil
        started, release = threading.Event(), threading.Event()
        def recognize(*args, **kwargs):
            started.set()
            release.wait(10)
            return {"lines": []}
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(ocr, "tool_path", return_value=pathlib.Path("/fake")), \
                mock.patch.object(ocr, "unavailable_reason", return_value=None), \
                mock.patch.object(ocr, "recognize_page", side_effect=recognize):
            root = pathlib.Path(tmp)
            hash_ = "abcdef0123456789"
            entry = root / hash_
            entry.mkdir()
            r = reader.Reader(root, workers=2)
            try:
                pdf = pathlib.Path(self.paths["scan"])
                r.ocr_status(hash_, pdf, "Scan", [1], wait=0)
                self.assertTrue(started.wait(10))
                r.ocr_forget(hash_)
                shutil.rmtree(entry)
                release.set()
                r._ocr().wait(hash_ + ":0", [1], 10)
                self.assertFalse(entry.exists())
                # Reopening the same hash gets a new queue generation.
                entry.mkdir()
                out = r.ocr_status(hash_, pdf, "Scan", [1], wait=10)
                self.assertEqual(out["pages"]["1"]["state"], "done")
            finally:
                release.set()
                if r._pool is not None:
                    r._pool.shutdown()


@unittest.skipIf(ocr.tool_path() is None, f"Vision unavailable: {ocr.unavailable_reason()}")
class VisionTest(Fixtures, unittest.TestCase):
    def recognize(self, name):
        path = self.paths[name]
        width, height = pdfium_doc.page_sizes(path)[0]
        return ocr.recognize_page(path, 0, width, height, tool=ocr.tool_path())

    def test_scan_text_and_boxes(self):
        result = self.recognize("scan")
        text = " ".join(seg["t"] for line in result["lines"] for seg in line["segs"])
        for word in ("Recognition", "pixels", "Selection", "scans", "Alpha", "Omega", "blåbær", "rødgrøt"):
            self.assertIn(word, text)
        # Boxes land where PDFium puts the same words in the source page.
        truth = {line["segs"][0]["t"].split()[0]: line for line in pdfium_doc.page_text(self.paths["text"], 0)}
        for line in result["lines"]:
            first = line["segs"][0]["t"].split()[0]
            if first in truth:
                self.assertAlmostEqual(line["x"], truth[first]["x"], delta=6)
                self.assertAlmostEqual(line["y"] + line["h"] / 2, truth[first]["y"] + truth[first]["h"] / 2, delta=6)
        # Vision returns table columns as separate observations; each stays
        # its own positioned line (a gap inside one observation is split into
        # segments, see LinesFromVisionTest).
        columns = {seg["t"]: line for line in result["lines"] for seg in line["segs"] if seg["t"] in ("Alpha", "Omega")}
        self.assertEqual(set(columns), {"Alpha", "Omega"})
        self.assertAlmostEqual(columns["Omega"]["x"], 400, delta=6)

    def test_sideways_scan(self):
        # The source page turned a quarter counter-clockwise: every line reads
        # up the page, and Vision reads it so without help.
        result = self.recognize("sideways")
        text = " ".join(seg["t"] for line in result["lines"] for seg in line["segs"])
        self.assertIn("Recognition", text)
        self.assertTrue(all(line["dir"] == 3 for line in result["lines"]), [l["dir"] for l in result["lines"]])
        # "Recognition…" was 92 pt below the top of the upright page, so it
        # runs up a column 92 pt from the left edge of the turned one.
        first = next(l for l in result["lines"] if l["segs"][0]["t"].startswith("Recognition"))
        x0, y0, x1, y1 = ocr.line_box(first)
        self.assertAlmostEqual((x0 + x1) / 2, 792 - 700 - 8, delta=8)
        self.assertGreater(y1 - y0, 5 * (x1 - x0))


if __name__ == "__main__":
    unittest.main()

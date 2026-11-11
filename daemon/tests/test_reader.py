from __future__ import annotations

import concurrent.futures
import json
import os
import pathlib
import re
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import pdfium_doc  # noqa: E402
import reader  # noqa: E402


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


def _link(rect: bytes, target: bytes) -> bytes:
    return b"<< /Type /Annot /Subtype /Link /Border [0 0 0] /Rect [" + rect + b"] " + target + b" >>"


# Page 1 (612 x 792) carries the links; page 2 (600 x 800) is the target.
LINKS_PDF = _pdf([
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
    b"/Annots [5 0 R 6 0 R 7 0 R 8 0 R 9 0 R 10 0 R 11 0 R] >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] >>",
    # 5: direct destination with a point on page 2
    _link(b"100 700 150 712", b"/Dest [4 0 R /XYZ 72 650 0]"),
    # 6: GoTo action, page only
    _link(b"100 600 150 612", b"/A << /S /GoTo /D [4 0 R /Fit] >>"),
    # 7: allowed URI
    _link(b"200 500 300 514", b"/A << /S /URI /URI (https://example.com/a?b=1&c=\"2\") >>"),
    # 8-11: disallowed or unsupported
    _link(b"200 400 300 414", b"/A << /S /URI /URI (javascript:alert\\(1\\)) >>"),
    _link(b"200 300 300 314", b"/A << /S /URI /URI (file:///etc/passwd) >>"),
    _link(b"200 200 300 214", b"/A << /S /Launch /F (calc.exe) >>"),
    _link(b"200 100 300 114", b"/A << /S /URI /URI (mailto:someone@example.com) >>"),
])


class LinkExtractionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.path = str(pathlib.Path(cls.temp.name) / "links.pdf")
        pathlib.Path(cls.path).write_bytes(LINKS_PDF)
        cls.links = pdfium_doc.page_links(cls.path, 0)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def test_internal_destination_with_point(self):
        link = self.links[0]
        self.assertEqual((link["x"], link["y"], link["w"], link["h"]), (100, 80, 50, 12))
        self.assertEqual(link["dest"]["page"], 2)
        self.assertAlmostEqual(link["dest"]["x"], 72)
        # Measured from the top of the 800-px-tall target page, not this one.
        self.assertAlmostEqual(link["dest"]["y"], 150)

    def test_goto_action_without_point(self):
        self.assertEqual(self.links[1]["dest"], {"page": 2, "x": None, "y": None})

    def test_only_allowed_uris_survive(self):
        uris = [link["uri"] for link in self.links if "uri" in link]
        self.assertEqual(uris, ['https://example.com/a?b=1&c="2"', "mailto:someone@example.com"])
        self.assertEqual(len(self.links), 4)

    def test_page_without_links(self):
        self.assertEqual(pdfium_doc.page_links(self.path, 1), [])
        self.assertEqual(pdfium_doc.pages_links(self.path, 0, 3)[1:], [[], []])

    def test_safe_uri(self):
        for uri in ("http://a.b", "HTTPS://a.b/c", "mailto:x@y.z", "  https://a.b  "):
            self.assertIsNotNone(pdfium_doc.safe_uri(uri), uri)
        for uri in ("javascript:alert(1)", "JavaScript:x", "file:///x", "data:text/html,x",
                    "https://a.b/\nx", "https:", "//a.b", "", None, "vbscript:x"):
            self.assertIsNone(pdfium_doc.safe_uri(uri), uri)


class LinkHtmlTest(unittest.TestCase):
    def shell(self, links):
        return reader.build_shell("abc", "T", [(612.0, 792.0)], [], [[]], [links])

    def test_internal_link(self):
        html = self.shell([{"x": 100, "y": 80.5, "w": 50, "h": 12,
                            "dest": {"page": 26, "x": 72.0, "y": 150.25}}])
        self.assertIn(
            '<a class="l" href="#pf1a" style="left:100px;top:80.5px;width:50px;height:12px" '
            'aria-label="Page 26" data-reader-dest=\'[26, &quot;XYZ&quot;, 72.0, 150.25, null]\'></a>',
            html)

    def test_internal_link_without_point(self):
        html = self.shell([{"x": 1, "y": 2, "w": 3, "h": 4, "dest": {"page": 2, "x": None, "y": None}}])
        self.assertIn("data-reader-dest='[2, &quot;XYZ&quot;, null, null, null]'", html)

    def test_external_link_is_escaped(self):
        html = self.shell([{"x": 1, "y": 2, "w": 3, "h": 4, "uri": 'https://e.x/?a=1&b="2"\'<'}])
        match = re.search(r'<a class="l" href="([^"]*)"[^>]*></a>', html)
        assert match is not None
        self.assertEqual(match.group(1), "https://e.x/?a=1&amp;b=&quot;2&quot;&#x27;&lt;")
        self.assertIn('target="_blank" rel="noopener noreferrer"', match.group(0))

    def test_links_follow_text_inside_page_content(self):
        line = {"x": 0, "y": 0, "h": 10, "segs": [{"t": "ref", "w": 20, "gap": 0, "sp": False}]}
        html = reader.build_shell("abc", "T", [(612.0, 792.0)], [], [[line]],
                                  [[{"x": 1, "y": 2, "w": 3, "h": 4, "uri": "https://e.x"}]])
        pc = html[html.index('<div class="pc">'):]
        self.assertLess(pc.index('class="t"'), pc.index('<a class="l"'))
        self.assertLess(pc.index('<a class="l"'), pc.index("</div></div>"))

    def test_extracted_links_round_trip(self):
        with tempfile.TemporaryDirectory() as temp:
            path = pathlib.Path(temp) / "links.pdf"
            path.write_bytes(LINKS_PDF)
            sizes = pdfium_doc.page_sizes(str(path))
            html = reader.build_shell("abc", "T", sizes, [], [[], []], pdfium_doc.pages_links(str(path), 0, 2))
        self.assertEqual(html.count('<a class="l"'), 4)
        self.assertNotIn("javascript", html)
        self.assertNotIn("file:", html)


def _text_pdf(pages: int) -> bytes:
    """`pages` pages of 300 x 400, page N showing "Page N" in Helvetica."""
    kids = " ".join(f"{4 + 2 * i} 0 R" for i in range(pages)).encode()
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [" + kids + b"] /Count %d >>" % pages,
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    for i in range(pages):
        stream = b"BT /F1 12 Tf 40 300 Td (Page %d) Tj ET" % (i + 1)
        objects.append(b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] "
                       b"/Resources << /Font << /F1 3 0 R >> >> /Contents %d 0 R >>" % (5 + 2 * i))
        objects.append(b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream")
    return _pdf(objects)


# A task covering this 1-based page exits its worker process, as a PDF that
# crashes PDFium does. Read in the worker, so it is set through the environment.
def crashing_bodies(path: str, start: int, stop: int) -> list[str]:
    crash = int(os.environ.get("PDFV_TEST_CRASH_PAGE", "0")) - 1
    if start <= crash < stop:
        os._exit(70)
    return reader.range_bodies(path, start, stop)


class ShellMarkupTest(unittest.TestCase):
    def test_pending_pages_are_marked(self):
        html = reader.shell_html("abc", "T", [(100.0, 100.0)] * 3, [], ["<b>1</b>", None, ""])
        self.assertIn('data-reader-text="loading" data-reader-text-src="/r/abc/text/" '
                      f'data-reader-text-range="{reader.TEXT_RANGE_PAGES}"', html)
        self.assertEqual(html.count("data-reader-pending"), 1)
        self.assertIn('<div id="pf2" class="pf" data-page-no="2" data-reader-pending="" style=', html)
        self.assertIn('data-reader-raster="/r/abc/p/1/"><b>1</b></div></div>', html)

    def test_complete_shell_has_no_markers(self):
        line = {"x": 0, "y": 0, "h": 10, "segs": [{"t": "x", "w": 5, "gap": 0, "sp": False}]}
        html = reader.build_shell("abc", "T", [(100.0, 100.0)] * 2, [], [[line], []])
        self.assertNotIn("data-reader-text", html)
        self.assertNotIn("data-reader-pending", html)
        self.assertEqual(html.count('class="t"'), 1)

    def test_page_body_is_lines_then_links(self):
        line = {"x": 0, "y": 0, "h": 10, "segs": [{"t": "ref", "w": 20, "gap": 0, "sp": False}]}
        body = reader.page_body([line], [{"x": 1, "y": 2, "w": 3, "h": 4, "uri": "https://e.x"}])
        self.assertEqual(body, reader._line_html(line) + reader._link_html({"x": 1, "y": 2, "w": 3, "h": 4,
                                                                             "uri": "https://e.x"}))


class TextRangeTest(unittest.TestCase):
    """The split shell, /r/<hash>/text/<k>.json ranges and their cache."""

    PAGES = 40  # two ranges: 1-32 and 33-40

    @classmethod
    def setUpClass(cls):
        cls.reader_pool = reader.Reader(pathlib.Path(tempfile.mkdtemp()), workers=2)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = pathlib.Path(self.temp.name)
        self.pdf = root / "doc.pdf"
        self.pdf.write_bytes(_text_pdf(self.PAGES))
        self.hash = "feedfacecafe0001"
        (root / "cache" / self.hash).mkdir(parents=True)
        # One pool for the class: spawning workers is the slow part.
        self.reader = self.reader_pool
        self.reader.root = root / "cache"
        self.reader._sizes.clear()
        self.extractions = []
        original = reader.Reader._extract_start

        def counted(this, pdf, index, count, urgent=False):  # noqa: FBT002
            self.extractions.append(index)
            return original(this, pdf, index, count, urgent)

        patcher = patch.object(reader.Reader, "_extract_start", counted)
        patcher.start()
        self.addCleanup(patcher.stop)

    def tearDown(self):
        self.temp.cleanup()

    def test_first_shell_has_first_range_only(self):
        shell = self.reader.shell(self.hash, self.pdf, "Doc")
        self.assertIsInstance(shell, str)
        self.assertEqual(self.extractions, [0])
        self.assertEqual(shell.count("data-reader-pending"), 8)
        self.assertIn("Page 32<br>", shell)
        self.assertNotIn("Page 33<br>", shell)
        self.assertIn('data-reader-text="loading"', shell)
        self.assertTrue((self.reader.entry_dir(self.hash) / "text" / "0.json").is_file())
        self.assertFalse(self.reader.shell_path(self.hash).exists())

    def test_near_pages_add_their_range(self):
        shell = self.reader.shell(self.hash, self.pdf, "Doc", near_pages=(35,))
        self.assertEqual(sorted(self.extractions), [0, 1])
        self.assertIsInstance(shell, pathlib.Path)  # every range present: the complete shell
        text = shell.read_text(encoding="utf-8")
        self.assertNotIn("data-reader-pending", text)
        self.assertIn("Page 40<br>", text)

    def test_range_markup_matches_the_complete_shell(self):
        first, pages = self.reader.text_range(self.hash, self.pdf, 1)
        self.assertEqual((first, len(pages)), (33, 8))
        lines = pdfium_doc.pages_text(str(self.pdf), 32, 40)
        links = pdfium_doc.pages_links(str(self.pdf), 32, 40)
        self.assertEqual(pages, [reader.page_body(t, k) for t, k in zip(lines, links)])
        with self.assertRaises(IndexError):
            self.reader.text_range(self.hash, self.pdf, 2)
        with self.assertRaises(IndexError):
            self.reader.text_range(self.hash, self.pdf, -1)

    def test_concurrent_requests_extract_once(self):
        with concurrent.futures.ThreadPoolExecutor(6) as pool:
            results = list(pool.map(lambda _: self.reader.text_range(self.hash, self.pdf, 1), range(6)))
        self.assertEqual(self.extractions, [1])
        self.assertTrue(all(result == results[0] for result in results))
        self.reader.text_range(self.hash, self.pdf, 1)
        self.assertEqual(self.extractions, [1])  # from disk

    def test_last_range_completes_the_shell(self):
        self.assertIsInstance(self.reader.shell(self.hash, self.pdf, "Doc"), str)
        self.reader.text_range(self.hash, self.pdf, 1)
        self.reader.finish_shell(self.hash, self.pdf, "Doc")
        shell = self.reader.shell(self.hash, self.pdf, "Doc")
        self.assertIsInstance(shell, pathlib.Path)
        self.assertEqual(self.extractions, [0, 1])
        self.assertEqual(shell.read_text(encoding="utf-8"), reader.build_shell(
            self.hash, "Doc", pdfium_doc.page_sizes(str(self.pdf)), pdfium_doc.outline(str(self.pdf)),
            pdfium_doc.pages_text(str(self.pdf), 0, 40), pdfium_doc.pages_links(str(self.pdf), 0, 40)))

    def test_invalidation(self):
        self.reader.shell(self.hash, self.pdf, "Doc", near_pages=(35,))
        self.assertEqual(sorted(self.extractions), [0, 1])
        # A new title rebuilds the shell from the cached ranges.
        shell = self.reader.shell(self.hash, self.pdf, "Renamed")
        self.assertIn("<title>Renamed</title>", shell.read_text(encoding="utf-8"))
        self.assertEqual(sorted(self.extractions), [0, 1])
        # A changed source invalidates shell and ranges.
        stat = self.pdf.stat()
        os.utime(self.pdf, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000_000))
        self.assertIsInstance(self.reader.shell(self.hash, self.pdf, "Renamed"), str)
        self.assertEqual(sorted(self.extractions), [0, 0, 1])
        # So does a new shell version.
        with patch.object(reader, "SHELL_VERSION", reader.SHELL_VERSION + 100):
            self.reader.text_range(self.hash, self.pdf, 0)
        self.assertEqual(sorted(self.extractions), [0, 0, 0, 1])
        with patch.object(pdfium_doc, "TEXT_LAYER_VERSION", pdfium_doc.TEXT_LAYER_VERSION + 100):
            self.reader.text_range(self.hash, self.pdf, 0)
        self.assertEqual(sorted(self.extractions), [0, 0, 0, 0, 1])

    def test_deleted_entry_is_not_recreated(self):
        import shutil
        shutil.rmtree(self.reader.root / self.hash)
        self.reader.text_range(self.hash, self.pdf, 1)
        self.assertFalse((self.reader.root / self.hash).exists())

    def test_crashing_page_loses_its_text_only(self):
        with patch.dict(os.environ, {"PDFV_TEST_CRASH_PAGE": "35"}), \
                patch.object(reader, "range_bodies", crashing_bodies):
            # Fresh workers read the environment variable.
            self.reader._pool = None
            first, pages = self.reader.text_range(self.hash, self.pdf, 1)
        self.assertEqual(first, 33)
        self.assertEqual(pages[2], "")  # page 35
        self.assertIn("Page 34<br>", pages[1])
        self.assertIn("Page 40<br>", pages[7])
        # Not cached, so the next request extracts again, on a working pool.
        self.assertFalse((self.reader.entry_dir(self.hash) / "text" / "1.json").exists())
        self.reader._pool = None
        _, pages = self.reader.text_range(self.hash, self.pdf, 1)
        self.assertIn("Page 35<br>", pages[2])
        self.assertTrue((self.reader.entry_dir(self.hash) / "text" / "1.json").exists())

    def test_crash_during_shell_is_not_cached(self):
        with patch.dict(os.environ, {"PDFV_TEST_CRASH_PAGE": "3"}), \
                patch.object(reader, "range_bodies", crashing_bodies):
            self.reader._pool = None
            shell = self.reader.shell(self.hash, self.pdf, "Doc", near_pages=(35,))
        self.assertIsInstance(shell, str)  # complete but degraded: not written
        self.assertNotIn("Page 3<br>", shell)
        self.assertIn("Page 4<br>", shell)
        self.assertFalse(self.reader.shell_path(self.hash).exists())
        self.reader._pool = None
        self.assertIsInstance(self.reader.shell(self.hash, self.pdf, "Doc"), pathlib.Path)

    def test_urgent_tasks_run_first(self):
        """A page render submitted after a backlog of text tasks runs first."""
        order = []
        lock = threading.Lock()
        with self.reader._queued:
            # Hold the dispatcher, as if every worker were busy.
            self.reader._active += self.reader.workers
        background = [self.reader._submit(pdfium_doc.page_sizes, str(self.pdf), urgent=False) for _ in range(3)]
        urgent = self.reader._submit(pdfium_doc.page_sizes, str(self.pdf))
        for name, future in [("background", f) for f in background] + [("urgent", urgent)]:
            future.add_done_callback(lambda _f, name=name: (lock.acquire(), order.append(name), lock.release()))
        with self.reader._queued:
            # One worker frees up: the urgent task takes it.
            self.reader._active -= self.reader.workers - 1
            self.reader._queued.notify_all()
        urgent.result(timeout=30)
        with self.reader._queued:
            self.reader._active -= 1
            self.reader._queued.notify_all()
        for future in background:
            future.result(timeout=30)
        self.assertEqual(order, ["urgent", "background", "background", "background"])


class RouteTest(unittest.TestCase):
    def setUp(self):
        import main  # noqa: PLC0415 - imports the app
        self.main = main
        self.temp = tempfile.TemporaryDirectory()
        root = pathlib.Path(self.temp.name)
        self.pdf = root / "doc.pdf"
        self.pdf.write_bytes(_text_pdf(TextRangeTest.PAGES))
        self.hash = "feedfacecafe0002"
        (root / "cache" / self.hash).mkdir(parents=True)
        self.reader = reader.Reader(root / "cache", workers=2)
        for target, name, value in ((main, "reader", self.reader),
                                    (main, "_reader_source", lambda _h: self.pdf),
                                    (main, "_saved_page", lambda _h: None),
                                    (main.catalog, "entry_name", lambda _h: "Doc")):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def tearDown(self):
        self.temp.cleanup()

    def test_shell_then_ranges_then_complete_shell(self):
        from fastapi import BackgroundTasks
        response = self.main.reader_shell(self.hash, BackgroundTasks())
        self.assertNotIsInstance(response, self.main.FileResponse)
        self.assertIn(b'data-reader-text="loading"', response.body)
        tasks = BackgroundTasks()
        response = self.main.reader_text(self.hash, 1, tasks)
        data = json.loads(response.body)
        self.assertEqual(data["first"], 33)
        self.assertEqual(len(data["pages"]), 8)
        self.assertEqual(response.headers["cache-control"], "no-cache")
        for task in tasks.tasks:
            task.func(*task.args, **task.kwargs)  # finish_shell
        response = self.main.reader_shell(self.hash, BackgroundTasks())
        self.assertIsInstance(response, self.main.FileResponse)

    def test_missing_range_is_404(self):
        from fastapi import BackgroundTasks, HTTPException
        with self.assertRaises(HTTPException) as caught:
            self.main.reader_text(self.hash, 5, BackgroundTasks())
        self.assertEqual(caught.exception.status_code, 404)


class SavedPageTest(unittest.TestCase):
    def test_saved_page(self):
        import main  # noqa: PLC0415 - imports the app
        self.main = main
        with patch.object(self.main.state, "get_all", return_value={"position": {"value": {"page": 35}, "ts": 1}}):
            self.assertEqual(self.main._saved_page("abc"), 35)
        with patch.object(self.main.state, "get_all", return_value={"position": {"value": {"page": 1}, "ts": 1}}):
            self.assertIsNone(self.main._saved_page("abc"))
        with patch.object(self.main.state, "get_all", side_effect=ValueError("bad hash")):
            self.assertIsNone(self.main._saved_page("abc"))


if __name__ == "__main__":
    unittest.main()

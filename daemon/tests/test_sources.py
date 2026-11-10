from __future__ import annotations

import http.server
import pathlib
import sys
import tempfile
import threading
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import sources  # noqa: E402
from sources import SourceError, download, filename_for  # noqa: E402


PDF_BYTES = b"%PDF-1.4\n%fake test document\n%%EOF\n"


def make_handler(routes):
    """A handler serving `routes`: path -> (status, headers, body). Unknown paths get 404."""

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            status, headers, body = routes.get(self.path, (404, {}, b"not found"))
            self.send_response(status)
            for name, value in headers.items():
                self.send_header(name, value)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format, *args):  # keep test output quiet
            pass

    return Handler


class FilenameForTest(unittest.TestCase):
    def test_content_disposition_plain_filename_is_used(self):
        name = filename_for("https://example.com/download?id=7",
                            'attachment; filename="a b.pdf"')
        self.assertEqual(name, "a b.pdf")

    def test_content_disposition_rfc5987_filename_star_is_decoded(self):
        name = filename_for("https://example.com/download",
                            "attachment; filename*=UTF-8''na%C3%AFve.pdf")
        self.assertEqual(name, "naïve.pdf")

    def test_falls_back_to_percent_decoded_last_path_segment(self):
        self.assertEqual(filename_for("https://example.com/docs/My%20Doc.pdf"), "My Doc.pdf")
        self.assertEqual(filename_for("https://example.com/docs/My%20Doc.pdf", "inline"), "My Doc.pdf")

    def test_appends_pdf_extension_when_missing(self):
        self.assertEqual(filename_for("https://example.com/files/report"), "report.pdf")
        self.assertEqual(filename_for("https://example.com/files/REPORT.PDF"), "REPORT.PDF")

    def test_empty_path_becomes_document_pdf(self):
        self.assertEqual(filename_for("https://example.com/"), "document.pdf")
        self.assertEqual(filename_for("https://example.com"), "document.pdf")

    def test_path_separators_and_control_characters_become_underscores(self):
        self.assertEqual(filename_for("https://example.com/a%2Fb%01c.pdf"), "a_b_c.pdf")
        self.assertEqual(filename_for("https://example.com/x",
                                      'attachment; filename="a\\b.pdf"'), "a_b.pdf")

    def test_leading_dots_are_removed(self):
        self.assertEqual(filename_for("https://example.com/..hidden.pdf"), "hidden.pdf")

    def test_name_length_is_capped_at_200_characters(self):
        name = filename_for("https://example.com/" + ("a" * 300) + ".pdf")
        self.assertLessEqual(len(name), 200)

    def test_capped_name_keeps_the_pdf_extension(self):
        name = filename_for("https://example.com/" + ("a" * 300) + ".pdf")
        self.assertTrue(name.endswith(".pdf"), name[-20:])


class DownloadTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = pathlib.Path(self.temp.name)
        self.target = self.base / "pdfs"
        self.target.mkdir()
        self.routes = {
            "/report.pdf": (200, {"Content-Type": "application/pdf",
                                  "Content-Disposition": 'attachment; filename="Report 2026.pdf"'},
                            PDF_BYTES),
            "/signin": (200, {"Content-Type": "text/html"}, b"<html>sign in</html>"),
        }
        self.server = self.start_server(self.routes)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        self.temp.cleanup()

    def start_server(self, routes):
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), make_handler(routes))
        # A short poll interval keeps shutdown() from waiting out the 0.5 s default.
        self.thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        self.thread.start()
        self.port = server.server_address[1]
        return server

    def url(self, path):
        return f"http://127.0.0.1:{self.port}{path}"

    def test_pdf_body_is_saved_under_content_disposition_name(self):
        name = download(self.url("/report.pdf"), self.target)
        self.assertEqual(name, "Report 2026.pdf")
        self.assertEqual((self.target / name).read_bytes(), PDF_BYTES)
        self.assertEqual(sorted(path.name for path in self.target.iterdir()), ["Report 2026.pdf"])

    def test_html_body_raises_and_leaves_no_file_behind(self):
        with self.assertRaises(SourceError):
            download(self.url("/signin"), self.target)
        self.assertEqual(list(self.target.iterdir()), [])

    def test_not_found_raises_source_error_and_leaves_no_file_behind(self):
        with self.assertRaises(SourceError):
            download(self.url("/missing.pdf"), self.target)
        self.assertEqual(list(self.target.iterdir()), [])

    def test_non_http_url_raises_without_making_a_request(self):
        with mock.patch.object(sources.urllib.request, "urlopen") as urlopen:
            with self.assertRaises(SourceError):
                download("file:///etc/hosts", self.target)
        urlopen.assert_not_called()
        self.assertFalse(self.target.joinpath(".download").exists())

    def test_body_over_the_size_cap_raises_and_leaves_no_file_behind(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        self.start_server({"/big.pdf": (200, {}, PDF_BYTES * 4)})
        with mock.patch.object(sources, "MAX_BYTES", 16):
            with self.assertRaises(SourceError):
                download(self.url("/big.pdf"), self.target)
        self.assertEqual(list(self.target.iterdir()), [])


if __name__ == "__main__":
    unittest.main()

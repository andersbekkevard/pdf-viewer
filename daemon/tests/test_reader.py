from __future__ import annotations

import pathlib
import re
import sys
import tempfile
import unittest

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


if __name__ == "__main__":
    unittest.main()

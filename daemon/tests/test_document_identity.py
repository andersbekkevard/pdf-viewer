"""What a tab shows for a document: its title, its address and its icon."""
from __future__ import annotations

import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import pdfium_doc  # noqa: E402
import reader  # noqa: E402
from catalog import CacheCatalog  # noqa: E402
from tests.test_reader import _pdf  # noqa: E402


def _page_pdf(content: bytes) -> bytes:
    """One US-letter page drawing `content` with Helvetica as /F1."""
    return _pdf([
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R "
        b"/Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ])


def _text(size: int, y: int, text: str) -> bytes:
    return b"BT /F1 %d Tf 72 %d Td (%s) Tj ET\n" % (size, y, text.encode())


BODY = b"".join(_text(10, 560 - 12 * i, "Body text of the paper, line %d, set in ten point type." % i)
                for i in range(30))
PAPER = _text(20, 720, "Scaling Discovery") + _text(20, 696, "Requires Forgetting") + BODY
CAPS = _text(18, 720, "THE CURIOUS CASE OF NEURAL") + _text(18, 698, "TEXT DEGENERATION") + BODY
SHEET = BODY
# A chart: a plot frame around ten coloured bars, and its caption below.
CHART = b"0 0 0 RG 1 w 100 395 430 260 re S\n" + b"".join(b"%.2f 0.3 0.8 rg %d 400 30 %d re f\n" % (i / 10, 120 + 40 * i, 60 + 15 * i)
                 for i in range(10)) + _text(10, 380, "Figure 1: a chart.")


class _Files(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)

    def write(self, data: bytes) -> str:
        path = pathlib.Path(self._tmp.name) / f"{len(list(pathlib.Path(self._tmp.name).iterdir()))}.pdf"
        path.write_bytes(data)
        return str(path)


class HeadingTest(_Files):
    def test_the_largest_text_on_the_first_page_is_its_title(self):
        self.assertEqual(pdfium_doc.heading(self.write(_page_pdf(PAPER))), "Scaling Discovery Requires Forgetting")

    def test_an_all_capitals_title_is_set_in_title_case(self):
        self.assertEqual(pdfium_doc.heading(self.write(_page_pdf(CAPS))),
                         "The Curious Case of Neural Text Degeneration")

    def test_a_page_in_one_size_has_no_heading(self):
        self.assertIsNone(pdfium_doc.heading(self.write(_page_pdf(SHEET))))

    def test_metadata_carries_the_heading(self):
        self.assertEqual(pdfium_doc.metadata(self.write(_page_pdf(PAPER)))["heading"],
                         "Scaling Discovery Requires Forgetting")


class FigureIconTest(_Files):
    def test_a_chart_becomes_a_square_png(self):
        data = pdfium_doc.figure_icon(self.write(_page_pdf(CHART)), 64)
        self.assertIsNotNone(data)
        self.assertTrue(data.startswith(b"\x89PNG"))
        from PIL import Image
        import io
        self.assertEqual(Image.open(io.BytesIO(data)).size, (64, 64))

    def test_a_page_of_text_has_no_figure(self):
        self.assertIsNone(pdfium_doc.figure_icon(self.write(_page_pdf(PAPER)), 64))


class TitleTest(unittest.TestCase):
    def test_the_printed_title_names_a_document_without_metadata(self):
        self.assertEqual(CacheCatalog.display_title("2610.20563v1", "https://arxiv.org/pdf/2610.20563v1.pdf",
                                                    None, "Scaling Discovery Requires Forgetting"),
                         "Scaling Discovery Requires Forgetting")

    def test_metadata_title_wins_over_the_printed_one(self):
        self.assertEqual(CacheCatalog.display_title("x", "/d/x.pdf", "Meta Title", "Printed Title"), "Meta Title")

    def test_a_junk_metadata_title_falls_back_to_the_printed_one(self):
        self.assertEqual(CacheCatalog.display_title("entropy", "/d/entropy.pdf", "shannon1948.dvi",
                                                    "A Mathematical Theory of Communication"),
                         "A Mathematical Theory of Communication")

    def test_a_download_named_by_the_server_is_not_a_rename(self):
        self.assertEqual(CacheCatalog.display_title("2610.20563v1", "https://arxiv.org/pdf/2610.20563",
                                                    "Scaling Discovery Requires Forgetting", None,
                                                    "/c/h/_source/2610.20563v1.pdf"),
                         "Scaling Discovery Requires Forgetting")

    def test_a_renamed_document_keeps_its_name(self):
        self.assertEqual(CacheCatalog.display_title("Mine", "/d/x.pdf", None, "Printed Title"), "Mine")


class AddressTest(unittest.TestCase):
    def test_slug(self):
        self.assertEqual(reader.slug("Scaling Discovery Requires Forgetting"), "scaling-discovery-requires-forgetting")
        self.assertEqual(reader.slug("Auditable Human–Agent Teams: X-Ray Café"), "auditable-human-agent-teams-x-ray-cafe")
        self.assertEqual(reader.slug("∑∏"), "")
        self.assertEqual(reader.slug("OCR"), "ocr-pdf")

    def test_a_long_title_is_cut_at_a_word(self):
        out = reader.slug("The Optimizer Is the Agent: Reasoning-Driven Search across Prompts, Programs, "
                          "and ML Workflows")
        self.assertLessEqual(len(out), reader.SLUG_MAX_LEN)
        self.assertFalse(out.endswith("-"))
        self.assertTrue("reasoning-driven-search-across-prompts".startswith(out[len("the-optimizer-is-the-agent-"):][:5]))

    def test_shell_puts_the_titled_address_and_icon_in_the_head(self):
        markup = reader.shell_html("abcdef0123456789", "Scaling Discovery", [(612, 792)], [], ["<div></div>"])
        self.assertIn('"/r/abcdef0123456789/scaling-discovery"', markup)
        self.assertIn('href="/r/abcdef0123456789/icon?v=', markup)

    def test_monogram(self):
        svg = reader.monogram_svg("attention is all you need", "abc")
        self.assertIn(">A</text>", svg)
        self.assertNotEqual(reader.monogram_svg("A", "abc"), reader.monogram_svg("A", "abd"))


if __name__ == "__main__":
    unittest.main()

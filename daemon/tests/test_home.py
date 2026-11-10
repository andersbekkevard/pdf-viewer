"""GET / (the home page) and the /library fields it reads."""
from __future__ import annotations

import json
import pathlib
import sys
import tempfile
import unittest

from fastapi.responses import FileResponse

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import main  # noqa: E402
from catalog import CacheCatalog  # noqa: E402

READER_HASH = "998117f977edf08f"
CONVERTED_HASH = "aaaabbbbccccdddd"
BARE_HASH = "1111222233334444"


class FakeActivity:
    def all_frecency(self):
        return {READER_HASH: {"raw_count": 3, "rank": 2, "last_seen": 1700000000,
                              "age_multiplier": 1.0, "frecency_score": 9.0}}


class HomeRouteTest(unittest.TestCase):
    def test_root_serves_home_html_without_caching(self):
        response = main.home()
        self.assertIsInstance(response, FileResponse)
        self.assertEqual(pathlib.Path(response.path), main.ASSETS_DIR / "home.html")
        self.assertEqual(response.headers["cache-control"], "no-cache")
        self.assertTrue(response.media_type.startswith("text/html"))
        html = (main.ASSETS_DIR / "home.html").read_text(encoding="utf-8")
        self.assertIn("/_assets/home.js", html)
        self.assertIn("/_assets/home.css", html)

    def test_root_route_precedes_the_cache_mount(self):
        paths = [getattr(route, "path", None) for route in main.app.routes]
        self.assertIn("/", paths)
        mount_index = next(i for i, route in enumerate(main.app.routes)
                           if getattr(route, "name", None) == "cache")
        self.assertLess(paths.index("/"), mount_index)


class LibraryHomeFieldsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        tmp = pathlib.Path(self.temp.name)
        self.root = tmp / "cache"
        self.root.mkdir()
        self.catalog = CacheCatalog(self.root, FakeActivity())

        # A reader entry: local source PDF on disk, meta.json written by the reader.
        pdf = tmp / "Book.pdf"
        pdf.write_bytes(b"%PDF-1.4")
        reader_dir = self.root / READER_HASH
        reader_dir.mkdir()
        (reader_dir / "Book.html").write_text("x", encoding="utf-8")
        (reader_dir / "meta.json").write_text(json.dumps(
            {"title": "  A Book ", "author": "Someone", "pages": 42, "file_size": 8}), encoding="utf-8")

        # A converted entry whose source is gone, with pdftocairo thumbs.
        converted_dir = self.root / CONVERTED_HASH
        (converted_dir / "thumbs").mkdir(parents=True)
        (converted_dir / "Old.html").write_text("x", encoding="utf-8")
        (converted_dir / "thumbs" / "1.jpg").write_bytes(b"jpg")
        (converted_dir / "meta.json").write_text("not json", encoding="utf-8")

        # A converted entry with neither meta.json nor thumbnails.
        bare_dir = self.root / BARE_HASH
        bare_dir.mkdir()
        (bare_dir / "Bare.html").write_text("x", encoding="utf-8")

        self.catalog.mappings_path.write_text(
            f"1\t{pdf}\t{READER_HASH}\t{reader_dir / 'Book.html'}\n"
            f"1\t/gone/Old.pdf\t{CONVERTED_HASH}\t{converted_dir / 'Old.html'}\n"
            f"1\thttps://example.com/bare.pdf\t{BARE_HASH}\t{bare_dir / 'Bare.html'}\n",
            encoding="utf-8")
        self.original_catalog = main.catalog
        main.catalog = self.catalog

    def tearDown(self):
        main.catalog = self.original_catalog
        self.temp.cleanup()

    def test_library_rows_carry_meta_and_thumbnail(self):
        rows = {row["hash"]: row for row in main.library()}
        reader_row = rows[READER_HASH]
        self.assertEqual((reader_row["pages"], reader_row["title"], reader_row["author"]),
                         (42, "A Book", "Someone"))
        self.assertEqual(reader_row["thumb_href"], f"/r/{READER_HASH}/p/1/240.png")

        converted = rows[CONVERTED_HASH]
        self.assertEqual((converted["pages"], converted["title"], converted["author"]), (None, None, None))
        self.assertEqual(converted["thumb_href"], f"/{CONVERTED_HASH}/thumbs/1.jpg")

        self.assertIsNone(rows[BARE_HASH]["thumb_href"])
        self.assertIsNone(rows[BARE_HASH]["pages"])

    def test_existing_fields_and_order_unchanged(self):
        rows = main.library()
        self.assertEqual(rows[0]["hash"], READER_HASH)  # frecency first
        for key in ("hash", "name", "source_ref", "search_text", "href", "reader_href",
                    "canonical_href", "light_href", "count", "rank", "last_seen",
                    "age_multiplier", "frecency_score"):
            self.assertIn(key, rows[0])
        self.assertEqual(rows[0]["count"], 3)


if __name__ == "__main__":
    unittest.main()

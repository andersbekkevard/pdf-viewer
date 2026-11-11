from __future__ import annotations

import pathlib
import sys
import tempfile
import unittest
import unittest.mock
from unittest.mock import patch

from fastapi import BackgroundTasks
from fastapi.responses import FileResponse
from starlette.requests import Request

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import main  # noqa: E402
from catalog import CacheCatalog, url_hash  # noqa: E402


HASH = "998117f977edf08f"
REMOTE_URL = "https://example.com/books/remote.pdf?token=abc&expires=123"


class FakeActivity:
    def all_frecency(self):
        return {}


class ViewRepresentationTest(unittest.TestCase):
    def setUp(self):
        # These are the converted-HTML (pdf2htmlEX) routes; the reader is the default.
        # (The tests clear the environment, so the engine is pinned on the function.)
        engine = unittest.mock.patch.object(main, "_prefer_reader", return_value=False)
        engine.start()
        self.addCleanup(engine.stop)
        self.temp = tempfile.TemporaryDirectory()
        root = pathlib.Path(self.temp.name) / "cache"
        root.mkdir()
        self.catalog = CacheCatalog(root, FakeActivity())
        self.original_catalog = main.catalog
        main.catalog = self.catalog

        self.pdf = pathlib.Path(self.temp.name) / "Book.pdf"
        self.pdf.write_bytes(b"pdf")
        self.entry = root / HASH
        self.entry.mkdir()
        self.canonical = self.entry / "Book.html"
        self.canonical.write_text("canonical", encoding="utf-8")
        self.light = self.entry / "Book.light.html"
        self.light.write_text("light", encoding="utf-8")
        self.catalog.mappings_path.write_text(
            f"2026-01-01\t{self.pdf.resolve()}\t{HASH}\t{self.canonical}\n",
            encoding="utf-8",
        )

        self.remote_hash = url_hash(REMOTE_URL)
        self.remote_entry = root / self.remote_hash
        self.remote_entry.mkdir()
        self.remote_canonical = self.remote_entry / "Remote.html"
        self.remote_canonical.write_text("remote canonical", encoding="utf-8")
        self.remote_light = self.remote_entry / "Remote.light.html"
        self.remote_light.write_text("remote light", encoding="utf-8")

    def tearDown(self):
        main.catalog = self.original_catalog
        self.temp.cleanup()

    def selected_path(self, response: FileResponse) -> pathlib.Path:
        return pathlib.Path(response.path).resolve()

    @staticmethod
    def raw_request(path: str, url: str) -> Request:
        return Request({
            "type": "http",
            "method": "GET",
            "scheme": "http",
            "path": path,
            "raw_path": path.encode("ascii"),
            "query_string": url.encode("ascii"),
            "headers": [],
            "server": ("testserver", 80),
            "client": ("testclient", 50000),
        })

    def test_normal_view_defaults_to_light_for_unset_or_unrecognized_preference(self):
        for preference in (None, "maybe"):
            with self.subTest(preference=preference):
                environment = {} if preference is None else {"PDF_VIEWER_PREFER_LIGHT": preference}
                with patch.dict("os.environ", environment, clear=True):
                    response = main.view(BackgroundTasks(), path=str(self.pdf), url=None)
                self.assertEqual(self.selected_path(response), self.light.resolve())

    def test_normal_view_honors_explicit_canonical_rollback_values(self):
        for preference in ("false", "0", "no", "off"):
            with self.subTest(preference=preference):
                with patch.dict("os.environ", {"PDF_VIEWER_PREFER_LIGHT": preference}, clear=True):
                    response = main.view(BackgroundTasks(), path=str(self.pdf), url=None)
                self.assertEqual(self.selected_path(response), self.canonical.resolve())

    def test_normal_view_falls_back_to_canonical_when_light_is_unavailable(self):
        self.light.unlink()
        with patch.dict("os.environ", {}, clear=True):
            response = main.view(BackgroundTasks(), path=str(self.pdf), url=None)
        self.assertEqual(self.selected_path(response), self.canonical.resolve())

    def test_light_route_explicitly_prefers_light(self):
        with patch.dict("os.environ", {}, clear=True):
            response = main.view_light(BackgroundTasks(), path=str(self.pdf), url=None)
        self.assertEqual(self.selected_path(response), self.light.resolve())

    def test_canonical_route_is_explicit_rollback(self):
        with patch.dict("os.environ", {"PDF_VIEWER_PREFER_LIGHT": "on"}, clear=True):
            response = main.view_canonical(BackgroundTasks(), path=str(self.pdf), url=None)
        self.assertEqual(self.selected_path(response), self.canonical.resolve())

    def test_raw_url_routes_honor_preference_and_explicit_overrides(self):
        normal = self.raw_request("/view-raw", REMOTE_URL)
        light = self.raw_request("/view-light-raw", REMOTE_URL)
        canonical = self.raw_request("/view-canonical-raw", REMOTE_URL)

        with patch.dict("os.environ", {}, clear=True):
            response = main.view_raw(normal, BackgroundTasks())
        self.assertEqual(self.selected_path(response), self.remote_light.resolve())

        with patch.dict("os.environ", {"PDF_VIEWER_PREFER_LIGHT": "off"}, clear=True):
            response = main.view_raw(normal, BackgroundTasks())
            light_response = main.view_light_raw(light, BackgroundTasks())
            canonical_response = main.view_canonical_raw(canonical, BackgroundTasks())
        self.assertEqual(self.selected_path(response), self.remote_canonical.resolve())
        self.assertEqual(self.selected_path(light_response), self.remote_light.resolve())
        self.assertEqual(self.selected_path(canonical_response), self.remote_canonical.resolve())


if __name__ == "__main__":
    unittest.main()

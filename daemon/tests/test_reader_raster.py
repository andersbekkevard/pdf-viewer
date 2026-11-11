"""Page rasters: formats, shared and cancellable renders, the cache budget."""
from __future__ import annotations

import concurrent.futures
import os
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import reader  # noqa: E402
from test_reader import _pdf  # noqa: E402

TWO_PAGES = _pdf([
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] >>",
])
HASH = "ab" * 8


class RenderTest(unittest.TestCase):
    """Real renders in worker processes."""

    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        root = pathlib.Path(cls.temp.name)
        cls.pdf = root / "doc.pdf"
        cls.pdf.write_bytes(TWO_PAGES)
        (root / "cache" / HASH).mkdir(parents=True)
        cls.reader = reader.Reader(root / "cache", workers=2)

    @classmethod
    def tearDownClass(cls):
        if cls.reader._pool is not None:
            cls.reader._pool.shutdown()
        cls.temp.cleanup()

    def test_jpeg_and_png_are_cached_apart(self):
        jpg = self.reader.raster(HASH, self.pdf, 1, 300, "jpg")
        png = self.reader.raster(HASH, self.pdf, 1, 300, "png")
        self.assertEqual(jpg.suffix, ".jpg")
        self.assertEqual(jpg.read_bytes()[:3], b"\xff\xd8\xff")
        self.assertEqual(png.read_bytes()[:8], b"\x89PNG\r\n\x1a\n")
        self.assertEqual(jpg.parent, png.parent)
        # Cached: same path again, without a render.
        with patch.object(self.reader, "_submit", side_effect=AssertionError("rendered twice")):
            self.assertEqual(self.reader.raster(HASH, self.pdf, 1, 300, "jpg"), jpg)

    def test_unknown_format_and_page(self):
        with self.assertRaises(ValueError):
            self.reader.raster(HASH, self.pdf, 1, 300, "gif")
        with self.assertRaises(IndexError):
            self.reader.raster(HASH, self.pdf, 3, 300, "jpg")


class JobTest(unittest.TestCase):
    """Job bookkeeping, with the worker queue replaced by futures the test settles."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = pathlib.Path(self.temp.name)
        self.pdf = root / "doc.pdf"
        self.pdf.write_bytes(TWO_PAGES)
        (root / "cache" / HASH).mkdir(parents=True)
        self.reader = reader.Reader(root / "cache", workers=1, raster_cache_bytes=10_000)
        self.reader._sizes[(str(self.pdf), 0, 0)] = [(612.0, 792.0), (600.0, 800.0)]
        self.reader.sizes = lambda pdf: [(612.0, 792.0), (600.0, 800.0)]
        self.tasks: list[tuple[concurrent.futures.Future, tuple, float | None]] = []

        def submit(fn, *args, urgent=True, priority=None):
            future: concurrent.futures.Future = concurrent.futures.Future()
            self.tasks.append((future, args, priority))
            return future
        self.reader._submit = submit

    def tearDown(self):
        self.temp.cleanup()

    def test_requests_share_one_render(self):
        a, key_a = self.reader.raster_job(HASH, self.pdf, 1, 300, "jpg")
        b, key_b = self.reader.raster_job(HASH, self.pdf, 1, 300, "jpg")
        self.assertEqual(len(self.tasks), 1)
        self.assertIs(a, b)
        self.tasks[0][0].set_result(b"\xff\xd8\xffdata")
        self.assertEqual(a.result(timeout=5).read_bytes(), b"\xff\xd8\xffdata")
        self.reader.raster_release(key_a)
        self.reader.raster_release(key_b)
        self.assertEqual(self.reader._raster_jobs, {})

    def test_released_queued_render_is_dropped(self):
        future, key = self.reader.raster_job(HASH, self.pdf, 2, 300, "jpg")
        task = self.tasks[0][0]
        self.reader.raster_release(key)
        self.assertTrue(task.cancelled(), "a queued render nobody waits for must not run")
        self.assertTrue(future.cancelled())
        self.assertEqual(self.reader._raster_jobs, {})
        # A later request starts a fresh render.
        again, key = self.reader.raster_job(HASH, self.pdf, 2, 300, "jpg")
        self.assertEqual(len(self.tasks), 2)
        self.assertFalse(again.done())

    def test_render_kept_while_another_request_waits(self):
        _, key_a = self.reader.raster_job(HASH, self.pdf, 1, 300, "jpg")
        b, key_b = self.reader.raster_job(HASH, self.pdf, 1, 300, "jpg")
        self.reader.raster_release(key_a)
        self.assertFalse(self.tasks[0][0].cancelled())
        self.tasks[0][0].set_result(b"x")
        self.assertTrue(b.result(timeout=5).is_file())

    def test_running_render_finishes_and_is_cached(self):
        future, key = self.reader.raster_job(HASH, self.pdf, 1, 300, "jpg")
        task = self.tasks[0][0]
        task.set_running_or_notify_cancel()
        self.reader.raster_release(key)
        task.set_result(b"y")
        self.assertTrue(future.result(timeout=5).is_file())

    def test_priority_reaches_the_queue(self):
        self.reader.raster_job(HASH, self.pdf, 1, 300, "jpg")
        self.reader.raster_job(HASH, self.pdf, 2, 300, "jpg", 0.5)
        self.assertEqual([t[2] for t in self.tasks], [0, 0.5])

    def test_render_error_reaches_the_request(self):
        future, key = self.reader.raster_job(HASH, self.pdf, 1, 300, "jpg")
        self.tasks[0][0].set_exception(RuntimeError("pdfium"))
        with self.assertRaises(RuntimeError):
            future.result(timeout=5)
        self.reader.raster_release(key)

    def test_cache_stays_within_budget(self):
        # Budget 10 kB; each raster 3 kB, written with increasing mtimes.
        paths = []
        for page, width in [(1, 100), (1, 200), (1, 300), (1, 400), (1, 500), (2, 100)]:
            future, key = self.reader.raster_job(HASH, self.pdf, page, width, "jpg")
            self.tasks[-1][0].set_result(b"z" * 3000)
            path = future.result(timeout=5)
            self.reader.raster_release(key)
            os.utime(path, (len(paths) + 1_000_000, len(paths) + 1_000_000))
            paths.append(path)
            for _ in range(100):  # eviction runs on its own thread
                if not self.reader._evicting:
                    break
                threading_sleep()
        files = list((self.reader.root / HASH / "reader" / "px").glob("*/*.jpg"))
        self.assertLessEqual(sum(f.stat().st_size for f in files), 10_000)
        self.assertTrue(paths[-1].is_file(), "the newest raster survives")
        self.assertFalse(paths[0].is_file(), "the least recently used raster goes first")


class RouteTest(unittest.IsolatedAsyncioTestCase):
    """The async raster route lets go of a render when its request goes away."""

    async def test_disconnect_releases_the_render(self):
        import main

        pending: concurrent.futures.Future = concurrent.futures.Future()
        released = []

        class FakeReader:
            def raster_job(self, *args):
                return pending, "key"

            def raster_release(self, key):
                released.append(key)

        class Gone:
            async def is_disconnected(self):
                return True

        with patch.object(main, "reader", FakeReader()), \
                patch.object(main, "_reader_source", lambda hash_: pathlib.Path("/nonexistent.pdf")):
            response = await main._reader_raster(Gone(), HASH, 1, 300, "jpg")
        self.assertEqual(response.status_code, 499)
        self.assertEqual(released, ["key"])


def threading_sleep():
    import time
    time.sleep(0.01)


if __name__ == "__main__":
    unittest.main()

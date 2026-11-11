"""Reader delivery: the raw file:// route and the sign-in relay.

The relay is driven against a fake extension that long-polls the signal
queue like extension/background.js and answers fetch signals through the
same PUT /fetch/<id> handler, so no browser is needed.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import pathlib
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

from fastapi import BackgroundTasks, HTTPException
from starlette.requests import Request

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import main  # noqa: E402
import sources  # noqa: E402
from catalog import CacheCatalog, url_hash  # noqa: E402

SOURCE = "https://gated.test/course/notes.pdf"
TAB_URL = SOURCE + "?_pdfvw=passthrough"
BASE = "http://localhost:7435"
PDF = b"%PDF-1.4 relayed bytes"


def raw_request(query: bytes) -> Request:
    return Request({"type": "http", "method": "GET", "headers": [], "query_string": query})


def upload(body: bytes = b"", headers: dict[str, str] | None = None) -> Request:
    sent = False

    async def receive():
        nonlocal sent
        if sent:
            return {"type": "http.disconnect"}
        sent = True
        return {"type": "http.request", "body": body, "more_body": False}

    raw = [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()]
    return Request({"type": "http", "method": "PUT", "headers": raw}, receive)


class FakeExtension:
    """Answers fetch signals the way background.js does: ignores the first
    `ignore` signals (the tab had not committed its URL yet), then
    acknowledges and uploads `body`, or reports `error`."""

    def __init__(self, *, ignore=0, body=PDF, error=None, disposition='inline; filename="Week 3 Notes.pdf"'):
        self.ignore, self.body, self.error, self.disposition = ignore, body, error, disposition
        self.seen: list[int] = []
        self.task = asyncio.get_running_loop().create_task(self.run())

    async def run(self):
        cursor = 0
        while True:
            for sig in await main.signal_navigate_wait(timeout=1.0, since=cursor):
                cursor = max(cursor, sig["id"])
                if sig["type"] != "fetch":
                    continue
                self.seen.append(sig["id"])
                if len(self.seen) <= self.ignore:
                    continue
                try:
                    started = await main.fetch_put(sig["id"], upload(headers={"X-Fetch-Started": "1"}))
                except HTTPException:
                    continue
                if not started["accepted"]:
                    continue
                if self.error:
                    await main.fetch_put(sig["id"], upload(headers={"X-Fetch-Error": self.error}))
                else:
                    await main.fetch_put(sig["id"], upload(self.body, {
                        "X-Source-Content-Type": "application/pdf",
                        "X-Source-Content-Disposition": self.disposition,
                    }))

    async def stop(self):
        self.task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await self.task


class RelayTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)
        self.catalog = CacheCatalog(self.root)
        self.hash = url_hash(SOURCE)
        patches = [
            patch.object(main, "catalog", self.catalog),
            patch.object(main, "CACHE_DIR", self.root),
            patch.object(main, "_loop", asyncio.get_running_loop()),
            patch.object(main, "_RELAY_FIRST_ASK_SEC", 0.01),
            patch.object(main, "_RELAY_ANSWER_WAIT_SEC", (0.15, 0.15, 0.15)),
            patch.object(main, "_RELAY_DOWNLOAD_SEC", 2.0),
            patch.object(main, "_RELAY_POLL_SEC", 0.01),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        main._pending_nav_signals.clear()
        main._nav_signal_event = None
        main._fetches.clear()
        main._relays.clear()
        self.extension = None

    async def asyncTearDown(self):
        if self.extension is not None:
            await self.extension.stop()
        for task in list(main._relays.values()):
            task.cancel()
        main._relays.clear()
        self.tmp.cleanup()

    def signals(self, kind):
        return [s for s in main._pending_nav_signals if s["type"] == kind]

    async def relay(self):
        task = main._start_relay(self.hash, TAB_URL, SOURCE, BASE)
        self.assertIsNotNone(task)
        return await asyncio.wait_for(task, 5)

    def assert_nothing_stored(self):
        self.assertFalse((self.root / self.hash / "_source").exists())
        self.assertIsNone(self.catalog.manifests().get(self.hash))
        self.assertEqual(self.signals("navigate"), [])

    async def test_relay_stores_registers_and_navigates(self):
        self.extension = FakeExtension()
        self.assertTrue(await self.relay())
        stored = self.root / self.hash / "_source" / "Week 3 Notes.pdf"
        self.assertEqual(stored.read_bytes(), PDF)
        manifest = json.loads((self.root / self.hash / "entry.json").read_text())
        self.assertEqual(manifest, {"name": "Week 3 Notes", "source_ref": SOURCE})
        self.assertEqual(
            [(s["from_url"], s["to_url"]) for s in self.signals("navigate")],
            [(TAB_URL, f"{BASE}/r/{self.hash}/")],
        )
        self.assertEqual(main._fetches, {})  # nothing left for anyone to collect
        self.assertEqual(main._relays, {})

    async def test_signal_before_the_tab_committed_is_asked_again(self):
        self.extension = FakeExtension(ignore=2)
        self.assertTrue(await self.relay())
        fetch_ids = [s["id"] for s in self.signals("fetch")]
        self.assertEqual(len(fetch_ids), 3)
        self.assertEqual(len(set(fetch_ids)), 3)  # a fresh id each time
        self.assertEqual(len(self.signals("navigate")), 1)

    async def test_silent_extension_gives_up_after_bounded_asks(self):
        loop = asyncio.get_running_loop()
        start = loop.time()
        self.assertFalse(await self.relay())
        self.assertLess(loop.time() - start, 1.5)
        self.assertEqual(len(self.signals("fetch")), len(main._RELAY_ANSWER_WAIT_SEC))
        self.assertEqual(main._fetches, {})
        self.assert_nothing_stored()

    async def test_extension_error_gives_up(self):
        self.extension = FakeExtension(error="browser fetch got text/html, not a PDF")
        self.assertFalse(await self.relay())
        self.assertEqual(len(self.signals("fetch")), 1)  # an answer is final
        self.assert_nothing_stored()

    async def test_non_pdf_bytes_are_not_stored(self):
        self.extension = FakeExtension(body=b"<html>sign in</html>")
        self.assertFalse(await self.relay())
        self.assert_nothing_stored()

    async def test_one_relay_per_hash(self):
        first = main._start_relay(self.hash, TAB_URL, SOURCE, BASE)
        self.assertIsNotNone(first)
        self.assertIsNone(main._start_relay(self.hash, TAB_URL, SOURCE, BASE))
        main._request_relay(self.hash, TAB_URL, SOURCE, BASE)
        self.assertIs(main._relays[self.hash], first)
        self.assertFalse(await asyncio.wait_for(first, 5))
        self.assertEqual(len(self.signals("fetch")), len(main._RELAY_ANSWER_WAIT_SEC))
        # Once finished, a later click may try again.
        self.extension = FakeExtension()
        self.assertTrue(await self.relay())

    async def test_disabled_entry_never_relays(self):
        self.catalog.set_disabled(self.hash, True)
        self.assertIsNone(main._start_relay(self.hash, TAB_URL, SOURCE, BASE))
        with patch.object(sources, "download") as download:
            response = await asyncio.to_thread(
                main._view_url, SOURCE, BackgroundTasks(), light=True, reader_first=True, base_url=BASE)
        download.assert_not_called()
        self.assertEqual(response.headers["location"], TAB_URL)
        await asyncio.sleep(0.05)
        self.assertEqual(main._relays, {})
        self.assertEqual(self.signals("fetch"), [])

    async def test_entry_disabled_during_relay_stays_native(self):
        self.extension = FakeExtension(ignore=1)
        task = main._start_relay(self.hash, TAB_URL, SOURCE, BASE)
        self.catalog.set_disabled(self.hash, True)
        self.assertFalse(await asyncio.wait_for(task, 5))
        self.assert_nothing_stored()

    async def test_failed_download_starts_relay_from_worker_thread_then_reader_opens_directly(self):
        self.extension = FakeExtension(ignore=1)
        failing = patch.object(sources, "download", side_effect=sources.SourceError("sign-in page"))
        with failing:
            # Sync routes run in a worker thread; the relay must land on the loop.
            response = await asyncio.to_thread(
                main._view_url, SOURCE, BackgroundTasks(), light=True, reader_first=True, base_url=BASE)
        self.assertEqual(response.status_code, 307)
        self.assertEqual(response.headers["location"], TAB_URL)
        for _ in range(100):
            if self.hash in main._relays:
                break
            await asyncio.sleep(0.01)
        self.assertTrue(await asyncio.wait_for(main._relays[self.hash], 5))
        self.assertEqual(len(self.signals("navigate")), 1)
        # A later plain click on the same link finds the stored source.
        with patch.object(sources, "download", side_effect=AssertionError("no download")):
            again = await asyncio.to_thread(
                main._view_url, SOURCE, BackgroundTasks(), light=True, reader_first=True, base_url=BASE)
        self.assertEqual(again.headers["location"], f"/r/{self.hash}/")
        self.assertEqual(main._relays, {})

    async def test_default_engine_route_never_relays(self):
        with patch.object(sources, "download") as download:
            response = await asyncio.to_thread(
                main._view_url, SOURCE, BackgroundTasks(), light=True, reader_first=False, base_url=BASE)
        download.assert_not_called()
        self.assertEqual(response.headers["location"], TAB_URL)
        await asyncio.sleep(0.05)
        self.assertEqual(main._relays, {})

    async def test_signal_queued_from_worker_thread_wakes_pollers(self):
        waiter = asyncio.create_task(main.signal_navigate_wait(timeout=5.0, since=0))
        await asyncio.sleep(0.05)
        start = asyncio.get_running_loop().time()
        # A bare thread: asyncio.to_thread's own completion would wake the
        # loop and hide a wake-up lost off the loop thread.
        threading.Thread(target=main._queue_extension_sync_signal, args=(self.hash, "test")).start()
        got = await asyncio.wait_for(waiter, 2)
        self.assertEqual([s["type"] for s in got], ["sync_rules"])
        self.assertLess(asyncio.get_running_loop().time() - start, 1.0)


class RawFileRouteTests(unittest.TestCase):
    def path(self, query: bytes) -> str:
        return main._raw_file_path(raw_request(query))

    def rejects(self, query: bytes):
        with self.assertRaises(HTTPException) as ctx:
            self.path(query)
        self.assertEqual(ctx.exception.status_code, 400)

    def test_decodes_percent_encoded_paths(self):
        self.assertEqual(self.path(b"file:///Users/me/My%20Notes.pdf"), "/Users/me/My Notes.pdf")
        self.assertEqual(self.path(b"file:///tmp/%C3%B8vinger%20%26%20svar.PDF"), "/tmp/øvinger & svar.PDF")
        self.assertEqual(self.path(b"file://localhost/tmp/a.pdf"), "/tmp/a.pdf")

    def test_drops_query_and_fragment(self):
        self.assertEqual(self.path(b"file:///tmp/a.pdf?x=1&y=2"), "/tmp/a.pdf")
        self.assertEqual(self.path(b"file:///tmp/a.pdf#page=3"), "/tmp/a.pdf")

    def test_rejects_everything_else(self):
        self.rejects(b"")
        self.rejects(b"https://example.com/a.pdf")
        self.rejects(b"file://fileserver/share/a.pdf")
        self.rejects(b"file:///etc/passwd")
        self.rejects(b"file:///tmp/a.pdf%00.txt")
        self.rejects(b"file:///tmp/%FF.pdf")
        self.rejects("file:///tmp/ø.pdf".encode())

    def test_route_opens_the_reader_in_reader_mode(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp) / "cache"
            pdf = pathlib.Path(tmp) / "My Notes.pdf"
            from test_reader import LINKS_PDF
            pdf.write_bytes(LINKS_PDF)
            query = pdf.resolve().as_uri().encode()
            with patch.object(main, "catalog", CacheCatalog(root)), \
                    patch.dict("os.environ", {"PDF_VIEWER_ENGINE": "reader"}):
                response = main.view_file_raw(raw_request(query), BackgroundTasks())
                self.assertEqual(response.status_code, 307)
                self.assertRegex(response.headers["location"], r"^/r/[a-f0-9]{16}/\?local=")
            with patch.object(main, "catalog", CacheCatalog(root)), \
                    patch.dict("os.environ", {"PDF_VIEWER_ENGINE": "pdf2htmlex"}):
                response = main.view_file_raw(raw_request(query), BackgroundTasks())
                self.assertEqual(response.media_type, "application/pdf")


class EngineAndSaveTests(unittest.TestCase):
    def test_healthz_reports_engine(self):
        with patch.dict("os.environ", {"PDF_VIEWER_ENGINE": "reader"}):
            self.assertEqual(main.healthz()["engine"], "reader")
        with patch.dict("os.environ", {}, clear=False) as env:
            env.pop("PDF_VIEWER_ENGINE", None)
            self.assertEqual(main.healthz()["engine"], "pdf2htmlex")

    def test_save_checks_bytes_and_names_from_disposition(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = pathlib.Path(tmp) / "_source"
            with self.assertRaises(sources.SourceError):
                sources.save(b"<html>", SOURCE, "", target)
            self.assertFalse(target.exists())
            self.assertEqual(sources.save(PDF, SOURCE, "", target), "notes.pdf")
            self.assertEqual(sources.save(PDF, SOURCE, "attachment; filename*=UTF-8''HW%202.pdf", target),
                             "HW 2.pdf")
            self.assertEqual(sorted(p.name for p in target.iterdir()), ["HW 2.pdf", "notes.pdf"])

    def test_failed_download_leaves_no_entry_directory(self):
        # The sign-in page that starts a relay must not litter the cache.
        import http.server

        class SignIn(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.end_headers()
                self.wfile.write(b"<html>sign in</html>")

            def log_message(self, *args):
                pass

        server = http.server.HTTPServer(("127.0.0.1", 0), SignIn)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        with tempfile.TemporaryDirectory() as tmp:
            target = pathlib.Path(tmp) / "abcdef0123456789" / "_source"
            with self.assertRaises(sources.SourceError):
                sources.download(f"http://127.0.0.1:{server.server_port}/doc.pdf", target)
            self.assertEqual(list(pathlib.Path(tmp).iterdir()), [])


if __name__ == "__main__":
    unittest.main()

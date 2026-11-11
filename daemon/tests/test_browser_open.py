"""Browser opens: a sign-in-gated URL goes from the link straight to the reader.

The tab's `/view-raw` request (`main._view_url`) runs in a worker thread as
FastAPI runs it, and a fake extension claims the open through
`POST /extension/open` and answers through `PUT /extension/open/<id>`, the way
extension/background.js does, so no browser is needed.
"""
from __future__ import annotations

import asyncio
import json
import os
import pathlib
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from fastapi import BackgroundTasks
from starlette.requests import Request

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import main  # noqa: E402
import sources  # noqa: E402
from catalog import CacheCatalog, url_hash  # noqa: E402

SOURCE = "https://gated.test/course/notes.pdf"
FALLBACK = SOURCE + "?_pdfvw=passthrough"
BASE = "http://localhost:7435"
PDF = b"%PDF-1.4 browser bytes"
DISPOSITION = 'inline; filename="Week 3 Notes.pdf"'


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


class BrowserOpenTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)
        self.catalog = CacheCatalog(self.root)
        self.hash = url_hash(SOURCE)
        patches = [
            patch.object(main, "catalog", self.catalog),
            patch.object(main, "CACHE_DIR", self.root),
            patch.object(main, "_loop", asyncio.get_running_loop()),
            patch.object(main, "_OPEN_CLAIM_GRACE_SEC", 0.3),
            patch.object(main, "_OPEN_HOLD_SEC", 0.6),
            patch.object(main, "_OPEN_CLAIM_WAIT_SEC", 0.5),
            patch.object(main, "_extension_open_seen", time.monotonic()),
            patch.dict(os.environ, {"PDF_VIEWER_ENGINE": "reader"}),
            # A fallback must not leave a relay asking a missing extension.
            patch.object(main, "_request_relay"),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.relay = main._request_relay
        main._opens.clear()
        main._open_results.clear()

    async def asyncTearDown(self):
        main._opens.clear()
        main._open_results.clear()
        self.tmp.cleanup()

    def tab(self, url: str = SOURCE):
        """The tab's held navigation, as FastAPI runs a sync route."""
        return asyncio.create_task(asyncio.to_thread(
            main._view_url, url, BackgroundTasks(), light=True, reader_first=True, base_url=BASE))

    async def claim(self, url: str = SOURCE) -> dict:
        return await asyncio.to_thread(main.extension_open, main.ExtensionOpenRequest(url=url))

    async def answer(self, claim: dict, body: bytes = PDF, headers: dict | None = None,
                     *, offset: int = 0, done: int = 1) -> dict:
        response = await main.extension_open_put(claim["id"], upload(body, headers or {
            "X-Source-Content-Disposition": DISPOSITION}), offset=offset, done=done)
        return response if isinstance(response, dict) else json.loads(response.body)

    def gated_hosts(self) -> list[str]:
        return main._gated_hosts()

    def assert_nothing_stored(self):
        self.assertFalse((self.root / self.hash / "_source").exists())
        self.assertIsNone(self.catalog.manifests().get(self.hash))

    async def test_unknown_host_downloads_first_then_takes_the_browser_bytes(self):
        with patch.object(sources, "download", side_effect=sources.SourceError("sign-in page")) as download:
            claim = asyncio.create_task(self.claim())    # the extension asks at once
            tab = self.tab()
            got = await asyncio.wait_for(claim, 3)
            self.assertTrue(got["fetch"])
            self.assertEqual(await self.answer(got), {"accepted": True})
            response = await asyncio.wait_for(tab, 3)
        download.assert_called_once()
        self.assertEqual(response.status_code, 307)
        self.assertEqual(response.headers["location"], f"/r/{self.hash}/")
        self.assertTrue((self.root / self.hash / "_source" / "Week 3 Notes.pdf").is_file())
        self.assertEqual(self.catalog.manifests()[self.hash]["name"], "Week 3 Notes")
        self.assertEqual(self.gated_hosts(), ["gated.test"])
        self.relay.assert_not_called()

    async def test_known_gated_host_skips_the_cookieless_download(self):
        main._remember_gated_host(SOURCE)
        with patch.object(sources, "download", side_effect=AssertionError("no download")):
            tab = self.tab()
            got = await asyncio.wait_for(self.claim(), 3)
            await self.answer(got)
            response = await asyncio.wait_for(tab, 3)
        self.assertEqual(response.headers["location"], f"/r/{self.hash}/")

    async def test_sign_in_page_sends_the_tab_to_the_original_url(self):
        main._remember_gated_host(SOURCE)
        tab = self.tab()
        got = await asyncio.wait_for(self.claim(), 3)
        await self.answer(got, b"", {"X-Fetch-Error": "got text/html, not a PDF (signed out?)"})
        response = await asyncio.wait_for(tab, 3)
        self.assertEqual(response.status_code, 307)
        self.assertEqual(response.headers["location"], FALLBACK)
        self.assert_nothing_stored()
        self.relay.assert_not_called()

    async def test_non_pdf_upload_is_not_stored(self):
        main._remember_gated_host(SOURCE)
        tab = self.tab()
        got = await asyncio.wait_for(self.claim(), 3)
        await self.answer(got, b"<!doctype html>sign in")
        response = await asyncio.wait_for(tab, 3)
        self.assertEqual(response.headers["location"], FALLBACK)
        self.assert_nothing_stored()

    async def test_unclaimed_open_falls_back_to_the_viewer_and_the_relay(self):
        main._remember_gated_host(SOURCE)
        start = time.monotonic()
        response = await asyncio.wait_for(self.tab(), 3)
        self.assertEqual(response.headers["location"], FALLBACK)
        self.assertGreaterEqual(time.monotonic() - start, 0.25)   # waited for a claim
        self.relay.assert_called_once_with(self.hash, FALLBACK, SOURCE, BASE)

    async def test_without_a_listening_extension_the_fallback_is_immediate(self):
        main._remember_gated_host(SOURCE)
        with patch.object(main, "_extension_open_seen", 0.0):
            start = time.monotonic()
            response = await asyncio.wait_for(self.tab(), 3)
        self.assertLess(time.monotonic() - start, 0.2)
        self.assertEqual(response.headers["location"], FALLBACK)
        self.relay.assert_called_once()

    async def test_slow_transfer_gets_the_holding_page_which_learns_the_target(self):
        main._remember_gated_host(SOURCE)
        tab = self.tab()
        got = await asyncio.wait_for(self.claim(), 3)
        response = await asyncio.wait_for(tab, 3)
        self.assertEqual(response.status_code, 200)
        page = response.body.decode()
        self.assertIn(f"const id = {got['id']};", page)
        self.assertIn(json.dumps(FALLBACK), page)
        self.assertEqual(main.extension_open_status(got["id"], wait=0.0), {"state": "claimed"})
        waiter = asyncio.create_task(asyncio.to_thread(main.extension_open_status, got["id"], 3.0))
        await asyncio.sleep(0.05)
        await self.answer(got)
        self.assertEqual(await asyncio.wait_for(waiter, 3), {"state": "done", "target": f"/r/{self.hash}/"})

    async def test_daemon_download_succeeds_and_the_claim_is_declined(self):
        def download(url, target_dir):
            target_dir.mkdir(parents=True)
            (target_dir / "notes.pdf").write_bytes(PDF)
            return "notes.pdf"
        with patch.object(sources, "download", side_effect=download):
            claim = asyncio.create_task(self.claim())
            response = await asyncio.wait_for(self.tab(), 3)
            self.assertEqual(await asyncio.wait_for(claim, 3), {"fetch": False})
        self.assertEqual(response.headers["location"], f"/r/{self.hash}/")
        self.assertEqual(self.gated_hosts(), [])

    async def test_claim_for_a_stored_source_returns_at_once(self):
        source_dir = self.root / self.hash / "_source"
        source_dir.mkdir(parents=True)
        (source_dir / "notes.pdf").write_bytes(PDF)
        start = time.monotonic()
        self.assertEqual(await self.claim(), {"fetch": False})
        self.assertLess(time.monotonic() - start, 0.1)

    async def test_claim_without_an_open_gives_up(self):
        self.assertEqual(await self.claim(), {"fetch": False})

    async def test_claims_are_refused_by_the_pdf2htmlex_engine(self):
        with patch.dict(os.environ, {"PDF_VIEWER_ENGINE": "pdf2htmlex"}):
            self.assertEqual(await self.claim(), {"fetch": False})

    async def test_only_one_claim_and_one_answer_count(self):
        main._remember_gated_host(SOURCE)
        tab = self.tab()
        first = await asyncio.wait_for(self.claim(), 3)
        second = await asyncio.wait_for(self.claim(SOURCE + "?sig=other"), 3)
        self.assertTrue(first["fetch"])
        self.assertEqual(second, {"fetch": False})
        await self.answer(first)
        self.assertEqual(await self.answer(first), {"accepted": False})
        response = await asyncio.wait_for(tab, 3)
        self.assertEqual(response.headers["location"], f"/r/{self.hash}/")

    async def test_upload_for_an_unknown_open_is_rejected(self):
        self.assertEqual(await self.answer({"id": 12345}), {"accepted": False})
        self.assert_nothing_stored()

    async def test_a_second_tab_joins_the_open(self):
        main._remember_gated_host(SOURCE)
        tab = self.tab()
        got = await asyncio.wait_for(self.claim(), 3)
        other = self.tab()
        await asyncio.sleep(0.05)
        await self.answer(got)
        for response in await asyncio.wait_for(asyncio.gather(tab, other), 3):
            self.assertEqual(response.headers["location"], f"/r/{self.hash}/")

    async def test_claimed_open_without_upload_expires_to_the_original_url(self):
        main._remember_gated_host(SOURCE)
        with patch.object(main, "_OPEN_STALL_SEC", 0.2), patch.object(main, "_OPEN_HOLD_SEC", 2.0):
            tab = self.tab()
            await asyncio.wait_for(self.claim(), 3)
            response = await asyncio.wait_for(tab, 3)
        self.assertEqual(response.headers["location"], FALLBACK)

    async def test_upload_in_pieces_keeps_a_slow_transfer_alive(self):
        main._remember_gated_host(SOURCE)
        body = PDF + bytes(range(256)) * 40
        pieces = [body[i:i + 1000] for i in range(0, len(body), 1000)]
        with patch.object(main, "_OPEN_STALL_SEC", 0.3), patch.object(main, "_OPEN_HOLD_SEC", 3.0):
            tab = self.tab()
            got = await asyncio.wait_for(self.claim(), 3)
            offset = 0
            for n, piece in enumerate(pieces):
                await asyncio.sleep(0.1)   # slower in total than the stall bound
                last = int(n == len(pieces) - 1)
                self.assertEqual(await self.answer(got, piece, offset=offset, done=last), {"accepted": True})
                offset += len(piece)
            response = await asyncio.wait_for(tab, 3)
        self.assertEqual(response.headers["location"], f"/r/{self.hash}/")
        self.assertEqual((self.root / self.hash / "_source" / "Week 3 Notes.pdf").read_bytes(), body)
        self.assertEqual([p.name for p in (self.root / self.hash / "_source").iterdir()], ["Week 3 Notes.pdf"])

    async def test_a_gap_in_the_pieces_fails_the_open_and_leaves_nothing(self):
        main._remember_gated_host(SOURCE)
        tab = self.tab()
        got = await asyncio.wait_for(self.claim(), 3)
        await self.answer(got, PDF, done=0)
        self.assertEqual(await self.answer(got, b"more", offset=len(PDF) + 10), {"accepted": False})
        response = await asyncio.wait_for(tab, 3)
        self.assertEqual(response.headers["location"], FALLBACK)
        self.assertFalse((self.root / self.hash).exists())

    async def test_a_non_pdf_first_piece_fails_at_once(self):
        main._remember_gated_host(SOURCE)
        tab = self.tab()
        got = await asyncio.wait_for(self.claim(), 3)
        self.assertEqual(await self.answer(got, b"<!doctype html>", done=0), {"accepted": False})
        response = await asyncio.wait_for(tab, 3)
        self.assertEqual(response.headers["location"], FALLBACK)
        self.assertFalse((self.root / self.hash).exists())

    async def test_gated_hosts_survive_a_corrupt_file(self):
        (self.root / main._GATED_HOSTS_FILE).write_text("not json")
        self.assertEqual(self.gated_hosts(), [])
        main._remember_gated_host(SOURCE)
        self.assertEqual(self.gated_hosts(), ["gated.test"])


if __name__ == "__main__":
    unittest.main()

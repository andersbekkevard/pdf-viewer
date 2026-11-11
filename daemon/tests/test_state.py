from __future__ import annotations

import asyncio
import json
import pathlib
import sys
import tempfile
import unittest

from fastapi import FastAPI, HTTPException

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import state  # noqa: E402
import state_routes  # noqa: E402

try:
    from fastapi.testclient import TestClient
except (ImportError, RuntimeError):  # httpx is not a daemon dependency
    TestClient = None

HASH = "19f1998aa6212b01"


class StateTestCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.original = state.DB_PATH
        state.DB_PATH = pathlib.Path(self.temp.name) / "state.db"

    def tearDown(self):
        state.DB_PATH = self.original
        self.temp.cleanup()


class PinsInheritanceTest(StateTestCase):
    def test_rewrite_clamps_pin_page_and_preserves_anchor_and_number(self):
        pins = [{"number": 3, "page": 9, "y": .42, "x": .1, "title": "Return", "ts": 100}]
        state.put(HASH, "pins", pins, 100)
        state.inherit_local(HASH, "aabbccddeeff", 4)
        pin = state.get_all("aabbccddeeff")["pins"]["value"][0]
        self.assertEqual(pin, dict(pins[0], page=4))
        state.inherit_local(HASH, "aabbccddeeff", 2)
        self.assertEqual(state.get_all("aabbccddeeff")["pins"]["value"][0]["page"], 4)


class LastWriterWinsTest(StateTestCase):
    def test_empty_hash_has_no_state(self):
        self.assertEqual(state.get_all(HASH), {})

    def test_newer_write_replaces_older(self):
        state.put(HASH, "position", {"page": 3}, 100)
        row = state.put(HASH, "position", {"page": 5}, 200)
        self.assertEqual(row, {"value": {"page": 5}, "ts": 200})
        self.assertEqual(state.get_all(HASH)["position"], {"value": {"page": 5}, "ts": 200})

    def test_older_write_never_overwrites_newer(self):
        state.put(HASH, "zoom", "1.5", 200)
        row = state.put(HASH, "zoom", "auto", 100)
        self.assertEqual(row, {"value": "1.5", "ts": 200})
        self.assertEqual(state.get_all(HASH)["zoom"]["value"], "1.5")

    def test_equal_ts_keeps_stored_value(self):
        state.put(HASH, "zoom", "1.5", 200)
        self.assertEqual(state.put(HASH, "zoom", "2", 200)["value"], "1.5")

    def test_keys_are_independent_and_forget_clears_hash(self):
        state.put(HASH, "position", {"page": 2}, 1)
        state.put(HASH, "zoom", "auto", 1)
        state.put("abcdef", "zoom", "2", 1)
        self.assertEqual(set(state.get_all(HASH)), {"position", "zoom"})
        self.assertEqual(state.forget(HASH), 2)
        self.assertEqual(state.get_all(HASH), {})
        self.assertEqual(state.get_all("abcdef")["zoom"]["value"], "2")


class MarksMergeTest(StateTestCase):
    def test_marks_merge_per_letter(self):
        state.put(HASH, "marks", {"a": {"page": 1, "label": "", "ts": 100}}, 100)
        row = state.put(HASH, "marks", {"b": {"page": 9, "label": "x", "ts": 150}}, 150)
        self.assertEqual(set(row["value"]), {"a", "b"})
        self.assertEqual(row["ts"], 150)

    def test_stale_letter_does_not_replace_newer_letter(self):
        state.put(HASH, "marks", {"a": {"page": 7, "ts": 300}}, 300)
        row = state.put(HASH, "marks", {"a": {"page": 2, "ts": 100}, "c": {"page": 4, "ts": 100}}, 100)
        self.assertEqual(row["value"]["a"]["page"], 7)
        self.assertEqual(row["value"]["c"]["page"], 4)
        self.assertEqual(row["ts"], 300)

    def test_tombstone_blocks_stale_resurrection(self):
        state.put(HASH, "marks", {"a": {"page": 7, "ts": 100}}, 100)
        state.put(HASH, "marks", {"a": {"deleted": True, "ts": 200}}, 200)
        row = state.put(HASH, "marks", {"a": {"page": 7, "ts": 100}}, 250)
        self.assertEqual(row["value"]["a"], {"deleted": True, "ts": 200})
        # A mark set after the deletion does win.
        row = state.put(HASH, "marks", {"a": {"page": 3, "ts": 300}}, 300)
        self.assertEqual(row["value"]["a"]["page"], 3)

    def test_mark_without_ts_takes_request_ts(self):
        row = state.put(HASH, "marks", {"a": {"page": 1}}, 42)
        self.assertEqual(row["value"]["a"]["ts"], 42)


class ValidationTest(StateTestCase):
    def test_rejects_bad_input(self):
        cases = [
            ("XYZ", "zoom", "1", 1),
            ("abc", "zoom", "1", 1),
            ("../../etc", "zoom", "1", 1),
            (HASH, "prefs", "1", 1),
            (HASH, "zoom", "1", -1),
            (HASH, "zoom", "1", "soon"),
            (HASH, "zoom", "1", True),
            (HASH, "zoom", "x" * (65 * 1024), 1),
            (HASH, "zoom", float("nan"), 1),
            (HASH, "marks", ["a"], 1),
            (HASH, "marks", {"ab": {"page": 1}}, 1),
            (HASH, "marks", {"a": 3}, 1),
        ]
        for case in cases:
            with self.subTest(case=case[:2]), self.assertRaises(state.InvalidState):
                state.put(*case)
        with self.assertRaises(state.InvalidState):
            state.get_all("nothex")
        self.assertEqual(state.get_all(HASH), {})


class _FakeRequest:
    def __init__(self, body: bytes):
        self._body = body

    async def body(self):
        return self._body


class RouteFunctionTest(StateTestCase):
    def put(self, key, body):
        raw = body if isinstance(body, bytes) else json.dumps(body).encode()
        return asyncio.run(state_routes.put_state(HASH, key, _FakeRequest(raw)))

    def test_put_then_get(self):
        self.assertEqual(self.put("position", {"value": {"page": 5}, "ts": 10}),
                         {"value": {"page": 5}, "ts": 10})
        self.assertEqual(state_routes.get_state(HASH), {"position": {"value": {"page": 5}, "ts": 10}})

    def test_invalid_input_is_400(self):
        for key, body in [("zoom", b"not json"), ("zoom", {"value": 1}), ("nope", {"value": 1, "ts": 1})]:
            with self.subTest(body=body), self.assertRaises(HTTPException) as ctx:
                self.put(key, body)
            self.assertEqual(ctx.exception.status_code, 400)
        with self.assertRaises(HTTPException) as ctx:
            state_routes.get_state("nothex")
        self.assertEqual(ctx.exception.status_code, 400)
        with self.assertRaises(HTTPException) as ctx:
            state_routes.delete_state("nothex")
        self.assertEqual(ctx.exception.status_code, 400)

    def test_delete_clears_hash(self):
        self.put("zoom", {"value": "2", "ts": 1})
        self.assertEqual(state_routes.delete_state(HASH), {"deleted": 1})
        self.assertEqual(state_routes.get_state(HASH), {})


@unittest.skipIf(TestClient is None, "fastapi.testclient needs httpx")
class RouteHttpTest(StateTestCase):
    def test_round_trip(self):
        app = FastAPI()
        app.include_router(state_routes.router)
        client = TestClient(app)
        self.assertEqual(client.get(f"/entry/{HASH}/state").json(), {})
        r = client.put(f"/entry/{HASH}/state/zoom", json={"value": "2", "ts": 5})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(client.get(f"/entry/{HASH}/state").json()["zoom"]["value"], "2")
        self.assertEqual(client.put(f"/entry/{HASH}/state/zoom", json={"ts": 5}).status_code, 400)
        self.assertEqual(client.get("/entry/NOTHEX/state").status_code, 400)


if __name__ == "__main__":
    unittest.main()

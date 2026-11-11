"""Per-document viewer state — SQLite store keyed by cache-entry hash.

The overlay keeps a document's reading position, marks and zoom here so
they follow the document across browser origins (localhost vs 127.0.0.1)
and browser profiles. localStorage stays the synchronous first-paint
copy; this store is the shared one (docs/cache.md, "Per-document state").

One row per (hash, key) holding a JSON value and an updated-at timestamp in
ms. Writes are last-writer-wins by that timestamp: an older ts never
overwrites a newer one. `marks` merges per letter by each mark's own ts, and
a cleared mark is kept as a tombstone `{"deleted": true, "ts": ...}` so a
stale client cannot resurrect it.

The path defaults to `<cache>/state.db` and can be overridden with
PDFV_STATE_DB (tests and scratch daemons use a temp file).
"""
from __future__ import annotations

import contextlib
import json
import os
import pathlib
import re
import sqlite3
from typing import Any, Iterator

DB_PATH = pathlib.Path(
    os.environ.get("PDFV_STATE_DB")
    or pathlib.Path.home() / ".cache" / "pdf_viewer" / "state.db"
)

KEYS = ("position", "marks", "zoom", "pins", "outline")
MAX_VALUE_BYTES = 64 * 1024
_HASH_RE = re.compile(r"^[a-f0-9]{6,32}$")
_LETTER_RE = re.compile(r"^[a-z]$")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS state (
    hash  TEXT    NOT NULL,
    key   TEXT    NOT NULL,
    value TEXT    NOT NULL,
    ts    INTEGER NOT NULL,
    PRIMARY KEY (hash, key)
);
"""


class InvalidState(ValueError):
    """Rejected input; the HTTP adapter maps it to 400."""


@contextlib.contextmanager
def _connect() -> Iterator[sqlite3.Connection]:
    """An autocommit connection with the schema ensured, closed on exit."""
    path = pathlib.Path(DB_PATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, isolation_level=None)
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.executescript(_SCHEMA)
        yield conn
    finally:
        conn.close()


def _check_hash(hash_: str) -> None:
    if not isinstance(hash_, str) or not _HASH_RE.match(hash_):
        raise InvalidState("invalid hash")


def _check_ts(ts: Any) -> int:
    if isinstance(ts, bool) or not isinstance(ts, (int, float)) or ts != ts or ts < 0:
        raise InvalidState("ts must be a non-negative number of ms")
    return int(ts)


def _check_marks(value: Any) -> dict:
    if not isinstance(value, dict):
        raise InvalidState("marks must be an object of letter -> mark")
    for letter, mark in value.items():
        if not _LETTER_RE.match(letter) or not isinstance(mark, dict):
            raise InvalidState("marks must be an object of letter -> mark")
        if "ts" in mark:
            _check_ts(mark["ts"])
    return value


def _mark_ts(mark: dict) -> int:
    ts = mark.get("ts")
    return int(ts) if isinstance(ts, (int, float)) and not isinstance(ts, bool) else 0


def merge_marks(stored: dict, incoming: dict, default_ts: int) -> dict:
    """Per-letter last-writer-wins; a tie keeps the stored mark."""
    out = dict(stored)
    for letter, mark in incoming.items():
        mark = dict(mark)
        if "ts" not in mark:
            mark["ts"] = default_ts
        current = out.get(letter)
        if current is None or _mark_ts(mark) > _mark_ts(current):
            out[letter] = mark
    return out


def get_all(hash_: str) -> dict[str, dict]:
    """{key: {"value": ..., "ts": ms}} for every stored key of a hash."""
    _check_hash(hash_)
    with _connect() as conn:
        rows = conn.execute(
            "SELECT key, value, ts FROM state WHERE hash = ?", (hash_,)
        ).fetchall()
    return {key: {"value": json.loads(value), "ts": ts} for key, value, ts in rows}


def positions() -> dict[str, tuple[int, int]]:
    """hash -> (saved page, ts in ms) for every document with a position.

    One query for the whole store, so the library can show where each
    document was left without a request per row. Never raises.
    """
    out: dict[str, tuple[int, int]] = {}
    try:
        with _connect() as conn:
            rows = conn.execute("SELECT hash, value, ts FROM state WHERE key = 'position'").fetchall()
    except sqlite3.Error:
        return out
    for hash_, encoded, ts in rows:
        try:
            page = json.loads(encoded).get("page")
        except (ValueError, AttributeError):
            continue
        if isinstance(page, (int, float)) and not isinstance(page, bool) and page >= 1:
            out[hash_] = (int(page), int(ts))
    return out


def put(hash_: str, key: str, value: Any, ts: Any) -> dict:
    """Store a value unless a newer one exists; return the stored row."""
    _check_hash(hash_)
    if key not in KEYS:
        raise InvalidState(f"unknown key {key!r}")
    ts = _check_ts(ts)
    try:
        encoded = json.dumps(value, separators=(",", ":"), allow_nan=False)
    except (TypeError, ValueError) as error:
        raise InvalidState("value must be JSON") from error
    if len(encoded.encode()) > MAX_VALUE_BYTES:
        raise InvalidState("value too large")
    if key == "marks":
        _check_marks(value)

    with _connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        try:
            row = conn.execute(
                "SELECT value, ts FROM state WHERE hash = ? AND key = ?", (hash_, key)
            ).fetchone()
            if key == "marks":
                stored = json.loads(row[0]) if row else {}
                merged = merge_marks(stored, value, ts)
                new_ts = max([ts, row[1] if row else 0] + [_mark_ts(m) for m in merged.values()])
                result = {"value": merged, "ts": new_ts}
                if row is None or merged != stored or new_ts != row[1]:
                    encoded = json.dumps(merged, separators=(",", ":"))
                    if len(encoded.encode()) > MAX_VALUE_BYTES:
                        raise InvalidState("value too large")
                    _write(conn, hash_, key, encoded, new_ts)
            elif row is not None and row[1] >= ts:
                result = {"value": json.loads(row[0]), "ts": row[1]}
            else:
                _write(conn, hash_, key, encoded, ts)
                result = {"value": value, "ts": ts}
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise
    return result


def _write(conn: sqlite3.Connection, hash_: str, key: str, encoded: str, ts: int) -> None:
    conn.execute(
        "INSERT INTO state(hash, key, value, ts) VALUES(?, ?, ?, ?) "
        "ON CONFLICT(hash, key) DO UPDATE SET value = excluded.value, ts = excluded.ts",
        (hash_, key, encoded, ts),
    )


def forget(hash_: str) -> int:
    """Delete every state row for a hash. Returns rows deleted; never raises."""
    try:
        with _connect() as conn:
            cur = conn.execute("DELETE FROM state WHERE hash = ?", (hash_,))
            return cur.rowcount or 0
    except sqlite3.Error:
        return 0


def inherit_local(previous: str, current: str, pages: int) -> None:
    """Copy only along a registered path edge. Keep page numbers, clamp removals.

    Never replace state already belonging to the target content hash.
    """
    with _connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        try:
            if not conn.execute("SELECT 1 FROM state WHERE hash=?", (current,)).fetchone():
                for key, encoded, ts in conn.execute("SELECT key,value,ts FROM state WHERE hash=?", (previous,)).fetchall():
                    value = json.loads(encoded)
                    def clamp(mark):
                        if isinstance(mark, dict) and isinstance(mark.get("page"), (int, float)):
                            mark["page"] = max(1, min(pages, mark["page"]))
                    if key == "position":
                        clamp(value)
                    elif key in ("marks", "pins"):
                        for mark in (value.values() if isinstance(value, dict) else value):
                            clamp(mark)
                    _write(conn, current, key, json.dumps(value), ts)
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise

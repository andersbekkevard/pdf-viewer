"""Visit tracking — SQLite log of every cache hit in /view.

One row per visit. Aggregates computed at query time; at personal-use
volume (single-digit visits/day) the events table stays well under 1MB
for years, so maintaining a rollup is unnecessary overhead.

LRU eviction is deliberately NOT built on top of this (docs/cache.md:
deferred until cache bloat becomes real). The rows feed /stats and the
frecency order of /library.
"""
from __future__ import annotations

import contextlib
import pathlib
import sqlite3
import time
from typing import Iterator, Literal

DB_PATH = pathlib.Path.home() / ".cache" / "pdf_viewer" / "visits.db"
SESSION_WINDOW_SEC = 15 * 60

VisitKind = Literal["url", "path", "reader", "boost"]

_SCHEMA = """
CREATE TABLE IF NOT EXISTS visits (
    hash TEXT    NOT NULL,
    ts   INTEGER NOT NULL,
    kind TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_visits_hash ON visits(hash);
CREATE INDEX IF NOT EXISTS idx_visits_ts   ON visits(ts);
"""


@contextlib.contextmanager
def _connect() -> Iterator[sqlite3.Connection]:
    """An autocommit connection that is closed on exit.

    sqlite3.Connection's own context manager only ends the transaction; it
    leaves the connection (and its file handles) open until garbage
    collection.
    """
    conn = sqlite3.connect(DB_PATH, isolation_level=None)
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        yield conn
    finally:
        conn.close()


def init() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with _connect() as conn:
        conn.executescript(_SCHEMA)


def record(hash_: str, kind: Literal["url", "path", "reader"]) -> None:
    """Insert one visit row. Called from a BackgroundTask — must never raise."""
    try:
        with _connect() as conn:
            conn.execute(
                "INSERT INTO visits(hash, ts, kind) VALUES(?, ?, ?)",
                (hash_, int(time.time()), kind),
            )
    except sqlite3.Error:
        pass


def boost(hash_: str, n: int = 3) -> int:
    """Bump frecency by N effective opens — once per entry, ever.

    Inserts `n` rows spaced one session-window apart so each lands in a
    distinct 15-min bucket — the rank query (`COUNT(DISTINCT ts /
    SESSION_WINDOW_SEC)`) then sees +n. The newest row is at `now`, so
    the recency multiplier becomes 4.0 immediately and decays normally.
    Tagged kind="boost" to distinguish from real opens in stats.

    Idempotent per hash: if any kind="boost" row already exists for this
    hash, returns 0. The rationale is that the boost reflects a one-time
    "I curated this entry" signal, not a per-edit action — five renames
    shouldn't stack to 5× the bump. `forget(hash)` clears boost rows
    along with the rest, so a re-converted entry can boost again.

    Returns rows actually inserted. Never raises.
    """
    if n <= 0:
        return 0
    try:
        with _connect() as conn:
            already = conn.execute(
                "SELECT 1 FROM visits WHERE hash = ? AND kind = 'boost' LIMIT 1",
                (hash_,),
            ).fetchone()
            if already:
                return 0
            now = int(time.time())
            rows = [
                (hash_, now - i * SESSION_WINDOW_SEC, "boost")
                for i in range(n)
            ]
            conn.executemany(
                "INSERT INTO visits(hash, ts, kind) VALUES(?, ?, ?)", rows,
            )
        return n
    except sqlite3.Error:
        return 0


def forget(hash_: str) -> int:
    """Delete every visit row for a hash. Returns rows deleted."""
    try:
        with _connect() as conn:
            cur = conn.execute("DELETE FROM visits WHERE hash = ?", (hash_,))
            return cur.rowcount or 0
    except sqlite3.Error:
        return 0


def summary(top_n: int = 20) -> dict:
    with _connect() as conn:
        total = conn.execute("SELECT COUNT(*) FROM visits").fetchone()[0]
        unique = conn.execute("SELECT COUNT(DISTINCT hash) FROM visits").fetchone()[0]
        first_last = conn.execute(
            "SELECT MIN(ts), MAX(ts) FROM visits"
        ).fetchone()
        top = conn.execute(
            """
            SELECT hash, COUNT(*) AS n, MIN(ts) AS first_seen, MAX(ts) AS last_seen
            FROM visits
            GROUP BY hash
            ORDER BY n DESC, last_seen DESC
            LIMIT ?
            """,
            (top_n,),
        ).fetchall()
    return {
        "total_visits": total,
        "unique_docs": unique,
        "first_visit": first_last[0],
        "last_visit": first_last[1],
        "top": [
            {"hash": h, "count": n, "first_seen": f, "last_seen": l}
            for h, n, f, l in top
        ],
    }


def _zoxide_multiplier(age_sec: int) -> float:
    """zoxide-style query-time recency multiplier."""
    if age_sec < 3600:
        return 4.0
    if age_sec < 86400:
        return 2.0
    if age_sec < 604800:
        return 0.5
    return 0.25


def all_frecency(now: int | None = None) -> dict[str, dict]:
    """hash → sessionized zoxide-style frecency metrics.

    Rank is one effective open per 15-minute wall-clock bucket. Raw visits
    stay available for diagnostics/display, but reloads and browser restores
    inside the same bucket do not inflate the score.
    """
    if now is None:
        now = int(time.time())
    try:
        with _connect() as conn:
            rows = conn.execute(
                """
                SELECT
                    hash,
                    COUNT(*) AS raw_count,
                    COUNT(DISTINCT CAST(ts / ? AS INTEGER)) AS rank,
                    MAX(ts) AS last_seen
                FROM visits
                GROUP BY hash
                """,
                (SESSION_WINDOW_SEC,),
            ).fetchall()
    except sqlite3.Error:
        return {}

    out = {}
    for hash_, raw_count, rank, last_seen in rows:
        age_sec = max(0, now - last_seen)
        multiplier = _zoxide_multiplier(age_sec)
        out[hash_] = {
            "raw_count": raw_count,
            "rank": rank,
            "last_seen": last_seen,
            "age_multiplier": multiplier,
            "frecency_score": rank * multiplier,
        }
    return out


def recent(limit: int = 100) -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT hash, ts, kind FROM visits ORDER BY ts DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return [{"hash": h, "ts": t, "kind": k} for h, t, k in rows]

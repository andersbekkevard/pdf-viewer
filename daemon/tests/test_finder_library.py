"""The quick-open library: frecency order, saved positions, /library?view=finder."""
from __future__ import annotations

import json
import pathlib
import sys
import tempfile
import time
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import main  # noqa: E402
import state  # noqa: E402
import visits  # noqa: E402
from catalog import CacheCatalog  # noqa: E402

DAY = 86400
NOW = 1_800_000_000
A, B, C = "aaaa000000000001", "bbbb000000000002", "cccc000000000003"


class VisitsTestCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.original = visits.DB_PATH
        visits.DB_PATH = pathlib.Path(self.temp.name) / "visits.db"
        visits.init()

    def tearDown(self):
        visits.DB_PATH = self.original
        self.temp.cleanup()

    def visit(self, hash_, *ages):
        with visits._connect() as conn:
            conn.executemany("INSERT INTO visits(hash, ts, kind) VALUES(?, ?, 'reader')",
                             [(hash_, NOW - age, ) for age in ages])


class FrecencyOrderTest(VisitsTestCase):
    def order(self):
        scores = visits.all_frecency(now=NOW)
        return sorted(scores, key=lambda h: -scores[h]["frecency_score"])

    def test_reloads_inside_one_session_count_once(self):
        self.visit(A, 10, 20, 30, 40)
        row = visits.all_frecency(now=NOW)[A]
        self.assertEqual((row["raw_count"], row["rank"]), (4, 1))
        self.assertAlmostEqual(row["frecency_score"], 1.0, places=3)

    def test_a_document_read_every_few_days_outranks_a_one_off_from_today(self):
        # A: read twice a week for a month. B: opened once an hour ago.
        self.visit(A, *[int(d * DAY) for d in (1, 4, 8, 11, 15, 18, 22, 25)])
        self.visit(B, 3600)
        self.assertEqual(self.order(), [A, B])

    def test_old_habits_fade_behind_recent_use(self):
        # A: ten sessions two months ago. B: three sessions this week.
        self.visit(A, *[int((60 + d) * DAY) for d in range(10)])
        self.visit(B, DAY, 2 * DAY, 3 * DAY)
        self.assertEqual(self.order(), [B, A])

    def test_more_recent_wins_between_equal_use(self):
        self.visit(A, 5 * DAY)
        self.visit(B, 1 * DAY)
        self.assertEqual(self.order(), [B, A])


class PositionsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.original = state.DB_PATH
        state.DB_PATH = pathlib.Path(self.temp.name) / "state.db"

    def tearDown(self):
        state.DB_PATH = self.original
        self.temp.cleanup()

    def test_positions_reads_every_saved_page_at_once(self):
        state.put(A, "position", {"page": 37}, 1000)
        state.put(B, "position", {"page": 0}, 1000)       # not a page
        state.put(C, "zoom", "1.4", 1000)                   # not a position
        self.assertEqual(state.positions(), {A: (37, 1000)})

    def test_positions_of_an_empty_store(self):
        self.assertEqual(state.positions(), {})


class DisplayTitleTest(unittest.TestCase):
    def test_metadata_title_names_a_document_kept_under_its_file_name(self):
        self.assertEqual(CacheCatalog.display_title("ch3_final", "/x/ch3_final.pdf", "Attention Is All You Need"),
                         "Attention Is All You Need")

    def test_a_renamed_document_keeps_its_chosen_name(self):
        self.assertEqual(CacheCatalog.display_title("Transformers", "/x/ch3_final.pdf", "Attention"), "Transformers")

    def test_tool_and_file_titles_are_ignored(self):
        for junk in ("Microsoft Word - draft.docx", "untitled", "slides.pdf", "ab", ""):
            self.assertEqual(CacheCatalog.display_title("notes", "/x/notes.pdf", junk), "notes")

    def test_url_sources_compare_against_the_url_file_stem(self):
        self.assertEqual(CacheCatalog.display_title("2301.12345", "https://h.org/pdf/2301.12345.pdf", "A Paper"),
                         "A Paper")


class FakeActivity:
    def __init__(self, scores):
        self.scores = scores

    def all_frecency(self):
        return self.scores


class FinderEntriesTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        tmp = pathlib.Path(self.temp.name)
        self.root = tmp / "cache"
        self.root.mkdir()
        lines = []
        for hash_, name, ref in ((A, "alpha", str(tmp / "alpha.pdf")),
                                 (B, "beta", "https://Example.org/papers/beta%20two.pdf"),
                                 (C, "gamma", str(tmp / "gamma.pdf"))):
            entry = self.root / hash_
            entry.mkdir()
            (entry / f"{name}.html").write_text("x", encoding="utf-8")
            lines.append(f"1\t{ref}\t{hash_}\t{entry / (name + '.html')}\n")
        (self.root / A / "meta.json").write_text(json.dumps({"title": "Alpha Book", "author": "Ada", "pages": 214}),
                                                 encoding="utf-8")
        now = int(time.time())
        self.scores = {
            A: {"raw_count": 9, "rank": 6, "last_seen": now - 5 * DAY, "age_multiplier": 0.5, "frecency_score": 4.0},
            B: {"raw_count": 1, "rank": 1, "last_seen": now - 600, "age_multiplier": 4.0, "frecency_score": 1.0},
            C: {"raw_count": 1, "rank": 1, "last_seen": now - 60, "age_multiplier": 4.0, "frecency_score": 1.0},
        }
        self.catalog = CacheCatalog(self.root, FakeActivity(self.scores))
        self.catalog.mappings_path.write_text("".join(lines), encoding="utf-8")
        self.now = now

    def tearDown(self):
        self.temp.cleanup()

    def test_rows_carry_what_a_row_shows_and_nothing_heavy(self):
        rows = {row["hash"]: row for row in self.catalog.finder_entries({A: (37, (self.now - DAY) * 1000)})}
        alpha = rows[A]
        self.assertEqual((alpha["title"], alpha["author"], alpha["pages"], alpha["page"], alpha["file"]),
                         ("Alpha Book", "Ada", 214, 37, "alpha.pdf"))
        self.assertEqual(alpha["last_read"], self.now - DAY)   # the saved page is newer than the last open
        self.assertEqual((rows[B]["host"], rows[B]["file"]), ("example.org", "beta two.pdf"))
        for heavy in ("search_text", "thumb_href", "canonical_href", "light_href", "reader_href"):
            self.assertNotIn(heavy, alpha)

    def test_frecency_order_and_the_previous_document(self):
        rows = self.catalog.finder_entries({}, current=C)
        self.assertEqual([row["hash"] for row in rows], [A, C, B])  # score, then last open
        self.assertEqual([row["hash"] for row in rows if row["previous"]], [B])

    def test_reading_in_another_tab_makes_that_document_previous(self):
        # A was opened days ago but its page changed a minute ago.
        rows = self.catalog.finder_entries({A: (12, (self.now - 30) * 1000)}, current=C)
        self.assertEqual([row["hash"] for row in rows if row["previous"]], [A])

    def test_route_serves_the_finder_view(self):
        original = main.catalog
        main.catalog = self.catalog
        try:
            rows = main.library(view="finder", current=A)
            self.assertIn("previous", rows[0])
            self.assertIn("search_text", main.library()[0])
        finally:
            main.catalog = original


if __name__ == "__main__":
    unittest.main()

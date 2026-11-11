from __future__ import annotations

import json
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from catalog import (  # noqa: E402
    CacheCatalog,
    InvalidCatalogInput,
    strip_passthrough,
    url_hash,
    with_passthrough,
)


HASH = "998117f977edf08f"
OTHER_HASH = "fedcba9876543210"


class FakeActivity:
    def __init__(self):
        self.forgotten = []
        self.boosted = []

    def all_frecency(self):
        return {HASH: {"raw_count": 4, "rank": 2, "last_seen": 100,
                       "age_multiplier": 2.0, "frecency_score": 4.0}}

    def boost(self, hash_, n=3):
        self.boosted.append((hash_, n))
        return n

    def forget(self, hash_):
        self.forgotten.append(hash_)
        return 7


class CatalogTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temp.name) / "cache"
        self.root.mkdir()
        self.activity = FakeActivity()
        self.catalog = CacheCatalog(self.root, self.activity)

    def tearDown(self):
        self.temp.cleanup()

    def add_entry(self, hash_=HASH, name="Book", source="https://EXAMPLE.com/docs/book.pdf?revision=old"):
        """A row as the retired conversion scripts left it, with the stored
        source PDF the reader opens."""
        entry = self.root / hash_
        (entry / "_source").mkdir(parents=True)
        (entry / "_source" / "source.pdf").write_bytes(b"%PDF-1.4")
        canonical = entry / f"{name}.html"
        with self.catalog.mappings_path.open("a", encoding="utf-8") as mappings:
            mappings.write(f"2026-01-01\t{source}\t{hash_}\t{canonical}\n")
        return entry, canonical

    def test_remote_resolution_strips_query_from_identity_and_passthrough(self):
        self.add_entry()
        signed = "https://EXAMPLE.com/docs/book.pdf?revision=new&_pdfvw=passthrough"
        resolved = self.catalog.resolve_source(signed)
        self.assertEqual(resolved.hash, HASH)
        self.assertEqual(resolved.source_ref, "https://EXAMPLE.com/docs/book.pdf?revision=new")
        self.assertEqual(url_hash(signed), HASH)
        self.assertEqual(with_passthrough(strip_passthrough(signed)).count("_pdfvw=passthrough"), 1)

    def test_local_mapping_wins_without_reading_source(self):
        missing = pathlib.Path(self.temp.name) / "cloud" / "book.pdf"
        self.add_entry(source=str(missing))
        resolved = self.catalog.resolve_source(missing)
        self.assertEqual(resolved.hash, HASH)
        self.assertEqual(self.catalog.viewer_href(HASH), f"/r/{HASH}/")

    def test_browser_url_resolution_content_hashes_unmapped_local_file(self):
        pdf = pathlib.Path(self.temp.name) / "new.pdf"
        pdf.write_bytes(b"pdf bytes")
        expected = self.catalog.resolve_source(pdf).hash
        self.assertEqual(self.catalog.hash_for_browser_url(pdf.as_uri()), expected)
        self.assertEqual(
            self.catalog.hash_for_browser_url(f"http://localhost:7435/view?path={pdf}"),
            expected,
        )

    def test_passthrough_marker_round_trips_without_reencoding_the_query(self):
        signed = "https://cdn.example.com/a%20b.pdf?X-Sig=a%2Fb%3D&name=x+y&e=1"
        marked = with_passthrough(signed)
        self.assertEqual(marked, signed + "&_pdfvw=passthrough")
        self.assertEqual(with_passthrough(marked), marked)
        self.assertEqual(strip_passthrough(marked), signed)
        self.assertEqual(strip_passthrough(signed), signed)
        self.assertEqual(strip_passthrough("https://h/x.pdf?_pdfvw=passthrough"), "https://h/x.pdf")

    def test_browser_url_resolution_covers_every_daemon_view_route(self):
        pdf = pathlib.Path(self.temp.name) / "new.pdf"
        pdf.write_bytes(b"pdf bytes")
        expected = self.catalog.resolve_source(pdf).hash
        remote = "https://example.com/a/b.pdf?sig=1&x=2"
        for route in ("/view", "/read"):
            with self.subTest(route=route):
                self.assertEqual(
                    self.catalog.hash_for_browser_url(f"http://localhost:7435{route}?path={pdf}"),
                    expected,
                )
        for route in ("/view-raw", "/read-raw"):
            with self.subTest(route=route):
                self.assertEqual(
                    self.catalog.hash_for_browser_url(f"http://127.0.0.1:7435{route}?{remote}"),
                    url_hash(remote),
                )

    def test_malformed_and_duplicate_mappings_use_last_valid_row(self):
        _entry, canonical = self.add_entry(name="Old")
        renamed_path = canonical.with_name("Latest.html")
        self.catalog.mappings_path.write_text(
            "malformed\n"
            f"1\t/a.pdf\t{HASH}\t{canonical}\n"
            f"2\t/b.pdf\t{HASH}\t{renamed_path}\n",
            encoding="utf-8",
        )
        mapping = self.catalog.mappings()[HASH]
        self.assertEqual(mapping.source_ref, "/b.pdf")
        self.assertEqual(mapping.name, "Latest")

    def test_disabled_state_is_sorted_compatible_and_filters_invalid_hashes(self):
        self.add_entry()
        self.catalog.disabled_path.write_text(json.dumps(["not-a-hash", OTHER_HASH]), encoding="utf-8")
        self.assertFalse(self.catalog.is_disabled(HASH))
        self.assertTrue(self.catalog.is_disabled(OTHER_HASH))
        self.assertTrue(self.catalog.set_disabled(HASH, True))
        self.assertEqual(json.loads(self.catalog.disabled_path.read_text())["disabled"], [HASH, OTHER_HASH])
        self.assertTrue(self.catalog.extension_entries()[0]["disabled"])

    def test_library_lists_searches_and_drops_stale_mappings(self):
        self.add_entry(name="Linear Algebra", source="/courses/math/book.pdf")
        self.catalog.mappings_path.write_text(
            self.catalog.mappings_path.read_text()
            + f"1\t/missing.pdf\t{OTHER_HASH}\t{self.root / OTHER_HASH / 'Gone.html'}\n",
            encoding="utf-8",
        )
        entries = self.catalog.list_entries()
        self.assertEqual([entry["hash"] for entry in entries], [HASH])
        self.assertEqual(self.catalog.search_entries("MATH")[0]["name"], "Linear Algebra")
        self.assertEqual(entries[0]["frecency_score"], 4.0)
        self.assertEqual(entries[0]["href"], f"/r/{HASH}/")

    def test_rename_of_a_converted_row_is_kept_in_the_manifest(self):
        entry, _canonical = self.add_entry()
        result = self.catalog.rename(HASH, "../New/Name.html")
        self.assertEqual((result["old_name"], result["new_name"], result["renamed"]), ("Book", "-New-Name", True))
        self.assertEqual(result["href"], f"/r/{HASH}/")
        self.assertEqual(self.catalog.mappings()[HASH].html_path, entry / "-New-Name.html")
        self.assertEqual(self.catalog.entry_name(HASH), "-New-Name")
        self.assertEqual(self.catalog.mappings()[HASH].name, "-New-Name")
        self.assertEqual(self.catalog.list_entries()[0]["name"], "-New-Name")
        self.assertEqual(self.activity.boosted, [(HASH, 3)])
        self.assertFalse(self.catalog.rename(HASH, "-New-Name")["renamed"])

    def test_entry_without_a_stored_pdf_reopens_from_its_url_or_is_dropped(self):
        for hash_, source in ((HASH, "https://example.com/a b.pdf"), (OTHER_HASH, "/gone/book.pdf")):
            (self.root / hash_).mkdir()
            with self.catalog.mappings_path.open("a", encoding="utf-8") as mappings:
                mappings.write(f"1\t{source}\t{hash_}\t{self.root / hash_ / 'Book.html'}\n")
        self.assertEqual(self.catalog.viewer_href(HASH), "/read?url=https%3A%2F%2Fexample.com%2Fa%20b.pdf")
        self.assertIsNone(self.catalog.viewer_href(OTHER_HASH))
        self.assertEqual([entry["hash"] for entry in self.catalog.list_entries()], [HASH])

    def test_delete_is_atomic_across_catalog_state_and_activity(self):
        entry, _canonical = self.add_entry(source="https://example.com/book.pdf?_pdfvw=passthrough")
        self.catalog.set_disabled(HASH, True)
        result = self.catalog.delete(HASH)
        self.assertFalse(entry.exists())
        self.assertNotIn(HASH, self.catalog.mappings())
        self.assertFalse(self.catalog.is_disabled(HASH))
        self.assertEqual(result["source_ref"], "https://example.com/book.pdf")
        self.assertEqual(result["visits_deleted"], 7)

    def test_mutations_reject_traversal_and_symlink_escape(self):
        with self.assertRaises(InvalidCatalogInput):
            self.catalog.delete("../outside")
        outside = pathlib.Path(self.temp.name) / "outside"
        outside.mkdir()
        (self.root / HASH).symlink_to(outside, target_is_directory=True)
        with self.assertRaises(InvalidCatalogInput):
            self.catalog.delete(HASH)
        self.assertTrue(outside.is_dir())


if __name__ == "__main__":
    unittest.main()

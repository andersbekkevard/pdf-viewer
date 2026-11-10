from __future__ import annotations

import json
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from catalog import (  # noqa: E402
    CacheCatalog,
    EntryNotFound,
    InvalidCatalogInput,
    url_hash,
)


LOCAL_HASH = "0123456789abcdef"
REMOTE_HASH = "a1b2c3d4e5f6a7b8"
THIRD_HASH = "feedface00c0ffee"


class FakeActivity:
    def __init__(self):
        self.forgotten = []
        self.boosted = []

    def all_frecency(self):
        return {}

    def boost(self, hash_, n=3):
        self.boosted.append((hash_, n))
        return n

    def forget(self, hash_):
        self.forgotten.append(hash_)
        return 0


class CatalogManifestTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        # Resolve once so paths handed to the catalog match what it resolves
        # (on macOS the temp dir sits behind the /var -> /private/var symlink).
        self.base = pathlib.Path(self.temp.name).resolve()
        self.root = self.base / "cache"
        self.root.mkdir()
        self.activity = FakeActivity()
        self.catalog = CacheCatalog(self.root, self.activity)

    def tearDown(self):
        self.temp.cleanup()

    def write_pdf(self, name="Local Doc.pdf"):
        path = self.base / "local" / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"%PDF-1.4 local")
        return path

    def write_raw_manifest(self, hash_, content):
        entry = self.root / hash_
        entry.mkdir(exist_ok=True)
        data = content if isinstance(content, bytes) else content.encode("utf-8")
        (entry / "entry.json").write_bytes(data)

    def read_manifest(self, hash_):
        return json.loads((self.root / hash_ / "entry.json").read_text(encoding="utf-8"))

    def add_converted(self, hash_, name, source):
        entry = self.root / hash_
        entry.mkdir(exist_ok=True)
        canonical = entry / f"{name}.html"
        canonical.write_text(f"<title>{name}</title>", encoding="utf-8")
        with self.catalog.mappings_path.open("a", encoding="utf-8") as mappings:
            mappings.write(f"2026-01-01\t{source}\t{hash_}\t{canonical}\n")
        return entry, canonical

    # ------------------------------------------------------------ register

    def test_register_writes_entry_json_with_name_and_source(self):
        pdf = self.write_pdf()
        manifest = self.catalog.register(LOCAL_HASH, str(pdf), "Local Doc")
        expected = {"name": "Local Doc", "source_ref": str(pdf)}
        self.assertEqual(manifest, expected)
        self.assertEqual(self.read_manifest(LOCAL_HASH), expected)

    def test_register_strips_passthrough_marker_from_url_source(self):
        url = "https://example.com/docs/a.pdf?sig=abc&_pdfvw=passthrough"
        self.catalog.register(REMOTE_HASH, url, "Remote")
        self.assertEqual(self.read_manifest(REMOTE_HASH)["source_ref"],
                         "https://example.com/docs/a.pdf?sig=abc")

    def test_register_again_updates_source_and_keeps_existing_name(self):
        self.catalog.register(LOCAL_HASH, "/old/place/a.pdf", "Original Name")
        self.catalog.register(LOCAL_HASH, "/new/place/a.pdf", "Different Name")
        self.assertEqual(self.read_manifest(LOCAL_HASH),
                         {"name": "Original Name", "source_ref": "/new/place/a.pdf"})

    def test_register_rejects_invalid_hashes_without_writing(self):
        for bad in ("../escape", "ABCDEF123456", "xyz123456789", "abc"):
            with self.subTest(hash=bad):
                with self.assertRaises(InvalidCatalogInput):
                    self.catalog.register(bad, "/a.pdf", "A")
        self.assertEqual(list(self.root.iterdir()), [])

    def test_register_sanitizes_name(self):
        self.catalog.register(LOCAL_HASH, "/a.pdf", "Quarterly/Report")
        self.assertEqual(self.read_manifest(LOCAL_HASH)["name"], "Quarterly-Report")
        self.catalog.register(REMOTE_HASH, "https://example.com/a.pdf", ".hidden notes")
        self.assertEqual(self.read_manifest(REMOTE_HASH)["name"], "hidden notes")

    # ------------------------------------------------------------ mappings

    def test_mappings_include_manifest_only_entries_alongside_tsv_rows(self):
        self.catalog.register(LOCAL_HASH, "/a.pdf", "Manifest Only")
        self.add_converted(REMOTE_HASH, "Converted", "https://example.com/c.pdf")
        mappings = self.catalog.mappings()
        self.assertEqual(set(mappings), {LOCAL_HASH, REMOTE_HASH})
        self.assertEqual(mappings[LOCAL_HASH].source_ref, "/a.pdf")
        self.assertEqual(mappings[LOCAL_HASH].name, "Manifest Only")
        self.assertEqual(mappings[REMOTE_HASH].name, "Converted")

    def test_tsv_row_wins_over_manifest_for_the_same_hash(self):
        self.add_converted(LOCAL_HASH, "Converted", "/tsv/source.pdf")
        self.catalog.register(LOCAL_HASH, "/manifest/source.pdf", "Manifest Name")
        mapping = self.catalog.mappings()[LOCAL_HASH]
        self.assertEqual(mapping.source_ref, "/tsv/source.pdf")
        self.assertEqual(mapping.name, "Converted")

    # ------------------------------------------------------------ manifests

    def test_manifests_pick_up_entry_json_written_by_another_process(self):
        self.assertEqual(self.catalog.manifests(), {})
        self.write_raw_manifest(LOCAL_HASH, json.dumps({"name": "Elsewhere", "source_ref": "/x.pdf"}))
        self.assertEqual(self.catalog.manifests()[LOCAL_HASH],
                         {"name": "Elsewhere", "source_ref": "/x.pdf"})

    def test_manifests_ignore_malformed_json_non_objects_and_non_hash_directories(self):
        self.write_raw_manifest(LOCAL_HASH, '{"name": "Good", "source_ref": "/g.pdf"}')
        self.write_raw_manifest(REMOTE_HASH, "{not json")
        self.write_raw_manifest(THIRD_HASH, "[1, 2]")
        # Uppercase is not a valid hash. Pick a name with no lowercase twin:
        # macOS volumes are case-insensitive, so the two would share a directory.
        self.write_raw_manifest("ABCDEF0123456789", '{"name": "Upper", "source_ref": "/u.pdf"}')
        self.write_raw_manifest("notahash", '{"name": "Words", "source_ref": "/w.pdf"}')
        self.write_raw_manifest("abc", '{"name": "Short", "source_ref": "/s.pdf"}')
        self.assertEqual(set(self.catalog.manifests()), {LOCAL_HASH})

    def test_non_utf8_entry_json_is_skipped_instead_of_failing_the_catalog(self):
        self.write_raw_manifest(LOCAL_HASH, b"\xff\xfe\x00garbage")
        self.write_raw_manifest(REMOTE_HASH, '{"name": "Good", "source_ref": "/g.pdf"}')
        self.assertEqual(set(self.catalog.manifests()), {REMOTE_HASH})

    # ---------------------------------------------------------- source_pdf

    def test_source_pdf_returns_local_original_while_it_exists(self):
        pdf = self.write_pdf()
        self.catalog.register(LOCAL_HASH, str(pdf), "Local Doc")
        self.assertEqual(self.catalog.source_pdf(LOCAL_HASH), pdf)
        pdf.unlink()
        self.assertIsNone(self.catalog.source_pdf(LOCAL_HASH))

    def test_source_pdf_returns_cached_download_for_url_entry(self):
        self.catalog.register(REMOTE_HASH, "https://example.com/a.pdf", "Remote")
        self.assertIsNone(self.catalog.source_pdf(REMOTE_HASH))
        cached = self.root / REMOTE_HASH / "_source" / "a.pdf"
        cached.parent.mkdir(parents=True)
        cached.write_bytes(b"%PDF-1.4")
        self.assertEqual(self.catalog.source_pdf(REMOTE_HASH), cached)

    def test_source_pdf_is_none_for_unknown_or_invalid_hash(self):
        self.assertIsNone(self.catalog.source_pdf(LOCAL_HASH))
        self.assertIsNone(self.catalog.source_pdf("../escape"))
        self.assertIsNone(self.catalog.source_pdf(""))

    # ---------------------------------------------------------- entry_name

    def test_entry_name_prefers_canonical_html_stem(self):
        self.add_converted(LOCAL_HASH, "Canon", "/x.pdf")
        self.catalog.register(LOCAL_HASH, "/x.pdf", "Manifest Name")
        self.assertEqual(self.catalog.entry_name(LOCAL_HASH), "Canon")

    def test_entry_name_uses_manifest_name_without_converted_html(self):
        self.catalog.register(LOCAL_HASH, "/some/Source File.pdf", "Pretty Name")
        self.assertEqual(self.catalog.entry_name(LOCAL_HASH), "Pretty Name")

    def test_entry_name_falls_back_to_source_file_stem(self):
        cached = self.root / REMOTE_HASH / "_source" / "Remote Doc.pdf"
        cached.parent.mkdir(parents=True)
        cached.write_bytes(b"%PDF-1.4")
        self.assertEqual(self.catalog.entry_name(REMOTE_HASH), "Remote Doc")

    # ---------------------------------------------------------- viewer_href

    def test_viewer_href_for_manifest_only_entry_with_source_is_reader(self):
        self.catalog.register(LOCAL_HASH, str(self.write_pdf()), "Local Doc")
        self.assertEqual(self.catalog.viewer_href(LOCAL_HASH), f"/r/{LOCAL_HASH}/")
        self.assertEqual(self.catalog.viewer_href(LOCAL_HASH, prefer_reader=True), f"/r/{LOCAL_HASH}/")

    def test_viewer_href_for_converted_entry_is_html_path_unless_reader_preferred(self):
        pdf = self.write_pdf("My Doc.pdf")
        entry, _ = self.add_converted(LOCAL_HASH, "My Doc", str(pdf))
        (entry / "My Doc.light.html").write_text("<title>My Doc</title>", encoding="utf-8")
        self.assertEqual(self.catalog.viewer_href(LOCAL_HASH, prefer_reader=False),
                         f"/{LOCAL_HASH}/My Doc.light.html")
        self.assertEqual(self.catalog.viewer_href(LOCAL_HASH, prefer_reader=True), f"/r/{LOCAL_HASH}/")

    def test_viewer_href_prefers_reader_only_when_source_exists(self):
        self.add_converted(LOCAL_HASH, "No Source", "/gone/missing.pdf")
        self.assertEqual(self.catalog.viewer_href(LOCAL_HASH, prefer_reader=True),
                         f"/{LOCAL_HASH}/No Source.html")

    def test_viewer_href_is_none_for_unknown_or_invalid_hash(self):
        self.assertIsNone(self.catalog.viewer_href(THIRD_HASH))
        self.assertIsNone(self.catalog.viewer_href(THIRD_HASH, prefer_reader=True))
        self.assertIsNone(self.catalog.viewer_href("../escape"))

    def test_manifest_only_entry_without_any_source_has_no_href(self):
        self.catalog.register(REMOTE_HASH, "https://example.com/a.pdf", "Remote")
        self.assertIsNone(self.catalog.viewer_href(REMOTE_HASH))
        self.assertNotIn(REMOTE_HASH, [entry["hash"] for entry in self.catalog.list_entries()])

    # --------------------------------------------------------- list / ext

    def test_list_entries_includes_manifest_only_entries_as_reader_entries(self):
        pdf = self.write_pdf()
        self.catalog.register(LOCAL_HASH, str(pdf), "Manifest Only")
        entries = {entry["hash"]: entry for entry in self.catalog.list_entries()}
        entry = entries[LOCAL_HASH]
        self.assertEqual(entry["href"], f"/r/{LOCAL_HASH}/")
        self.assertIsNone(entry["canonical_href"])
        self.assertEqual(entry["reader_href"], f"/r/{LOCAL_HASH}/")
        self.assertEqual(entry["name"], "Manifest Only")
        self.assertEqual(entry["source_ref"], str(pdf))

    def test_extension_entries_include_manifest_only_url_and_file_entries(self):
        self.catalog.register(REMOTE_HASH, "https://Example.com/docs/a.pdf", "Remote")
        cached = self.root / REMOTE_HASH / "_source" / "a.pdf"
        cached.parent.mkdir(parents=True)
        cached.write_bytes(b"%PDF-1.4")
        pdf = self.write_pdf()
        self.catalog.register(LOCAL_HASH, str(pdf), "Local")
        entries = {entry["hash"]: entry for entry in self.catalog.extension_entries()}
        self.assertEqual(entries[REMOTE_HASH], {"kind": "url", "host": "example.com", "path": "/docs/a.pdf",
                                                "hash": REMOTE_HASH, "disabled": False})
        self.assertEqual(entries[LOCAL_HASH], {"kind": "file", "path": str(pdf), "hash": LOCAL_HASH,
                                               "disabled": False})

    # ---------------------------------------------------------- rename

    def test_rename_manifest_only_entry_updates_entry_json(self):
        self.catalog.register(LOCAL_HASH, str(self.write_pdf()), "Old")
        result = self.catalog.rename(LOCAL_HASH, "New Name")
        self.assertEqual(result["old_name"], "Old")
        self.assertEqual(result["new_name"], "New Name")
        self.assertTrue(result["renamed"])
        self.assertEqual(result["href"], f"/r/{LOCAL_HASH}/")
        self.assertEqual(self.read_manifest(LOCAL_HASH)["name"], "New Name")
        self.assertEqual(self.catalog.entry_name(LOCAL_HASH), "New Name")
        self.assertEqual(self.activity.boosted, [(LOCAL_HASH, 3)])

    def test_rename_manifest_only_entry_to_same_name_is_not_a_rename(self):
        self.catalog.register(LOCAL_HASH, str(self.write_pdf()), "Same")
        result = self.catalog.rename(LOCAL_HASH, "Same")
        self.assertFalse(result["renamed"])
        self.assertEqual(result["href"], f"/r/{LOCAL_HASH}/")
        self.assertEqual(self.activity.boosted, [])

    def test_rename_unknown_hash_raises_entry_not_found(self):
        with self.assertRaises(EntryNotFound):
            self.catalog.rename(THIRD_HASH, "Anything")

    # ---------------------------------------------------------- delete

    def test_delete_manifest_only_entry_returns_manifest_source_and_forgets_it(self):
        self.catalog.register(REMOTE_HASH, "https://example.com/docs/a.pdf?sig=1&_pdfvw=passthrough", "Remote")
        result = self.catalog.delete(REMOTE_HASH)
        self.assertEqual(result["source_ref"], "https://example.com/docs/a.pdf?sig=1")
        self.assertFalse(result["mapping_dropped"])
        self.assertTrue(result["removed_dir"])
        self.assertFalse((self.root / REMOTE_HASH).exists())
        self.assertNotIn(REMOTE_HASH, self.catalog.mappings())
        self.assertEqual(self.activity.forgotten, [REMOTE_HASH])

    # ------------------------------------------------- browser URL routing

    def test_daemon_reader_url_resolves_to_its_hash(self):
        self.assertEqual(self.catalog.hash_for_browser_url(f"http://localhost:7435/r/{LOCAL_HASH}/"),
                         LOCAL_HASH)

    def test_read_route_resolves_a_registered_local_file(self):
        pdf = self.write_pdf()
        self.catalog.register(LOCAL_HASH, str(pdf), "Local Doc")
        self.assertEqual(self.catalog.hash_for_browser_url(f"http://localhost:7435/read?path={pdf}"),
                         LOCAL_HASH)

    def test_read_raw_route_resolves_a_remote_url_like_view_raw(self):
        remote = "https://example.com/a/b.pdf?sig=1&x=2"
        self.catalog.register(url_hash(remote), remote, "Remote")
        self.assertEqual(self.catalog.hash_for_browser_url(f"http://localhost:7435/read-raw?{remote}"),
                         url_hash(remote))

    def test_registered_path_resolves_when_reached_through_a_symlink(self):
        real = self.base / "real"
        real.mkdir()
        pdf = real / "doc.pdf"
        pdf.write_bytes(b"%PDF-1.4")
        link = self.base / "link"
        link.symlink_to(real, target_is_directory=True)
        through_link = link / "doc.pdf"
        self.catalog.register(LOCAL_HASH, str(through_link), "Doc")
        self.assertEqual(self.catalog.hash_for_browser_url(f"http://localhost:7435/read?path={through_link}"),
                         LOCAL_HASH)


if __name__ == "__main__":
    unittest.main()

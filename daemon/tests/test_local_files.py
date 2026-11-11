"""Local PDF lifecycle: generated documents only; no personal cache access."""
import asyncio
import pathlib
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import urlsplit, parse_qs
from fastapi import HTTPException
from starlette.requests import Request
import main
import state
from catalog import CacheCatalog, InvalidCatalogInput
from reader import Reader
from test_reader import _pdf


def pdf(pages, tag=''):
    return _pdf([b'<< /Type /Catalog /Pages 2 0 R >>',
        ('<< /Type /Pages /Kids [' + ' '.join(f'{i+3} 0 R' for i in range(pages)) + f'] /Count {pages} >>').encode(),
        *[f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {600+i} 800] /Tag ({tag}) >>'.encode() for i in range(pages)]])


class LocalFiles(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)
        self.catalog = CacheCatalog(self.root / 'cache')
        self.reader = Reader(self.catalog.root)
        self.patches = [patch.object(main, 'catalog', self.catalog), patch.object(main, 'reader', self.reader),
                        patch.object(state, 'DB_PATH', self.root / 'state.db')]
        for p in self.patches: p.start()
        self.path = self.root / 'draft.pdf'
        self.path.write_bytes(pdf(4))

    def tearDown(self):
        for p in reversed(self.patches): p.stop()
        self.tmp.cleanup()

    def open(self, path=None):
        response = main._view_path(str(path or self.path))
        return response.headers['location'].split('/')[2]

    def test_changed_path_inherits_clamped_state_and_collects_derived_data(self):
        old = self.open()
        state.put(old, 'position', {'page': 4}, 100)
        state.put(old, 'marks', {'a': {'page': 3, 'ts': 101}}, 101)
        state.put(old, 'zoom', '1.5', 102)
        (self.catalog.root / old / 'ocr.json').write_text('derived')
        self.path.write_bytes(pdf(2))
        new = self.open()
        self.assertNotEqual(old, new)
        self.assertEqual(state.get_all(new)['position']['value']['page'], 2)
        self.assertEqual(state.get_all(new)['marks']['value']['a']['page'], 2)
        self.assertEqual(state.get_all(new)['zoom']['value'], '1.5')
        self.assertFalse((self.catalog.root / old).exists())

    def test_open_tab_snapshot_does_not_change_before_validated_reopen(self):
        old = self.open()
        snapshot = self.catalog.source_pdf(old)
        original = snapshot.read_bytes()
        stamp = self.catalog.local_stamp(self.path)
        self.path.write_bytes(pdf(2))
        self.assertEqual(snapshot.read_bytes(), original)
        self.assertEqual(main.local_file_check(str(self.path), stamp)['status'], 'changed')
        self.assertEqual(main.local_file_current(old)['path'], str(self.path))

    def test_other_path_reference_keeps_snapshot_and_does_not_inherit_unrelated_state(self):
        old = self.open()
        other = self.root / 'other.pdf'; other.write_bytes(self.path.read_bytes())
        self.assertEqual(self.open(other), old)
        self.path.write_bytes(pdf(2))
        new = self.open()
        self.assertTrue((self.catalog.root / old).exists())
        self.assertEqual(self.catalog.source_pdf(old).read_bytes(), other.read_bytes())
        unrelated = self.root / 'unrelated.pdf'; unrelated.write_bytes(pdf(1, 'unrelated'))
        identity = self.open(unrelated)
        self.assertEqual(state.get_all(identity), {})
        state.put(identity, 'zoom', '2', 12)
        state.put(new, 'zoom', '3', 15)
        self.path.write_bytes(unrelated.read_bytes())
        self.assertEqual(self.open(), identity)
        self.assertEqual(state.get_all(identity)['zoom']['value'], '2')

    def test_raw_and_query_share_entry(self):
        old = self.open()
        request = Request({'type': 'http', 'query_string': self.path.as_uri().encode(), 'headers': []})
        raw = main.view_file_raw(request)
        self.assertIn('/r/' + old + '/', raw.headers['location'])

    def test_moved_renamed_and_symlink_preserve_identity_and_file_url(self):
        old = self.open()
        moved = self.root / 'renamed.pdf'; self.path.rename(moved)
        self.assertEqual(self.open(moved), old)
        alias = self.root / 'alias.pdf'; alias.symlink_to(moved)
        self.assertEqual(self.open(alias), old)
        self.assertIn(str(alias), [e['path'] for e in self.catalog.extension_entries()])
        self.catalog.set_disabled(old, True)
        self.assertTrue(self.catalog.is_disabled(self.catalog.local_entry(alias)))
        self.assertEqual(self.catalog.native_source(old).value, alias)

    def test_disabled_unregistered_symlink_raw_route_keeps_original_url(self):
        old = self.open()
        self.catalog.set_disabled(old, True)
        alias = self.root / 'disabled alias.pdf'; alias.symlink_to(self.path)
        request = Request({'type': 'http', 'scheme': 'http', 'server': ('localhost', 7444),
            'path': '/view-file-raw', 'query_string': alias.as_uri().encode(), 'headers': []})
        with patch.object(main, '_queue_navigate_signal') as navigate, patch.object(main, '_queue_extension_sync_signal'):
            main.view_file_raw(request)
        self.assertEqual(navigate.call_args.args[1], alias.as_uri())
        self.assertIn(str(alias), [e['path'] for e in self.catalog.extension_entries()])

    def test_deleted_file_keeps_open_snapshot_and_poll_reports_missing(self):
        old = self.open(); data = self.path.read_bytes(); self.path.unlink()
        self.assertEqual(self.catalog.source_pdf(old).read_bytes(), data)
        self.assertEqual(main.local_file_check(str(self.path))['status'], 'missing')
        with self.assertRaises(HTTPException) as error: self.open()
        self.assertEqual(error.exception.status_code, 404)

    def test_truncated_and_mutating_files_never_replace_snapshot(self):
        old = self.open()
        self.path.write_bytes(b'%PDF-1.7\n')
        with self.assertRaises(HTTPException) as error: self.open()
        self.assertEqual(error.exception.status_code, 409)
        self.assertEqual(self.catalog.local_entry(self.path), old)
        self.path.write_bytes(pdf(2))
        with patch('catalog.time.sleep', side_effect=lambda _: self.path.write_bytes(pdf(3))):
            with self.assertRaises(HTTPException): self.open()
        self.assertEqual(self.catalog.local_entry(self.path), old)
        self.path.write_bytes(b'%PDF-1.7\nnot a valid PDF\n%%EOF')
        with self.assertRaises(HTTPException): self.open()
        self.assertEqual(self.catalog.local_entry(self.path), old)

    def test_unicode_and_long_path(self):
        parent = self.root
        for i in range(6): parent /= ('long-' + str(i)) * 20
        parent.mkdir(parents=True)
        name = parent / 'Résumé 数学 # & %.pdf'; name.write_bytes(pdf(1))
        hash_ = self.open(name)
        self.assertEqual(self.catalog.local_entry(name), hash_)
        self.assertEqual(main.local_file_check(str(name), self.catalog.local_stamp(name))['status'], 'unchanged')

    def test_file_access_hint(self):
        async def body(): return {'allowed': False}
        class R: json = staticmethod(body)
        with patch.object(main, '_file_scheme_access', None):
            asyncio.run(main.extension_file_access(R()))
            self.assertFalse(main.healthz()['file_scheme_access'])
            self.assertIn('Allow access to file URLs', main.healthz()['file_access_hint'])

"""In-place opens (/extension/locate, /extension/address): generated documents only."""
import pathlib
import tempfile
import unittest
from unittest.mock import patch

from fastapi import HTTPException

import main
import state
from catalog import CacheCatalog, url_hash
from reader import Reader
from test_local_files import pdf


class _Request:
    base_url = 'http://127.0.0.1:7435/'


class InPlace(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name).resolve()
        self.catalog = CacheCatalog(self.root / 'cache')
        self.reader = Reader(self.catalog.root)
        self.patches = [patch.object(main, 'catalog', self.catalog), patch.object(main, 'reader', self.reader),
                        patch.object(main, 'CACHE_DIR', self.catalog.root),
                        patch.object(state, 'DB_PATH', self.root / 'state.db')]
        for p in self.patches: p.start()
        self.path = self.root / 'Lecture notes.pdf'
        self.path.write_bytes(pdf(3))

    def tearDown(self):
        for p in reversed(self.patches): p.stop()
        self.tmp.cleanup()

    def locate(self, url):
        return main.extension_locate(main.ExtensionLocateRequest(url=url), _Request())

    def store_remote(self, url):
        hash_ = url_hash(url)
        source = self.catalog.root / hash_ / '_source'
        source.mkdir(parents=True)
        (source / 'paper.pdf').write_bytes(pdf(2))
        self.catalog.register(hash_, url, 'paper')
        return hash_

    def test_local_file_address_answers_its_reader(self):
        answer = self.locate(self.path.as_uri() + '#page=2')
        self.assertRegex(answer['reader'], r'^/r/[a-f0-9]{16}/\?local=')
        self.assertEqual(answer['hash'], answer['reader'].split('/')[2])
        self.assertEqual(main.extension_address(answer['hash']), {'url': self.path.as_uri(), 'disabled': False})

    def test_disabled_local_file_is_left_to_the_browser_with_the_marker(self):
        hash_ = self.locate(self.path.as_uri())['hash']
        self.catalog.set_disabled(hash_, True)
        answer = self.locate(self.path.as_uri())
        self.assertEqual(answer, {'native': self.path.as_uri() + '?_pdfvw=passthrough'})
        self.assertTrue(main.extension_address(hash_)['disabled'])

    def test_missing_local_file_is_left_to_the_browser(self):
        answer = self.locate((self.root / 'gone.pdf').as_uri())
        self.assertNotIn('reader', answer)
        self.assertTrue(answer['native'].endswith('?_pdfvw=passthrough'))

    def test_stored_remote_document_revalidates_before_answering(self):
        url = 'https://papers.test/pdf/2401.00001'
        hash_ = self.store_remote(url)
        with patch.object(main.sources, 'download', return_value='paper.pdf') as download:
            answer = self.locate(url + '?download=1#page=4')
        download.assert_called_once_with(url + '?download=1', self.catalog.root / hash_ / '_source')
        self.assertEqual(answer, {'reader': f'/r/{hash_}/', 'hash': hash_})
        self.assertEqual(main.extension_address(hash_)['url'], url + '?download=1')

    def test_disabled_remote_document_is_left_to_the_browser(self):
        url = 'https://papers.test/pdf/2401.00002'
        self.catalog.set_disabled(self.store_remote(url), True)
        self.assertEqual(self.locate(url), {'native': url + '?_pdfvw=passthrough'})

    def test_only_web_and_file_addresses_are_located(self):
        for url in ('chrome://settings', 'ftp://host/a.pdf', 'file://otherhost/a.pdf'):
            with self.assertRaises(HTTPException):
                self.locate(url)


if __name__ == '__main__':
    unittest.main()

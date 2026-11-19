from __future__ import annotations
import pathlib
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import unquote
from fastapi import HTTPException
import main
from catalog import CacheCatalog


class DownloadTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = pathlib.Path(self.tmp.name)
        self.catalog = CacheCatalog(self.root)
        p = patch.object(main, 'catalog', self.catalog)
        p.start()
        self.addCleanup(p.stop)

    def test_download_keeps_the_stored_pdf_when_original_changes(self):
        hash_ = '123456abcdef1234'
        source = self.root / hash_ / '_source' / 'source.pdf'
        source.parent.mkdir(parents=True)
        source.write_bytes(b'%PDF-1.7 stored revision\n%%EOF')
        original = self.root / 'original.pdf'
        original.write_bytes(b'%PDF-1.7 different revision\n%%EOF')
        self.catalog.register(hash_, str(original), 'Résumé / notes.pdf')
        response = main.download_pdf(hash_)
        self.assertEqual(pathlib.Path(response.path).read_bytes(), source.read_bytes())
        self.assertEqual(response.media_type, 'application/pdf')
        disposition = unquote(unquote(response.headers['content-disposition']))
        self.assertTrue(disposition.startswith('attachment;'))
        self.assertIn('Résumé - notes.pdf', disposition)
        self.assertNotIn('.pdf.pdf', disposition)

    def test_cached_remote_pdf_downloads_without_fetching_source(self):
        hash_ = 'abcdef123456abcd'
        source = self.root / hash_ / '_source' / 'notes.pdf'
        source.parent.mkdir(parents=True)
        source.write_bytes(b'%PDF-1.4 signed-in bytes\n%%EOF')
        self.catalog.register(hash_, 'https://signed-in.test/notes.pdf', 'Course notes')
        response = main.download_pdf(hash_)
        self.assertEqual(pathlib.Path(response.path), source)
        self.assertIn('Course notes.pdf', unquote(response.headers['content-disposition']))

    def test_invalid_or_missing_entries_fail(self):
        for hash_, expected in [('invalid', 400), ('aabbccddeeff0011', 404)]:
            with self.subTest(hash=hash_), self.assertRaises(HTTPException) as caught:
                main.download_pdf(hash_)
            self.assertEqual(caught.exception.status_code, expected)

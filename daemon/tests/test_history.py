"""History extraction uses copied WALs and never opens an owner profile in-place."""
import importlib.util
from pathlib import Path
import sqlite3
import tempfile
import time
import unittest
spec=importlib.util.spec_from_file_location('history_extract',Path(__file__).resolve().parents[2]/'bench/history/extract.py')
history=importlib.util.module_from_spec(spec);spec.loader.exec_module(history)

class HistoryTests(unittest.TestCase):
    def test_classification(self):
        self.assertEqual(history.classify('https://example.test/a.pdf?token=secret'),'needs-session')
        self.assertEqual(history.classify('https://example.test/a.pdf'),'public')
        self.assertEqual(history.classify('file:///nonexistent-fixture.pdf'),'gone')
        self.assertEqual(history.classify('https://user:pass@example.test/a.pdf'),'needs-session')

    def test_identify_viewer_and_pdf_paths(self):
        self.assertEqual(history.identify('http://localhost:7435/r/abcdef/',{'abcdef':'https://example.test/a.pdf'}),'https://example.test/a.pdf')
        self.assertEqual(history.identify('https://example.test/a.pdf/download',{}),'https://example.test/a.pdf/download')
        self.assertIsNone(history.identify('https://example.test/ordinary',{}))

    def test_wal_visits_are_read_from_copy(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'History'
            db=sqlite3.connect(path)
            db.execute('PRAGMA journal_mode=WAL')
            db.executescript('CREATE TABLE urls(id INTEGER,url TEXT);CREATE TABLE visits(url INTEGER,visit_time INTEGER);')
            db.execute('INSERT INTO urls VALUES(1,?)',('https://example.test/a.pdf',))
            ts=int((time.time()+11644473600)*1000000)
            db.executemany('INSERT INTO visits VALUES(1,?)',[(ts,),(ts,)])
            db.commit()
            before=path.stat().st_mtime_ns
            self.assertEqual(history.history(path,60),[('https://example.test/a.pdf',2)])
            self.assertEqual(path.stat().st_mtime_ns,before)
            db.close()

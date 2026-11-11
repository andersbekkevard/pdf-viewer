"""Privacy, bounded ingestion, redirect correlation and aggregate contracts."""
import asyncio
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
import opens

class OpensTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.patch=patch.object(opens,'DB_PATH',Path(self.temp.name)/'opens.db')
        self.patch.start(); self.addCleanup(self.patch.stop)

    def test_summary_and_privacy(self):
        opens.record('a','abcdef','url','reader',ms=20)
        opens.record('b',None,'file','fallback','not-found',30)
        opens.timing('abcdef',dict(load_id='a'*32,first_page_ms=120,text_ms=180,errors=['type-error']))
        s=opens.summary()['1']
        self.assertEqual(s['opens'],2)
        self.assertEqual(s['reader_share'],.5)
        self.assertEqual(s['p95_first_page_ms'],120)
        self.assertEqual(s['fallback_by_class']['not-found']['share'],.5)
        with opens.connect() as db:
            columns=[r[1] for r in db.execute('PRAGMA table_info(opens)')]
        self.assertFalse(set(columns)&{'url','path','name','host'})

    def test_ingestion_rejects_text_and_nonfinite(self):
        for value in (float('nan'),float('inf'),-1,True,'private'):
            with self.assertRaises(ValueError):
                opens.timing('abcdef',dict(load_id='a'*32,first_page_ms=value))
        with self.assertRaises(ValueError):
            opens.timing('abcdef',dict(load_id='a'*32,errors=['private error message']))

    def test_beacon_updates_one_load(self):
        for ms in (None,42,None):
            opens.timing('abcdef',dict(load_id='a'*32,first_page_ms=ms))
        self.assertEqual(opens.summary()['1']['timing_samples'],1)

    def test_write_failure_is_nonfatal(self):
        with patch.object(opens,'connect',side_effect=sqlite3.OperationalError):
            opens.record('a',None,'url','error')

    def test_redirect_then_shell_is_one_attempt(self):
        async def run():
            class Catalog:
                root=Path(self.temp.name)
                def source_pdf(self,hash_):return None
            async def app(scope,receive,send):
                redirect=scope['path']=='/read'
                await send(dict(type='http.response.start',status=307 if redirect else 200,
                                headers=[(b'location',b'/r/abcdef/')] if redirect else []))
                await send(dict(type='http.response.body',body=b''))
            middleware=opens.OpenMiddleware(app,Catalog())
            messages=[]
            async def send(m):messages.append(m)
            async def receive():return {}
            await middleware(dict(type='http',method='GET',path='/read',query_string=b'url=https://private.invalid/x.pdf'),receive,send)
            location=dict(messages[0]['headers'])[b'location'].decode()
            await middleware(dict(type='http',method='GET',path='/r/abcdef/',query_string=location.split('?')[1].encode()),receive,send)
            s=opens.summary()['1']
            self.assertEqual(s['opens'],1)
            self.assertEqual(s['reader_share'],1)
        asyncio.run(run())

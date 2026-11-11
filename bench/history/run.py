#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Replay copied browser history on a scratch reader. Outputs are private."""
import argparse
from collections import Counter
from difflib import SequenceMatcher
import json
import math
import hashlib
import sqlite3
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import unicodedata
import urllib.request
from urllib.parse import urlencode, urlsplit, unquote
from extract import extract

REPO=Path(__file__).resolve().parents[2]
OUT=Path.home()/'.cache/pdf_viewer-bench/history'

def pct(values,p):
    values=sorted(v for v in values if v is not None)
    return round(values[min(len(values)-1,max(0,math.ceil(len(values)*p)-1))],1) if values else None

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--days',type=int,default=60)
    p.add_argument('--browser',choices=['all','chrome','comet'],default='all')
    p.add_argument('--profile')
    p.add_argument('--limit',type=int,default=300)
    p.add_argument('--port',type=int,default=7445)
    p.add_argument('--extract-only',action='store_true')
    a=p.parse_args()
    if a.port==7435 or not 1<=a.limit<=300: p.error('scratch port and limit 1..300 required')
    OUT.mkdir(parents=True,exist_ok=True,mode=0o700)
    os.chmod(OUT,0o700)
    rows,profiles=extract(a.days,a.browser,a.profile)
    (OUT/'manifest.json').write_text(json.dumps(rows,indent=2))
    classes=dict(Counter(r['classification'] for r in rows))
    if a.extract_only:
        print(json.dumps(dict(profiles=profiles,distinct=len(rows),classes=classes)));return
    # Resolve the existing install without downloading/installing anything.
    pw=subprocess.check_output(['bash','-c',f'source "{REPO}/scripts/lib/playwright.sh"; resolve_playwright && printf "%s" "$PW_NODE_PATH"'],text=True)
    env=os.environ.copy();env['NODE_PATH']=pw
    base=f'http://127.0.0.1:{a.port}'
    with tempfile.TemporaryDirectory(prefix='pdfv-history-cache-') as temp:
        env.update(PDF_VIEWER_ENGINE='reader',PDF_VIEWER_CACHE_DIR=temp,PDFV_STATE_DB=temp+'/state.db')
        cache=Path(temp)
        with (OUT/'daemon.log').open('w') as log:
            server=subprocess.Popen(['uv','run','--directory',str(REPO/'daemon'),'uvicorn','main:app','--host','127.0.0.1','--port',str(a.port)],env=env,stdout=log,stderr=log)
            try:
                for _ in range(100):
                    if server.poll() is not None: raise RuntimeError('scratch daemon failed')
                    try:
                        with urllib.request.urlopen(base+'/healthz',timeout=1) as r: health=json.load(r)
                        if health['cache_dir']!=temp: raise RuntimeError('port belongs to another daemon')
                        break
                    except OSError: time.sleep(.1)
                else: raise RuntimeError('scratch daemon startup timed out')
                results=[]; hosts={}; failed_hosts=set()
                candidates=sorted((r for r in rows if r['classification'] in ('local','public')),key=lambda r:-r['visits'])[:a.limit]
                for row in candidates:
                    result={k:v for k,v in row.items() if k!='source'}
                    host=urlsplit(row['source']).hostname if row['classification']=='public' else None
                    if host in failed_hosts:
                        result.update(outcome='skipped',failure='host-first-failure');results.append(result)
                        (OUT/(row['sha']+'.json')).write_text(json.dumps(result,indent=2))
                        continue
                    if host:
                        time.sleep(max(0,1-(time.monotonic()-hosts.get(host,0))))
                        hosts[host]=time.monotonic()
                    param={'path':unquote(urlsplit(row['source']).path)} if row['classification']=='local' else {'url':row['source']}
                    spec=OUT/(row['sha']+'-spec.json')
                    reference = None
                    words = []
                    if 'path' in param:
                        try:
                            code='import json,pypdfium2 as p,sys; d=p.PdfDocument(sys.argv[1]); t=d[0].get_textpage(); print(json.dumps(t.get_text_range()))'
                            ref=subprocess.run(['uv','run','--directory',str(REPO/'daemon'),'python','-c',code,param['path']],capture_output=True,text=True,timeout=30)
                            reference=json.loads(ref.stdout)
                            words=re.findall(r'\w{4,}',reference)[:8]
                        except (ValueError, subprocess.TimeoutExpired):
                            pass
                    spec.write_text(json.dumps({'url':base+'/read?'+urlencode(param), 'words':words}))
                    result['load_average']=os.getloadavg()
                    result['measured_at']=time.time()
                    try:
                        proc=subprocess.run(['node',str(REPO/'bench/history/drive.cjs'),str(spec)],env=env,capture_output=True,text=True,timeout=160)
                        data=json.loads(proc.stdout.strip().splitlines()[-1]);result.update(data)
                        if result.get('failure')=='fallback' and host:
                            u=urlsplit(row['source'])
                            h=hashlib.sha256((u.netloc+u.path).encode()).hexdigest()[:16]
                            with sqlite3.connect(f'file:{cache}/opens.db?mode=ro',uri=True) as db:
                                reason=db.execute("SELECT class FROM opens WHERE hash=? AND outcome='fallback' ORDER BY ts DESC LIMIT 1",(h,)).fetchone()
                            if reason: result['failure']=reason[0]
                        # First-page copy similarity and PDFium sampled-word find recall.
                        entry=data.get('entry')
                        pdf=Path(param['path']) if 'path' in param else next((cache/entry/'_source').glob('*.pdf'),None) if entry else None
                        if pdf and data.get('outcome')=='reader':
                            code='import json,pypdfium2 as p,sys; d=p.PdfDocument(sys.argv[1]); t=d[0].get_textpage(); print(json.dumps(t.get_text_range()))'
                            ref=subprocess.run(['uv','run','--directory',str(REPO/'daemon'),'python','-c',code,str(pdf)],capture_output=True,text=True,timeout=30)
                            text=json.loads(ref.stdout)
                            norm=lambda s: re.sub(r'\s+','',unicodedata.normalize('NFKC',s))
                            result['copy_similarity']=SequenceMatcher(None,norm(text),norm(result.pop('dom_text','')),autojunk=False).ratio() if text else None
                            # Actual browser find recall uses local first-page reference words.
                        result.pop('dom_text',None)
                    except Exception as e:
                        result.update(outcome='error',failure='harness-'+type(e).__name__)
                    if host and (result.get('outcome')!='reader' or result.get('failure')): failed_hosts.add(host)
                    results.append(result)
                    (OUT/(row['sha']+'.json')).write_text(json.dumps(result,indent=2))
                total=sum(r['visits'] for r in results if r.get('outcome')!='skipped')
                report=dict(days=a.days,profiles=profiles,distinct=len(rows),classes=classes,replayed=len(results),
                    measured=sum(r.get('outcome')!='skipped' for r in results),weighted_success=sum(r['visits'] for r in results if r.get('outcome')=='reader' and not r.get('failure'))/total if total else None,
                    replayed_visits=total,eligible_visits=sum(r['visits'] for r in candidates),
                    failures=dict(Counter(r['failure'] for r in results if r.get('failure'))),
                    p50_first_page_ms=pct([r.get('first_page_ms') for r in results],.5),p95_first_page_ms=pct([r.get('first_page_ms') for r in results],.95),
                    p50_text_ms=pct([r.get('text_ms') for r in results],.5),p95_text_ms=pct([r.get('text_ms') for r in results],.95),
                    worst=[{k:r.get(k) for k in ('sha','failure','first_page_ms','text_ms')} for r in sorted((r for r in results if r.get('outcome')!='skipped'),key=lambda r:(bool(r.get('failure')),r.get('first_page_ms') or 0),reverse=True)[:10]])
                (OUT/'results.json').write_text(json.dumps(results,indent=2))
                (OUT/'aggregate.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
            finally:
                server.terminate()
                try:server.wait(timeout=15)
                except subprocess.TimeoutExpired:server.kill();server.wait()
if __name__=='__main__':main()

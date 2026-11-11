"""Read copied Chromium histories; private source strings stay outside the repo."""
import hashlib
from pathlib import Path
import re
import shutil
import sqlite3
import tempfile
import time
from urllib.parse import urlsplit, parse_qs, unquote

ROOTS = {'chrome': Path.home()/'Library/Application Support/Google/Chrome',
         'comet': Path.home()/'Library/Application Support/Comet'}

def profiles(browser='all', profile=None):
    for name, root in ROOTS.items():
        if browser not in ('all', name):
            continue
        for path in root.glob('*/History'):
            if profile is None or path.parent.name == profile:
                yield path

def history(path, days):
    # Open ONLY the copied database (including committed WAL transactions).
    with tempfile.TemporaryDirectory(prefix='pdfv-history-') as temp:
        copy = Path(temp)/'History'
        for suffix in ('', '-wal'):
            src = Path(str(path)+suffix)
            if src.exists():
                shutil.copy2(src, str(copy)+suffix)
        with sqlite3.connect(f'file:{copy}?mode=ro', uri=True) as db:
            cutoff = int((time.time()-days*86400+11644473600)*1000000)
            return db.execute('SELECT urls.url, COUNT(*) FROM visits JOIN urls ON urls.id=visits.url WHERE visits.visit_time>=? GROUP BY urls.url', (cutoff,)).fetchall()

def identify(url, mappings):
    u = urlsplit(url)
    if u.hostname in ('localhost','127.0.0.1') and u.port == 7435:
        q = parse_qs(u.query)
        if q.get('path'):
            return Path(q['path'][0]).as_uri()
        if q.get('url'):
            return q['url'][0]
        if u.path.endswith('-raw') and u.query.startswith(('http:', 'https:', 'file:')):
            return u.query
        match = re.match(r'^/(?:r/)?([a-f0-9]{6,64})/', u.path)
        if match:
            ref = mappings.get(match[1])
            return (Path(ref).as_uri() if ref and ref.startswith('/') else ref) or 'missing:'+match[1]
    if u.scheme in ('file','http','https') and re.search(r'\.pdf(?:$|[/;])', unquote(u.path), re.I):
        return url
    return None

def classify(url):
    u = urlsplit(url)
    if u.scheme == 'file':
        return 'local' if u.netloc in ('','localhost') and Path(unquote(u.path)).is_file() else 'gone'
    if u.scheme not in ('http', 'https'):
        return 'gone'
    # Signed URLs and any query-bearing URLs are conservatively session-only.
    # Never replay token/cookie-bearing URLs, even if an old signature still works.
    if u.query or u.username or re.search(r'(login|sso|auth|canvas|blackboard|sharepoint)', u.netloc+u.path, re.I):
        return 'needs-session'
    return 'public'

def extract(days, browser='all', profile=None, cache=None):
    mappings = {}
    mapping_file = (cache or Path.home()/'.cache/pdf_viewer')/'mappings.tsv'
    if mapping_file.exists():
        for line in mapping_file.read_text().splitlines():
            fields = line.split('\t')
            if len(fields)>=4:
                mappings[fields[2]] = fields[1]
    for manifest in mapping_file.parent.glob('*/entry.json'):
        try:
            import json
            value = json.loads(manifest.read_text())
            mappings.setdefault(manifest.parent.name, value.get('source_ref', ''))
        except (OSError, ValueError):
            pass
    docs = {}
    count = 0
    for db in profiles(browser, profile):
        count += 1
        for url, visits in history(db, days):
            try:
                source = identify(url, mappings)
            except (ValueError, OSError):
                continue
            if not source:
                continue
            # Fragment changes don't create new documents. Queries retained privately.
            source = source.split('#')[0]
            key = hashlib.sha256(source.encode()).hexdigest()[:16]
            if source.startswith('file:') and classify(source)=='local':
                try:
                    with Path(unquote(urlsplit(source).path)).open('rb') as f:
                        key = hashlib.file_digest(f, 'sha256').hexdigest()[:16]
                except OSError:
                    pass
            row = docs.setdefault(key, dict(sha=key, source=source, visits=0, classification=classify(source)))
            row['visits'] += visits
    return list(docs.values()), count

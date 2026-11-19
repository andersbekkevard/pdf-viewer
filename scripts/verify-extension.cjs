#!/usr/bin/env node
/*
 * verify-extension.cjs — end-to-end check that every PDF the browser opens
 * is read in the reader at its own address (docs/in-place.md): the unpacked
 * extension, a scratch daemon and a local web origin, driven through headless
 * Chromium for Testing.
 *
 * Self-contained: a temp copy of extension/ points at the scratch daemon
 * (port 7450), which uses a temp cache and state db; the origin listens on
 * [::1]:7451, because the extension's static rule excludes localhost and
 * 127.0.0.1. Nothing touches ~/.cache/pdf_viewer or the daemons on 7435–7437.
 *
 * Usage: scripts/verify-extension.sh
 *   PDFV_VERIFY_SHOT=<png>   screenshot of the first in-place page
 *   PDFV_CHROMIUM=<binary>   browser to drive
 *   PDFV_VERIFY_PORT=<port>  scratch daemon port (origin: port + 1000)
 *   PDFV_VERIFY_RTT_MS, PDFV_VERIFY_MBPS   origin network shape (60, 100)
 *   PDFV_VERIFY_TARGET_MS    bound on a known-host gated open (1000)
 *   PDFV_VERIFY_DEBUG=1      print the service worker's console
 *   --cold-reader <dir>   measure unseen text PDFs, each through first page and full text
 *   --startup              measure first paint instead of running regressions
 *   PDFV_STARTUP_LOAD      number of background CPU burners (default 0)
 *   PDFV_VERIFY_KEEP=1       keep the scratch directory
 */
'use strict';

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
// PDFV_VERIFY_PORT moves the scratch daemon, and the origin to that port
// + 1000, so parallel runs in sibling checkouts do not collide. The origin
// never shares the daemon's port number: Chromium resolves `localhost` to
// [::1] first, so an origin there would answer the viewer's requests.
const DAEMON_PORT = Number(process.env.PDFV_VERIFY_PORT || 7450);
const ORIGIN_PORT = Number(process.env.PDFV_VERIFY_ORIGIN_PORT
  || (process.env.PDFV_VERIFY_PORT ? DAEMON_PORT + 1000 : 7451));
const DAEMON = `http://127.0.0.1:${DAEMON_PORT}`;
const VIEWER = `http://localhost:${DAEMON_PORT}`;
const ORIGIN = `http://[::1]:${ORIGIN_PORT}`;
const PDF = fs.readFileSync(path.join(REPO, 'test/fixtures/basic_text.pdf'));

// A 2 MB PDF for the gated document, so the timings include a realistic
// transfer: ten text pages sharing one uncompressed noise image.
function makePdf(pages = 10, imageBytes = 2 * 1024 * 1024) {
  const width = 1024;
  const height = Math.ceil(imageBytes / (width * 3));
  const image = require('crypto').randomBytes(width * height * 3);
  const objects = [];
  const add = (body) => { objects.push(body); return objects.length; };
  const catalog = add(null);
  const tree = add(null);
  const font = add(Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'));
  const img = add(Buffer.concat([
    Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${image.length} >>\nstream\n`),
    image, Buffer.from('\nendstream')]));
  const kids = [];
  for (let n = 1; n <= pages; n++) {
    const content = `q 400 0 0 300 106 380 cm /Im1 Do Q BT /F1 24 Tf 72 720 Td (Gated notes page ${n}) Tj ET`;
    const stream = add(Buffer.from(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
    kids.push(add(Buffer.from(`<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 612 792] `
      + `/Resources << /Font << /F1 ${font} 0 R >> /XObject << /Im1 ${img} 0 R >> >> /Contents ${stream} 0 R >>`)));
  }
  objects[catalog - 1] = Buffer.from(`<< /Type /Catalog /Pages ${tree} 0 R >>`);
  objects[tree - 1] = Buffer.from(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${pages} >>`);
  const parts = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const offsets = [];
  let length = parts[0].length;
  objects.forEach((body, i) => {
    offsets.push(length);
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), body, Buffer.from('\nendobj\n')]);
    parts.push(chunk);
    length += chunk.length;
  });
  const xref = ['xref', `0 ${objects.length + 1}`, '0000000000 65535 f ',
    ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n `)].join('\n');
  parts.push(Buffer.from(`${xref}\ntrailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${length}\n%%EOF\n`));
  return Buffer.concat(parts);
}
const GATED_PDF = makePdf();
// PDFV_VERIFY_BIG_MB=<n> adds an unpaced gated PDF of that size, to check the
// extension's upload of a large body.
const BIG_MB = Number(process.env.PDFV_VERIFY_BIG_MB || 0);
const BIG_PDF = BIG_MB ? makePdf(2, BIG_MB * 1024 * 1024) : null;
// The daemon's relay gives up after about 20 s of silence; allow a margin.
const RELAY_BOUND_MS = 25000;
// Navigation start → first page raster for a gated PDF on a known host.
const TARGET_MS = Number(process.env.PDFV_VERIFY_TARGET_MS || 1000);

const results = [];
function check(name, ok, detail = '') {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}
function skip(name, why) {
  console.log(`SKIP ${name} — ${why}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs, stepMs = 100) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await sleep(stepMs);
  }
  return null;
}

function findChromium() {
  if (process.env.PDFV_CHROMIUM) return process.env.PDFV_CHROMIUM;
  // Chromium for Testing still honours --load-extension; branded Chrome no
  // longer does, and the headless shell cannot run extensions at all.
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  const dirs = fs.existsSync(cache)
    ? fs.readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
    : [];
  for (const dir of dirs) {
    for (const rel of [
      'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      'chrome-linux/chrome',
    ]) {
      const candidate = path.join(cache, dir, rel);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  throw new Error('no Chromium for Testing under ~/Library/Caches/ms-playwright; set PDFV_CHROMIUM');
}

function portFree(port, host) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => resolve(true));
  });
}

function copyExtension(dir) {
  // extension/assets is a symlink to the repo's assets/: copy what it names.
  fs.cpSync(path.join(REPO, 'extension'), dir, {
    recursive: true,
    dereference: true,
    filter: (src) => !src.includes(`${path.sep}_metadata`),
  });
  for (const [file, count] of [['background.js', 2], ['bridge.js', 1], ['page.js', 1]]) {
    const target = path.join(dir, file);
    const text = fs.readFileSync(target, 'utf8');
    const patched = text.replace(/(127\.0\.0\.1|localhost):7435/g, `$1:${DAEMON_PORT}`);
    const replaced = (text.match(/(127\.0\.0\.1|localhost):7435/g) || []).length;
    if (replaced !== count) throw new Error(`${file}: expected ${count} daemon origins, found ${replaced}`);
    fs.writeFileSync(target, patched);
  }
}

// Network shape of the scratch origin: every response waits one round trip,
// and PDF bodies are paced to a bandwidth, so timings resemble a real host
// rather than loopback. PDFV_VERIFY_RTT_MS=0 PDFV_VERIFY_MBPS=0 turns it off.
const RTT_MS = Number(process.env.PDFV_VERIFY_RTT_MS ?? 60);
const MBPS = Number(process.env.PDFV_VERIFY_MBPS ?? 100);

function sendPaced(res, body, mbps = MBPS) {
  if (!mbps) { res.end(body); return; }
  const chunk = 64 * 1024;
  const msPerChunk = (chunk * 8) / (mbps * 1000);
  let offset = 0;
  const next = () => {
    if (offset >= body.length) { res.end(); return; }
    res.write(body.subarray(offset, offset + chunk));
    offset += chunk;
    setTimeout(next, msPerChunk);
  };
  next();
}

// The web origin: an open PDF, PDFs behind a session cookie (signed out, the
// host redirects to a sign-in page, as an SSO host does), a gated URL that
// answers HTML even when signed in, an ordinary HTML page on the gated host,
// and the login and logout that set and clear the cookie.
const flaky = { down: false };
function startOrigin(log, port = ORIGIN_PORT) {
  const server = http.createServer((req, res) => {
    const signedIn = /(?:^|;\s*)session=ok(?:;|$)/.test(req.headers.cookie || '');
    const url = new URL(req.url, ORIGIN);
    if (url.pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    log.push({ t: Date.now(), path: url.pathname, signedIn, conditional: req.headers['if-none-match'] || '', mode: req.headers['sec-fetch-mode'] || '' });
    setTimeout(() => {
      if (url.pathname === '/gated/doc.pdf' && signedIn && req.headers['if-none-match'] === '"gated-v1"') {
        res.writeHead(304, { ETag: '"gated-v1"' });
        res.end();
        return;
      }
      if (url.pathname === '/open/paper/2401.00001v2') {
        // A PDF whose URL does not say so (arXiv-style): only the type does.
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': PDF.length });
        sendPaced(res, PDF);
      } else if (/^\/startup\/public-\d+\.pdf$/.test(url.pathname)) {
        const body = Number(url.pathname.match(/(\d+)\.pdf$/)[1]) % 2 === 0 ? PDF : GATED_PDF;
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': body.length });
        sendPaced(res, body);
      } else if (url.pathname === '/open/download/7') {
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': PDF.length,
          'Content-Disposition': 'attachment; filename="export.pdf"' });
        sendPaced(res, PDF);
      } else if (url.pathname === '/open/flaky.pdf' && flaky.down) {
        // A host that has gone away: the connection drops.
        req.socket.destroy();
      } else if (url.pathname === '/open/doc.pdf' || url.pathname === '/open/flaky.pdf') {
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': PDF.length });
        sendPaced(res, PDF);
      } else if (url.pathname === '/gated/html.pdf' && signedIn) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<!doctype html><title>Unavailable</title>This document is not available');
      } else if (url.pathname === '/gated/big.pdf' && signedIn && BIG_PDF) {
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': BIG_PDF.length });
        res.end(BIG_PDF);
      } else if (/^\/gated\/[\w-]+\.pdf$/.test(url.pathname) && signedIn) {
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Length': GATED_PDF.length,
          'Content-Disposition': 'inline; filename="Gated Notes.pdf"',
          'ETag': '"gated-v1"',
        });
        // slow.pdf takes about 3 s, longer than the daemon holds a navigation.
        sendPaced(res, GATED_PDF, url.pathname === '/gated/slow.pdf' ? 5 : MBPS);
      } else if (url.pathname.startsWith('/gated/') && url.pathname.endsWith('.pdf')) {
        res.writeHead(302, { Location: `/sso?next=${encodeURIComponent(url.pathname + url.search)}` });
        res.end();
      } else if (url.pathname === '/gated/notes.html') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<!doctype html><title>Notes</title>course notes page');
      } else if (url.pathname === '/sso') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<!doctype html><title>Sign in</title><form>Sign in to continue</form>');
      } else if (url.pathname === '/login') {
        res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'session=ok; Path=/; HttpOnly' });
        res.end('<!doctype html><title>Signed in</title>signed in');
      } else if (url.pathname === '/logout') {
        res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'session=; Path=/; Max-Age=0' });
        res.end('<!doctype html><title>Signed out</title>signed out');
      } else {
        res.writeHead(404);
        res.end();
      }
    }, RTT_MS);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '::1', () => resolve(server));
  });
}

async function startDaemon(tmp) {
  const cache = path.join(tmp, 'cache');
  fs.mkdirSync(cache, { recursive: true });
  const logPath = path.join(tmp, 'daemon.log');
  const out = fs.openSync(logPath, 'a');
  const child = spawn('uv', ['run', '--directory', path.join(REPO, 'daemon'), 'uvicorn', 'main:app',
    '--host', '127.0.0.1', '--port', String(DAEMON_PORT), '--log-level', 'warning'], {
    env: {
      ...process.env,
      PDF_VIEWER_CACHE_DIR: cache,
      PDFV_STATE_DB: path.join(tmp, 'state.db'),
      PYTHONUNBUFFERED: '1',
      // The daemon's own download must reach [::1] directly.
      no_proxy: '*',
      NO_PROXY: '*',
    },
    stdio: ['ignore', out, out],
    detached: true,
  });
  const health = await waitFor(async () => {
    try {
      const resp = await fetch(`${DAEMON}/healthz`);
      return resp.ok ? await resp.json() : null;
    } catch (_) {
      return null;
    }
  }, 30000, 200);
  if (!health || health.cache_dir !== cache || health.engine !== 'reader') {
    throw new Error(`scratch daemon did not come up as expected: ${JSON.stringify(health)}; log ${logPath}`);
  }
  return { child, cache, logPath };
}

async function launch(profile, extensionDir, executablePath) {
  const context = await chromium.launchPersistentContext(profile, {
    executablePath,
    headless: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
  });
  const worker = context.serviceWorkers()[0]
    || await context.waitForEvent('serviceworker', { timeout: 15000 });
  if (process.env.PDFV_VERIFY_DEBUG) {
    worker.on('console', (msg) => console.log(`  [worker ${Date.now() % 100000}] ${msg.text()}`));
  }
  return { context, worker };
}

function dynamicRules(worker) {
  return worker.evaluate(() => chrome.declarativeNetRequest.getDynamicRules());
}

// Commits of the main frame, so a check can tell a direct reader open from a
// detour through the native viewer. The page script's own `#page=<n>`
// fragment (history.replaceState) is the same document, not another commit.
function trackCommits(page) {
  const commits = [];
  commits.times = [];
  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return;
    const url = frame.url(), last = commits[commits.length - 1];
    if (last && last.split('#')[0] === url.split('#')[0]) return;
    commits.push(url); commits.times.push(Date.now());
  });
  return commits;
}

const isNative = (url) => url.includes('_pdfvw=passthrough');

// The hash of the reader built in this page, or null: the shell's <meta>.
function readerHash(page) {
  return page.evaluate(() => {
    const meta = document.querySelector('meta[name="pdf2html-hash"]');
    return meta && document.querySelector('.pf') ? meta.content : null;
  }).catch(() => null);
}

async function gotoLoose(page, url) {
  // A navigation the extension redirects, or that a navigate signal replaces
  // a moment later, can abort Playwright's own wait; the URL checks follow.
  try {
    await page.goto(url, { waitUntil: 'commit', timeout: 15000 });
  } catch (error) {
    // A dead daemon's refused connection is what the daemon-down checks
    // provoke; the extension puts the tab back afterwards.
    if (!/ERR_ABORTED|ERR_CONNECTION_REFUSED|ERR_EMPTY_RESPONSE|interrupted|frame was detached/i.test(error.message)) throw error;
  }
}

async function readerReady(page, timeoutMs = 15000, stepMs = 200) {
  return waitFor(() => page.evaluate(() => {
    const pages = document.querySelectorAll('.pf');
    const img = document.querySelector('.pf img.bi');
    // > 1: a page without its raster shows the reader's 1 px placeholder.
    return pages.length > 0 && img && img.complete && img.naturalWidth > 1;
  }).catch(() => false), timeoutMs, stepMs);
}

function entryDirs(cache) {
  return fs.readdirSync(cache).filter((name) => /^[a-f0-9]{6,32}$/.test(name));
}

// Requests the origin saw for one path since a time.
function originHits(log, pathname, since) {
  return log.filter((r) => r.path === pathname && r.t >= since);
}

function describe(log, since) {
  return JSON.stringify(log.filter((r) => r.t >= since)
    .map((r) => `${r.t - since} ${r.path} ${r.mode || 'daemon'}${r.signedIn ? ' signed-in' : ''}`));
}

// Measure navigation to a decoded, visible raster across two animation frames.
async function firstPaint(page, url) {
  const start = performance.now();
  await gotoLoose(page, url);
  await page.waitForFunction(() => {
    const image = document.querySelector('#pf1 img.bi');
    if (!image?.complete || image.naturalWidth < 2) return false;
    const rect = image.getBoundingClientRect();
    return rect.width > 0 && rect.bottom > 0 && rect.top < innerHeight;
  }, null, { timeout: 15000 }).catch(async (error) => {
    const state = await page.evaluate(() => ({
      contentType: document.contentType, pages: document.querySelectorAll('.pf').length,
      opening: !!document.getElementById('pdfv-opening'),
    })).catch(() => null);
    throw new Error(`${url} → ${page.url()} ${JSON.stringify(state)}: ${error.message}`);
  });
  const documentMs = await page.evaluate(async () => {
    const image = document.querySelector('#pf1 img.bi');
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
    const deadline = performance.now() + 15000;
    // The initial raster may be replaced by a sharper one during decode.
    while (performance.now() < deadline) {
      const src = image.currentSrc;
      if (image.complete && image.naturalWidth > 1) {
        try {
          await image.decode();
          await frame();
          await frame();
          if (src === image.currentSrc && image.complete && image.naturalWidth > 1) {
            return Math.round(performance.now());
          }
        } catch (_) { /* superseded raster, wait for its replacement */ }
      }
      await frame();
    }
    throw new Error('first visible raster did not settle');
  });
  if (page.url().split('#')[0] !== url) throw new Error(`wrong address: ${page.url()}`);
  return { elapsed: Math.round(performance.now() - start), document: documentMs };
}

async function measureStartup(context, tmp, publicOrigin) {
  const page = await context.newPage();
  const burners = [];
  const load = Number(process.env.PDFV_STARTUP_LOAD || 0);
  const samples = [];
  try {
    for (let i = 0; i < load; i++) burners.push(spawn('node', ['-e', 'for (;;) {}'], { stdio: 'ignore' }));
    await page.goto(`${ORIGIN}/login`);
    await firstPaint(page, `${ORIGIN}/gated/warmup.pdf`);
    await page.goto('about:blank');
    for (let i = 0; i < 8; i++) {
      const local = path.join(tmp, `Local ${i}.pdf`);
      // Vary content so the daemon never shares a cached local entry across repetitions.
      const body = Buffer.concat([Buffer.from(i % 4 < 2 ? PDF : GATED_PDF), Buffer.from(`\n% trial ${i}\n`)]);
      fs.writeFileSync(local, body);
      fs.utimesSync(local, 1000, 1000);
      const file = require('url').pathToFileURL(local).href;
      const recent = i % 2 === 0;
      if (recent) fs.utimesSync(local, new Date(), new Date());
      for (const [scenario, url] of [
        [recent ? 'local-recent' : 'local-existing', file],
        ['public', `${publicOrigin}/startup/public-${i}.pdf`],
        ['gated', `${ORIGIN}/gated/trial-${i}.pdf`],
      ]) {
        const sample = { scenario, ...await firstPaint(page, url) };
        samples.push(sample);
        await page.goto('about:blank');
      }
    }
    const summary = {};
    for (const scenario of ['all', ...new Set(samples.map(s => s.scenario))]) {
      const sorted = samples.filter(s => scenario === 'all' || s.scenario === scenario)
        .map(s => s.elapsed).sort((a, b) => a - b);
      summary[scenario] = { n: sorted.length, p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
        p90: sorted[Math.ceil(sorted.length * 0.9) - 1] };
    }
    console.log(JSON.stringify({ load, summary, samples }));
  } finally {
    for (const burner of burners) burner.kill();
    await page.close();
  }
}

// Install the probe before the viewer starts. Marks use the document's
// clock so Playwright round trips and CPU contention in the driver do not
// inflate the first-paint measurement.
function markColdReaderMilestones() {
  let first = false, sharp = false, text = false;
  document.addEventListener('load', (event) => {
    const image = event.target;
    if (!image?.matches?.('#pf1 img.bi') || image.naturalWidth < 2 || sharp) return;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const rect = image.getBoundingClientRect();
      if (!image.complete || image.naturalWidth < 2 || rect.width <= 0 || rect.bottom <= 0 || rect.top >= innerHeight) return;
      if (!first) performance.mark('pdfv-bench-first');
      first = true;
      if (!sharp && image.naturalWidth >= Math.round(rect.width * devicePixelRatio) - 1) {
        sharp = true;
        performance.mark('pdfv-bench-sharp');
      }
    }));
  }, true);
  const observer = new MutationObserver(() => {
    if (text || document.documentElement?.dataset.readerText !== 'complete'
        || document.querySelector('[data-reader-pending]')) return;
    const pages = document.querySelectorAll('.pf');
    if (!pages[pages.length - 1]?.querySelector('.t')) return;
    text = true;
    performance.mark('pdfv-bench-text');
    observer.disconnect();
  });
  observer.observe(document, { attributes: true, subtree: true, attributeFilter: ['data-reader-text'] });
}

async function measureColdReader(context, tmp, directory) {
  const files = fs.readdirSync(directory).filter(name => name.endsWith('.pdf')).sort();
  if (!files.length) throw new Error('provide text PDFs for --cold-reader');
  const docs = files.map(name => ({ name, bytes: fs.readFileSync(path.join(directory, name)) }));
  await context.addInitScript(markColdReaderMilestones);
  const page = await context.newPage();
  const load = Number(process.env.PDFV_STARTUP_LOAD || 0);
  const repeats = Number(process.env.PDFV_COLD_REPEATS || 4);
  const burners = [];
  const samples = [];
  try {
    for (let i = 0; i < load; i++) burners.push(spawn('node', ['-e', 'for (;;) {}'], { stdio: 'ignore' }));
    for (let trial = -1; trial < repeats; trial++) {
      for (const doc of trial < 0 ? docs.slice(0, 1) : docs) {
        const local = path.join(tmp, `${trial}-${doc.name}`);
        fs.writeFileSync(local, Buffer.concat([doc.bytes, Buffer.from(`\n% cold trial ${trial}\n`)]));
        fs.utimesSync(local, 1000, 1000);
        const url = require('url').pathToFileURL(local).href;
        await gotoLoose(page, url);
        const marks = await page.waitForFunction(() => {
          const when = metric => performance.getEntriesByName('pdfv-bench-' + metric)[0]?.startTime;
          const first = when('first'), sharp = when('sharp'), text = when('text');
          return first && sharp && text ? { first: Math.round(first), sharp: Math.round(sharp),
            text: Math.round(Math.max(text, sharp)) } : null;
        }, null, { timeout: 120000 });
        const timing = await marks.jsonValue();
        await marks.dispose();
        if (page.url().split('#')[0] !== url) throw new Error(`wrong address: ${page.url()}`);
        if (trial >= 0) {
          const sample = { fixture: doc.name, trial, ...timing };
          samples.push(sample);
          console.log(JSON.stringify(sample));
        }
        await page.goto('about:blank');
      }
    }
    const summary = {};
    for (const fixture of ['all', ...files]) {
      const matching = samples.filter(s => fixture === 'all' || s.fixture === fixture);
      summary[fixture] = {};
      for (const metric of ['first', 'sharp', 'text']) {
        const sorted = matching.map(s => s[metric]).sort((a, b) => a - b);
        summary[fixture][metric] = { n: sorted.length, p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
          p90: sorted[Math.ceil(sorted.length * 0.9) - 1] };
      }
    }
    console.log(JSON.stringify({ load, summary }));
  } finally {
    for (const burner of burners) burner.kill();
    await page.close();
  }
}

async function main() {
  // Real path: macOS's /var is a symlink, and per-entry file rules match the
  // resolved path the daemon stores, not a symlinked spelling of it.
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pdfv-verify-extension-'));
  const cleanup = [];
  const timings = {};
  try {
    for (const [port, host] of [[DAEMON_PORT, '127.0.0.1'], [ORIGIN_PORT, '::1']]) {
      if (!(await portFree(port, host))) throw new Error(`port ${port} on ${host} is already in use`);
    }
    const executablePath = findChromium();
    const extensionDir = path.join(tmp, 'extension');
    copyExtension(extensionDir);

    const originLog = [];
    const origin = await startOrigin(originLog);
    cleanup.push(() => new Promise((r) => origin.close(r)));
    let daemon = await startDaemon(tmp);
    const stopDaemon = async () => {
      try { process.kill(-daemon.child.pid, 'SIGTERM'); } catch (_) {}
      await sleep(300);
      try { process.kill(-daemon.child.pid, 'SIGKILL'); } catch (_) {}
    };
    cleanup.push(() => stopDaemon());
    const daemonLog = () => fs.readFileSync(daemon.logPath, 'utf8');
    const gatedHosts = () => {
      try {
        return JSON.parse(fs.readFileSync(path.join(daemon.cache, '_gated_hosts.json'), 'utf8')).hosts;
      } catch (_) {
        return [];
      }
    };
    console.log(`chromium: ${executablePath}`);
    console.log(`scratch: ${tmp}`);
    console.log(`origin: ${RTT_MS} ms per response, ${MBPS || 'unpaced'} Mbit/s; load ${os.loadavg().map((l) => l.toFixed(1)).join(' ')}`);

    const launched = await launch(path.join(tmp, 'profile'), extensionDir, executablePath);
    const { context } = launched;
    let worker = launched.worker;
    try {
      const cold = process.argv.indexOf('--cold-reader');
      if (cold !== -1) {
        await measureColdReader(context, tmp, process.argv[cold + 1]);
        return;
      }
      if (process.argv.includes('--startup')) {
        const publicOriginPort = ORIGIN_PORT + 1;
        const publicOrigin = await startOrigin(originLog, publicOriginPort);
        cleanup.push(() => new Promise((resolve) => publicOrigin.close(resolve)));
        await measureStartup(context, tmp, `http://[::1]:${publicOriginPort}`);
        return;
      }
      const noRedirects = (await dynamicRules(worker)).every((r) => r.action.type !== 'redirect')
        && JSON.parse(fs.readFileSync(path.join(extensionDir, 'rules.json'), 'utf8'))
          .every((r) => r.action.type !== 'redirect');
      check('the extension redirects nothing: its rules only rewrite headers or allow', noRedirects);

      // ------------------------------------------------------------- open PDF
      const page = await context.newPage();
      async function checkDownload(expected, label) {
        const pending = page.waitForEvent('download', { timeout: 10000 });
        await page.keyboard.press(':');
        await page.locator('#pdf2html-palette-input').fill('download');
        await page.keyboard.press('Enter');
        const downloaded = await pending;
        const file = await downloaded.path();
        check(label, downloaded.suggestedFilename().endsWith('.pdf') && file && fs.readFileSync(file).equals(expected),
          `filename ${downloaded.suggestedFilename()}; failure ${await downloaded.failure()}`);
      }

      const errors = [];
      page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
      page.on('pageerror', (error) => errors.push(String(error)));
      page.on('response', (resp) => { if (resp.status() >= 400) errors.push(`${resp.status()} ${resp.url()}`); });
      let commits = trackCommits(page);
      let started = Date.now();
      const localRequests = [];
      page.on('request', (req) => {
        if (req.frame() === page.mainFrame() && /^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(req.url())) localRequests.push(req.url());
      });
      await gotoLoose(page, `${ORIGIN}/open/doc.pdf`);
      const openHash = await waitFor(() => readerHash(page), 10000);
      const openReady = openHash ? await readerReady(page) : false;
      await sleep(900);
      check('open PDF is read in place with a ready raster and no console errors',
        Boolean(openHash && openReady) && errors.length === 0 && commits.length === 1 && !commits.some(isNative),
        `url ${page.url()}; commits ${JSON.stringify(commits)}; errors ${JSON.stringify(errors)}`);
      check('the address bar keeps the PDF\'s own URL, with the page fragment',
        page.url() === `${ORIGIN}/open/doc.pdf#page=1`, page.url());
      if (process.env.PDFV_VERIFY_SHOT) await page.screenshot({ path: process.env.PDFV_VERIFY_SHOT });
      const shape = await page.evaluate(() => ({
        mode: document.compatMode,
        title: document.title,
        font: getComputedStyle(document.querySelector('#pdf2html-pageno') || document.body).fontFamily,
        fonts: document.fonts.size,
        textLayer: document.querySelectorAll('.pf .t, .pf [data-reader-line], .pf .pc > :not(img)').length,
      }));
      check('the page is a standards-mode document with the reader\'s stylesheet, fonts and text',
        shape.mode === 'CSS1Compat' && /FK Grotesk/.test(shape.font) && shape.fonts > 0 && shape.textLayer > 0,
        JSON.stringify(shape));
      check('the page itself asks the daemon for nothing: every request goes through the extension',
        localRequests.length === 0, JSON.stringify(localRequests.slice(0, 5)));
      check('open PDF is downloaded by the daemon, not through the browser session',
        originHits(originLog, '/open/doc.pdf', started).every((r) => r.mode === '' || r.mode === 'navigate'),
        describe(originLog, started));

      // Another site cannot use the bridge: it has no token for its tab.
      {
        const bridge = `chrome-extension://${new URL(worker.url()).host}/bridge.html`;
        const other = await context.newPage();
        await other.goto(`${ORIGIN}/gated/notes.html`);
        const refused = await other.evaluate((src) => new Promise((resolve) => {
          const frame = document.createElement('iframe');
          frame.src = src;
          frame.onload = () => {
            const channel = new MessageChannel();
            channel.port1.onmessage = (e) => resolve(e.data && e.data.ready ? 'accepted' : 'refused');
            frame.contentWindow.postMessage({ pdfv: 'connect', token: 'f'.repeat(48) }, '*', [channel.port2]);
            setTimeout(() => resolve('silent'), 2500);
          };
          frame.onerror = () => resolve('blocked');
          document.body.appendChild(frame);
        }), bridge);
        check('the bridge refuses a page that did not register through the extension', refused !== 'accepted', refused);
        await other.close();
      }

      // The daemon's own address of a document moves to the document's address.
      await gotoLoose(page, `${VIEWER}/r/${openHash}/`);
      const movedHome = await waitFor(() => page.url().startsWith(`${ORIGIN}/open/doc.pdf#page=`), 8000, 50);
      check('a document opened at the daemon\'s address moves to its own address',
        Boolean(movedHome) && Boolean(await waitFor(() => readerHash(page), 8000)), page.url());

      // A cached document whose host cannot be reached: the stored copy.
      await gotoLoose(page, `${ORIGIN}/open/flaky.pdf`);
      const flakyHash = await waitFor(() => readerHash(page), 10000);
      flaky.down = true;
      await gotoLoose(page, `${ORIGIN}/open/flaky.pdf`);
      const stored = await waitFor(() => page.url().startsWith(`${VIEWER}/r/${flakyHash}/`) && page.url().includes('_pdfvw=local'), 10000, 50);
      check('a cached document whose host is unreachable opens from the stored copy',
        Boolean(flakyHash && stored) && await readerReady(page), page.url());
      await gotoLoose(page, `${VIEWER}/r/${flakyHash}/`);
      const back = await waitFor(() => page.url().includes('_pdfvw=local') && page.url().startsWith(VIEWER), 10000, 50);
      check('and from the daemon\'s address it tries its own, then returns to the stored copy',
        Boolean(back) && await readerReady(page), page.url());
      flaky.down = false;

      commits = trackCommits(page);
      await gotoLoose(page, `${ORIGIN}/open/paper/2401.00001v2`);
      const paperHash = await waitFor(() => readerHash(page), 10000);
      check('a PDF with no .pdf in its URL (content type only) is read in place',
        Boolean(paperHash) && await readerReady(page) && page.url().startsWith(`${ORIGIN}/open/paper/2401.00001v2`),
        `url ${page.url()}; commits ${JSON.stringify(commits)}`);
      commits = trackCommits(page);
      // Playwright rejects the navigation when it turns into a download.
      started = Date.now();
      await page.goto(`${ORIGIN}/open/download/7`, { timeout: 8000 }).catch(() => {});
      await sleep(1500);
      check('a PDF sent as an attachment download is left alone',
        originHits(originLog, '/open/download/7', started).length === 1 && commits.length === 0,
        `url ${page.url()}; commits ${JSON.stringify(commits)}`);

      await gotoLoose(page, `${ORIGIN}/login`);

      // Opens a gated URL and reports what the tab went through.
      async function gatedOpen(pathname) {
        errors.length = 0;
        commits = trackCommits(page);
        started = Date.now();
        await gotoLoose(page, `${ORIGIN}${pathname}`);
        const hash = await waitFor(() => readerHash(page), RELAY_BOUND_MS, 20);
        const ready = hash ? await readerReady(page, 15000, 20) : false;
        // The harness's own poll, 20 ms apart: rasters arrive as blob: URLs,
        // which have no resource timing entry.
        const rasterAt = ready ? Date.now() : null;
        await sleep(300);
        // The tab's own request for the URL is not a fetch of the PDF: the
        // page script stops it once the headers are in.
        const hits = originHits(originLog, pathname, started).filter((r) => r.mode !== 'navigate');
        return {
          hash,
          ready,
          ms: rasterAt ? Math.round(rasterAt - started) : null,
          native: commits.some(isNative),
          hits,
          commits: [...commits],
          detail: `first raster ${rasterAt ? Math.round(rasterAt - started) : '?'} ms after navigation start; `
            + `${errors.length ? `console errors ${JSON.stringify(errors)}; ` : ''}`
            + `commits ${JSON.stringify(commits.map((u, i) => `${commits.times[i] - started} ${u}`))}; `
            + `origin ${describe(originLog, started)}`,
        };
      }
      const sourceOf = (hash) => {
        const dir = hash && path.join(daemon.cache, hash, '_source');
        return dir && fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.pdf')) : [];
      };
      const host = new URL(ORIGIN).host;

      // ----------------------------------------------- gated, host not yet known
      const first = await gatedOpen('/gated/first.pdf');
      timings.gatedNewHost = first.ms;
      check('gated first open on a new host is read in place, never the browser viewer',
        Boolean(first.hash && first.ready) && !first.native && first.commits.length === 1
          && sourceOf(first.hash).includes('Gated Notes.pdf') && errors.length === 0,
        first.detail);
      check('its bytes came from the browser session (the extension fetch sent the cookie)',
        first.hits.some((r) => r.signedIn && r.mode === 'cors'),
        JSON.stringify(first.hits));
      check('the daemon remembers that the host needs the session', gatedHosts().includes(host),
        JSON.stringify(gatedHosts()));

      // ------------------------------------------------ gated, host known
      const known = await gatedOpen('/gated/doc.pdf');
      timings.gatedKnownHost = known.ms;
      check(`gated first open on a known host: reader within ${TARGET_MS} ms, no browser viewer, `
        + 'no cookie-less try',
        Boolean(known.hash && known.ready) && !known.native && known.ms !== null && known.ms < TARGET_MS
          && known.hits.every((r) => r.signedIn) && known.hits.length === 1,
        known.detail);

      await checkDownload(GATED_PDF, ':download saves the exact signed-in PDF bytes');

      // ------------------------------------------------------------- reopen
      const reopen = await gatedOpen('/gated/doc.pdf');
      timings.gatedReopen = reopen.ms;
      check('gated reopen conditionally revalidates through the browser session (304)',
        reopen.hash === known.hash && reopen.ready && !reopen.native && reopen.hits.length >= 1 && reopen.hits.every((r) => r.signedIn) && reopen.hits.some((r) => r.conditional === '"gated-v1"' && r.mode === 'cors'),
        reopen.detail);

      // ------------------------------------------------ suspended worker
      // MV3 stops an idle service worker after about 30 s. The tab's own
      // request must wake it in time to claim the open.
      {
        const cdp = await context.newCDPSession(page);
        const extensionWorker = async () => (await cdp.send('Target.getTargets')).targetInfos
          .find((t) => t.type === 'service_worker' && t.url.startsWith('chrome-extension://'));
        const sw = await extensionWorker();
        const stopped = sw && await cdp.send('Target.closeTarget', { targetId: sw.targetId }).then(() => true, () => false);
        const gone = stopped && await waitFor(async () => !(await extensionWorker()), 3000, 20);
        if (!gone) {
          await cdp.detach();
          skip('a suspended service worker wakes for a gated open', 'could not stop the worker through CDP');
        } else {
          const woken = await gatedOpen('/gated/woken.pdf');
          timings.gatedWokenWorker = woken.ms;
          await cdp.detach();
          worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
          check('a suspended service worker wakes for a gated open and claims it',
            Boolean(woken.hash && woken.ready) && !woken.native && woken.hits.every((r) => r.signedIn),
            woken.detail);
        }
      }

      // ------------------------------------------------- slow: holding page
      const slow = await gatedOpen('/gated/slow.pdf');
      timings.gatedSlow = slow.ms;
      check('a transfer longer than the hold still ends in the reader, in the same document',
        Boolean(slow.hash && slow.ready) && !slow.native && slow.commits.length === 1,
        slow.detail);
      // Ten pages: the address follows the page being read.
      await page.evaluate(() => { document.getElementById('pf4').scrollIntoView({ behavior: 'instant', block: 'start' }); });
      const followed = await waitFor(() => /#page=4$/.test(page.url()), 5000, 50);
      check('the address\'s page fragment follows the page being read', Boolean(followed), page.url());
      commits = trackCommits(page);
      await gotoLoose(page, `${ORIGIN}/gated/slow.pdf#page=7`);
      await page.reload().catch(() => {});
      await waitFor(() => readerHash(page), 10000);
      const landedOn = await waitFor(() => page.evaluate(() => {
        const root = document.getElementById('page-container'), pf = document.getElementById('pf7');
        return root && pf && Math.abs(pf.getBoundingClientRect().top - root.getBoundingClientRect().top) < 80;
      }).catch(() => false), 8000, 100);
      check('an address with #page=7 opens on that page', Boolean(landedOn), page.url());

      if (BIG_PDF) {
        const big = await gatedOpen('/gated/big.pdf');
        timings.gatedBig = big.ms;
        const stored = sourceOf(big.hash).length
          && fs.statSync(path.join(daemon.cache, big.hash, '_source', sourceOf(big.hash)[0])).size;
        check(`a ${BIG_MB} MB gated PDF goes through the extension's upload intact`,
          Boolean(big.hash && big.ready) && stored === BIG_PDF.length, `${stored} bytes stored; ${big.detail}`);
      }

      // --------------------------------------------------- HTML, not a PDF
      {
        const before = entryDirs(daemon.cache).length;
        commits = trackCommits(page);
        started = Date.now();
        await gotoLoose(page, `${ORIGIN}/gated/html.pdf`);
        const landed = await waitFor(() => page.url().startsWith(`${ORIGIN}/gated/html.pdf`), 10000, 50);
        await sleep(500);
        const text = await page.evaluate(() => document.body.innerText).catch(() => '');
        check('a gated URL that answers HTML ends on the site\'s own page, nothing stored',
          Boolean(landed) && /not available/.test(text) && entryDirs(daemon.cache).length === before
            && commits.length === 1 && !(await readerHash(page)),
          `url ${page.url()}; commits ${JSON.stringify(commits)}; origin ${describe(originLog, started)}`);
      }

      // ------------------------------------------- non-PDF page on that host
      {
        commits = trackCommits(page);
        started = Date.now();
        await gotoLoose(page, `${ORIGIN}/gated/notes.html`);
        await sleep(500);
        check('an HTML page on the gated host is untouched',
          page.url() === `${ORIGIN}/gated/notes.html` && commits.length === 1
            && originHits(originLog, '/gated/notes.html', started).length === 1,
          `url ${page.url()}; commits ${JSON.stringify(commits)}`);
      }

      // ---------------------------------------------------- expired session
      {
        await gotoLoose(page, `${ORIGIN}/logout`);
        const before = entryDirs(daemon.cache).length;
        commits = trackCommits(page);
        started = Date.now();
        await gotoLoose(page, `${ORIGIN}/gated/expired.pdf`);
        const landed = await waitFor(() => page.url().startsWith(`${ORIGIN}/sso`), 10000, 50);
        await sleep(1000);
        const text = await page.evaluate(() => document.body.innerText).catch(() => '');
        check('expired session: the tab ends on the site\'s sign-in page, no loop, nothing stored',
          Boolean(landed) && /Sign in/.test(text) && entryDirs(daemon.cache).length === before
            && commits.length === 1 && originHits(originLog, '/gated/expired.pdf', started).length <= 3,
          `url ${page.url()}; commits ${JSON.stringify(commits)}; origin ${describe(originLog, started)}`);
      }

      // A cached rewrite must not override the passthrough allow rule.
      await waitFor(async () => (await dynamicRules(worker))
        .some(r => (r.condition.regexFilter || '').includes('open/doc')), 10000);
      // API requests are not main_frame: use a navigation to exercise DNR.
      let bypassType = '';
      page.once('response', r => { bypassType = r.headers()['content-type'] || ''; });
      await gotoLoose(page, `${ORIGIN}/open/doc.pdf?_pdfvw=passthrough`);
      await sleep(1000);
      check('cached passthrough preserves PDF content type',
        bypassType.includes('application/pdf'), bypassType);

      // --------------------------------------------------------- disabled entry
      const disabled = await fetch(`${DAEMON}/entry/${openHash}/disabled`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ disabled: true }),
      });
      const allowRule = await waitFor(async () => (await dynamicRules(worker))
        .some((r) => r.action.type === 'allow' && r.priority === 4
          && (r.condition.regexFilter || '').includes('open/doc')), 10000);
      commits = trackCommits(page);
      await gotoLoose(page, `${ORIGIN}/open/doc.pdf`);
      await sleep(3000);
      check('disabled entry stays in the native viewer',
        disabled.ok && Boolean(allowRule) && page.url().startsWith(`${ORIGIN}/open/doc.pdf`)
          && !(await readerHash(page)),
        `allow rule ${Boolean(allowRule)}; url ${page.url()}`);
      await fetch(`${DAEMON}/entry/${openHash}/disabled`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ disabled: false }),
      });

      // ----------------------------------------------------------- file:// PDF
      const fileAccess = await worker.evaluate(() => chrome.extension.isAllowedFileSchemeAccess());
      if (!fileAccess) {
        skip('file:// PDF opens the reader',
          'Chromium has not granted this unpacked extension file access ("Allow access to file URLs" is off)');
      } else {
        const local = path.join(tmp, 'files', 'Local Notes ø.pdf');
        fs.mkdirSync(path.dirname(local));
        fs.copyFileSync(path.join(REPO, 'test/fixtures/basic_text.pdf'), local);
        const fileUrl = require('url').pathToFileURL(local).href;
        await gotoLoose(page, fileUrl);
        let fileHash = await waitFor(() => readerHash(page), 10000);
        const fileReady = fileHash ? await readerReady(page) : false;
        check('file:// PDF is read in place at its file address',
          Boolean(fileReady) && page.url() === `${fileUrl}#page=1`, `${fileUrl} → ${page.url()}`);

        await checkDownload(PDF, ':download saves the exact local PDF bytes');

        const localRequests = [];
        const trackLocal = (request) => {
          if (request.url().includes('/local-file/')) localRequests.push(request.url());
        };
        context.on('request', trackLocal);
        const beforeStat = fs.statSync(local);
        const replacement = local + '.replacement';
        fs.writeFileSync(replacement, GATED_PDF);
        fs.utimesSync(replacement, beforeStat.atime, beforeStat.mtime);
        fs.renameSync(replacement, local);
        const changedHash = await waitFor(async () => {
          const current = await readerHash(page);
          return current && current !== fileHash ? current : null;
        }, 10000, 100);
        check('an open file:// reader shows new pages after atomic replacement preserving modification time',
          Boolean(changedHash) && await readerReady(page) && page.url().startsWith(fileUrl) && await page.locator('.pf').count() === 10,
          `old ${fileHash}; new ${changedHash}; checks ${JSON.stringify(localRequests)}`);
        context.off('request', trackLocal);
        await gotoLoose(page, fileUrl);
        const refreshedHash = await waitFor(async () => {
          const current = await readerHash(page);
          return current && current !== fileHash ? current : null;
        }, 10000, 100);
        check('reopening file:// uses the changed local revision', Boolean(refreshedHash) && await readerReady(page),
          `old ${fileHash}; new ${refreshedHash}`);
        fileHash = refreshedHash || fileHash;

        // No rule can apply to a local file: the page script asks the daemon
        // and hands a disabled one to the browser's viewer.
        const off = fileHash && await fetch(`${DAEMON}/entry/${fileHash}/disabled`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ disabled: true }),
        });
        await gotoLoose(page, fileUrl);
        const nativeFile = await waitFor(() => isNative(page.url()), 8000, 50);
        await sleep(500);
        check('disabled local file ends in the native viewer',
          Boolean(off && off.ok && nativeFile) && page.url().startsWith(fileUrl) && !(await readerHash(page)),
          `url ${page.url()}`);
      }

      // ----------------------------------------------------------- daemon down
      {
        await gotoLoose(page, `${ORIGIN}/login`);
        await stopDaemon();
        // At once, before the worker's poll has noticed: the tab is put back.
        commits = trackCommits(page);
        await gotoLoose(page, `${ORIGIN}/open/doc.pdf`);
        const back = await waitFor(() => page.url().startsWith(`${ORIGIN}/open/doc.pdf`), 10000, 50);
        await sleep(500);
        check('daemon down: an open PDF ends in the browser viewer at its own URL, not an error page',
          Boolean(back) && page.url().startsWith(`${ORIGIN}/open/doc.pdf`),
          `url ${page.url()}; commits ${JSON.stringify(commits)}`);
        // Now the worker knows: no error page in between at all.
        commits = trackCommits(page);
        await gotoLoose(page, `${ORIGIN}/gated/new.pdf`);
        await sleep(1500);
        check('daemon down: a gated PDF opens natively with no error page in between',
          page.url().startsWith(`${ORIGIN}/gated/new.pdf`) && commits.length === 1
            && !commits.some((u) => u.startsWith('chrome-error:')),
          `url ${page.url()}; commits ${JSON.stringify(commits)}`);

        daemon = await startDaemon(tmp);
        const recovered = await waitFor(async () => {
          const rules = await worker.evaluate(() => chrome.declarativeNetRequest.getSessionRules());
          return rules.length === 0;
        }, 15000, 200);
        commits = trackCommits(page);
        await gotoLoose(page, `${ORIGIN}/gated/doc.pdf`);
        const resumed = await waitFor(() => readerHash(page), 10000);
        check('daemon back: PDFs are read in place again', Boolean(recovered && resumed),
          `url ${page.url()}; commits ${JSON.stringify(commits)}`);
      }
    } finally {
      await context.close();
    }
  } catch (error) {
    check('harness', false, error.stack || String(error));
  } finally {
    for (const step of cleanup.reverse()) {
      try { await step(); } catch (_) {}
    }
    if (process.env.PDFV_VERIFY_KEEP) console.log(`kept ${tmp}`);
    else fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`timings (ms, navigation start → first raster): ${JSON.stringify(timings)}; `
    + `load ${os.loadavg().map((l) => l.toFixed(1)).join(' ')}`);
  const failed = results.filter((ok) => !ok).length;
  console.log(failed ? `FAIL ${failed} of ${results.length} checks` : `PASS all ${results.length} checks`);
  process.exit(failed ? 1 : 0);
}

main();

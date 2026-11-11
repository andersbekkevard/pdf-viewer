#!/usr/bin/env node
/*
 * verify-extension.cjs — end-to-end check that every PDF the browser opens
 * lands in the reader: the unpacked extension, a scratch reader-mode daemon
 * and a local web origin, driven through headless Chromium for Testing.
 *
 * Self-contained: a temp copy of extension/ points at the scratch daemon
 * (port 7450), which uses a temp cache and state db; the origin listens on
 * [::1]:7451, because the extension's static rule excludes localhost and
 * 127.0.0.1. Nothing touches ~/.cache/pdf_viewer or the daemons on 7435–7437.
 *
 * Usage: scripts/verify-extension.sh
 *   PDFV_CHROMIUM=<binary>   browser to drive
 *   PDFV_VERIFY_PORT=<port>  scratch daemon port (origin: port + 1000)
 *   PDFV_VERIFY_RTT_MS, PDFV_VERIFY_MBPS   origin network shape (60, 100)
 *   PDFV_VERIFY_TARGET_MS    bound on a known-host gated open (1000)
 *   PDFV_VERIFY_DEBUG=1      print the service worker's console
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
  fs.cpSync(path.join(REPO, 'extension'), dir, {
    recursive: true,
    filter: (src) => !src.includes(`${path.sep}_metadata`),
  });
  for (const [file, count] of [['background.js', 2], ['rules.json', 2]]) {
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
function startOrigin(log) {
  const server = http.createServer((req, res) => {
    const signedIn = /(?:^|;\s*)session=ok(?:;|$)/.test(req.headers.cookie || '');
    const url = new URL(req.url, ORIGIN);
    if (url.pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    log.push({ t: Date.now(), path: url.pathname, signedIn, mode: req.headers['sec-fetch-mode'] || '' });
    setTimeout(() => {
      if (url.pathname === '/open/paper/2401.00001v2') {
        // A PDF whose URL does not say so (arXiv-style): only the type does.
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': PDF.length });
        sendPaced(res, PDF);
      } else if (url.pathname === '/open/download/7') {
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': PDF.length,
          'Content-Disposition': 'attachment; filename="export.pdf"' });
        sendPaced(res, PDF);
      } else if (url.pathname === '/open/doc.pdf') {
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
    server.listen(ORIGIN_PORT, '::1', () => resolve(server));
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
// detour through the native viewer.
function trackCommits(page) {
  const commits = [];
  commits.times = [];
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) { commits.push(frame.url()); commits.times.push(Date.now()); }
  });
  return commits;
}

const READER_RE = new RegExp(`^${VIEWER.replace(/[.]/g, '\\.')}/r/([a-f0-9]{16})/`);
const isReader = (url) => READER_RE.test(url);
const hashOf = (url) => (url.match(READER_RE) || [])[1];

async function gotoLoose(page, url) {
  // A navigation the extension redirects, or that a navigate signal replaces
  // a moment later, can abort Playwright's own wait; the URL checks follow.
  try {
    await page.goto(url, { waitUntil: 'commit', timeout: 15000 });
  } catch (error) {
    // A dead daemon's refused connection is what the daemon-down checks
    // provoke; the extension puts the tab back afterwards.
    if (!/ERR_ABORTED|ERR_CONNECTION_REFUSED|interrupted|frame was detached/i.test(error.message)) throw error;
  }
}

async function readerReady(page) {
  return waitFor(() => page.evaluate(() => {
    const pages = document.querySelectorAll('.pf');
    const img = document.querySelector('.pf img.bi');
    return pages.length > 0 && img && img.complete && img.naturalWidth > 0;
  }).catch(() => false), 15000, 200);
}

// Epoch ms at which the reader's first page raster finished loading, from
// the page's own resource timing (independent of the harness's polling).
async function firstRasterAt(page) {
  return page.evaluate(() => {
    const img = document.querySelector('.pf img.bi');
    if (!img || !img.complete || !img.naturalWidth) return null;
    const entry = performance.getEntriesByType('resource')
      .find((e) => /\/p\/1\/\d+\.(png|jpg)$/.test(e.name));
    return entry ? performance.timeOrigin + entry.responseEnd : null;
  }).catch(() => null);
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
      const fileRuleReady = await waitFor(async () => (await dynamicRules(worker))
        .some((r) => r.condition.regexFilter && r.condition.regexFilter.startsWith('^file://')), 10000);
      check('extension installs the generic file:// rule in reader mode', Boolean(fileRuleReady));

      // ------------------------------------------------------------- open PDF
      const page = await context.newPage();
      const errors = [];
      page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
      page.on('pageerror', (error) => errors.push(String(error)));
      page.on('response', (resp) => { if (resp.status() >= 400) errors.push(`${resp.status()} ${resp.url()}`); });
      let commits = trackCommits(page);
      let started = Date.now();
      await gotoLoose(page, `${ORIGIN}/open/doc.pdf`);
      await waitFor(() => isReader(page.url()), 10000);
      const openHash = hashOf(page.url());
      const openReady = openHash ? await readerReady(page) : false;
      await sleep(500);
      check('open PDF lands in the reader with a ready raster and no console errors',
        Boolean(openHash && openReady) && errors.length === 0
          && !commits.some((u) => u.includes('_pdfvw=passthrough')),
        `url ${page.url()}; errors ${JSON.stringify(errors)}`);
      check('open PDF is downloaded by the daemon, not through the browser session',
        originHits(originLog, '/open/doc.pdf', started).every((r) => r.mode === ''),
        describe(originLog, started));

      commits = trackCommits(page);
      await gotoLoose(page, `${ORIGIN}/open/paper/2401.00001v2`);
      await waitFor(() => isReader(page.url()), 10000);
      check('a PDF with no .pdf in its URL (content type only) lands in the reader',
        isReader(page.url()) && await readerReady(page),
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
        await waitFor(() => isReader(page.url()), RELAY_BOUND_MS, 20);
        const hash = hashOf(page.url());
        const ready = hash ? await readerReady(page) : false;
        const rasterAt = ready ? await firstRasterAt(page) : null;
        await sleep(300);
        const hits = originHits(originLog, pathname, started);
        return {
          hash,
          ready,
          ms: rasterAt ? Math.round(rasterAt - started) : null,
          native: commits.some((u) => u.startsWith(ORIGIN)) || hits.some((r) => r.mode === 'navigate'),
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
      check('gated first open on a new host goes straight to the reader, never the browser viewer',
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

      // ------------------------------------------------------------- reopen
      const reopen = await gatedOpen('/gated/doc.pdf');
      timings.gatedReopen = reopen.ms;
      check('gated reopen is served from the stored source without touching the host',
        reopen.hash === known.hash && reopen.ready && !reopen.native && reopen.hits.length === 0,
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
      check('a transfer longer than the hold shows the holding page, then the reader in the same tab',
        Boolean(slow.hash && slow.ready) && !slow.native && slow.commits.length === 2
          && /\/view-raw\?/.test(slow.commits[0]) && isReader(slow.commits[1]),
        slow.detail);

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
            && commits.length === 1 && !commits.some(isReader),
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
          && !commits.some(isReader),
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
        await waitFor(() => isReader(page.url()), 10000);
        const fileReady = isReader(page.url()) ? await readerReady(page) : false;
        check('file:// PDF opens the reader', Boolean(fileReady), `${fileUrl} → ${page.url()}`);

        // The per-entry allow rule (p4) of a disabled local file must beat
        // the generic file rule (p1).
        const fileHash = hashOf(page.url());
        const off = fileHash && await fetch(`${DAEMON}/entry/${fileHash}/disabled`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ disabled: true }),
        });
        const fileAllow = await waitFor(async () => (await dynamicRules(worker))
          .some((r) => r.action.type === 'allow' && r.priority === 4
            && (r.condition.urlFilter || '').startsWith('|file://')), 10000);
        commits = trackCommits(page);
        await gotoLoose(page, fileUrl);
        await sleep(2000);
        check('disabled local file stays in the native viewer despite the generic rule',
          Boolean(off && off.ok && fileAllow) && page.url() === fileUrl && !commits.some(isReader),
          `allow rule ${Boolean(fileAllow)}; url ${page.url()}`);
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
        await waitFor(() => isReader(page.url()), 10000);
        check('daemon back: redirects resume', Boolean(recovered) && isReader(page.url()),
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

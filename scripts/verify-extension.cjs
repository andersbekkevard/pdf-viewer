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
 * Usage: scripts/verify-extension.sh   (PDFV_CHROMIUM=<binary> to override)
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
const DAEMON_PORT = 7450;
const ORIGIN_PORT = 7451;
const DAEMON = `http://127.0.0.1:${DAEMON_PORT}`;
const VIEWER = `http://localhost:${DAEMON_PORT}`;
const ORIGIN = `http://[::1]:${ORIGIN_PORT}`;
const PDF = fs.readFileSync(path.join(REPO, 'test/fixtures/basic_text.pdf'));
// The daemon's relay gives up after about 20 s of silence; allow a margin.
const RELAY_BOUND_MS = 25000;

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
  for (const [file, count] of [['background.js', 2], ['rules.json', 1]]) {
    const target = path.join(dir, file);
    const text = fs.readFileSync(target, 'utf8');
    const patched = text.replace(/(127\.0\.0\.1|localhost):7435/g, `$1:${DAEMON_PORT}`);
    const replaced = (text.match(/(127\.0\.0\.1|localhost):7435/g) || []).length;
    if (replaced !== count) throw new Error(`${file}: expected ${count} daemon origins, found ${replaced}`);
    fs.writeFileSync(target, patched);
  }
}

// The web origin: an open PDF, a PDF behind a session cookie that otherwise
// answers 200 with a sign-in page, and the login that sets the cookie.
function startOrigin(log) {
  const server = http.createServer((req, res) => {
    const signedIn = /(?:^|;\s*)session=ok(?:;|$)/.test(req.headers.cookie || '');
    const url = new URL(req.url, ORIGIN);
    log.push({ path: url.pathname, signedIn, mode: req.headers['sec-fetch-mode'] || '' });
    if (url.pathname === '/open/doc.pdf') {
      res.writeHead(200, { 'Content-Type': 'application/pdf' });
      res.end(PDF);
    } else if (url.pathname === '/gated/doc.pdf' && signedIn) {
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'inline; filename="Gated Notes.pdf"',
      });
      res.end(PDF);
    } else if (url.pathname === '/gated/doc.pdf') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><title>Sign in</title><form>Sign in to continue</form>');
    } else if (url.pathname === '/login') {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'session=ok; Path=/; HttpOnly' });
      res.end('<!doctype html><title>Signed in</title>signed in');
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(ORIGIN_PORT, '::1', () => resolve(server));
  });
}

async function startDaemon(tmp) {
  const cache = path.join(tmp, 'cache');
  fs.mkdirSync(cache);
  const logPath = path.join(tmp, 'daemon.log');
  const out = fs.openSync(logPath, 'a');
  const child = spawn('uv', ['run', '--directory', path.join(REPO, 'daemon'), 'uvicorn', 'main:app',
    '--host', '127.0.0.1', '--port', String(DAEMON_PORT), '--log-level', 'warning'], {
    env: {
      ...process.env,
      PDF_VIEWER_ENGINE: 'reader',
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
  return { context, worker };
}

function dynamicRules(worker) {
  return worker.evaluate(() => chrome.declarativeNetRequest.getDynamicRules());
}

// Commits of the main frame, so a check can tell a direct reader open from a
// detour through the native viewer.
function trackCommits(page) {
  const commits = [];
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) commits.push(frame.url());
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
    if (!/ERR_ABORTED|interrupted|frame was detached/i.test(error.message)) throw error;
  }
}

async function readerReady(page) {
  return waitFor(() => page.evaluate(() => {
    const pages = document.querySelectorAll('.pf');
    const img = document.querySelector('.pf img.bi');
    return pages.length > 0 && img && img.complete && img.naturalWidth > 0;
  }).catch(() => false), 15000, 200);
}

function entryDirs(cache) {
  return fs.readdirSync(cache).filter((name) => /^[a-f0-9]{6,32}$/.test(name));
}

async function main() {
  // Real path: macOS's /var is a symlink, and per-entry file rules match the
  // resolved path the daemon stores, not a symlinked spelling of it.
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pdfv-verify-extension-'));
  const cleanup = [];
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
    const daemon = await startDaemon(tmp);
    cleanup.push(async () => {
      try { process.kill(-daemon.child.pid, 'SIGTERM'); } catch (_) {}
      await sleep(300);
      try { process.kill(-daemon.child.pid, 'SIGKILL'); } catch (_) {}
    });
    const daemonLog = () => fs.readFileSync(daemon.logPath, 'utf8');
    console.log(`chromium: ${executablePath}`);
    console.log(`scratch: ${tmp}`);

    // ---------------------------------------------------------------- signed out
    // A fresh profile without the session cookie: the extension's fetch gets
    // the sign-in page, so the tab stays native and nothing is stored.
    {
      const { context } = await launch(path.join(tmp, 'profile-signed-out'), extensionDir, executablePath);
      try {
        const page = await context.newPage();
        await gotoLoose(page, `${ORIGIN}/gated/doc.pdf`);
        const native = await waitFor(() => page.url().includes('_pdfvw=passthrough'), 10000);
        const answered = await waitFor(() => /reader relay: extension could not fetch/.test(daemonLog()), RELAY_BOUND_MS);
        await sleep(1000);
        const stored = entryDirs(daemon.cache);
        check('signed out: gated PDF stays in the native viewer and nothing is stored',
          Boolean(native && answered) && page.url().includes('_pdfvw=passthrough') && stored.length === 0,
          `url ${page.url()}, relay answered ${Boolean(answered)}, cache entries [${stored.join(', ')}]`);
      } finally {
        await context.close();
      }
    }

    const { context, worker: firstWorker } = await launch(path.join(tmp, 'profile'), extensionDir, executablePath);
    let worker = firstWorker;
    try {
      const fileRuleReady = await waitFor(async () => (await dynamicRules(worker))
        .some((r) => r.condition.regexFilter && r.condition.regexFilter.startsWith('^file://')), 10000);
      check('extension installs the generic file:// rule in reader mode', Boolean(fileRuleReady));

      // ------------------------------------------------------------- open PDF
      const page = await context.newPage();
      const errors = [];
      page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
      page.on('pageerror', (error) => errors.push(String(error)));
      let commits = trackCommits(page);
      await gotoLoose(page, `${ORIGIN}/open/doc.pdf`);
      await waitFor(() => isReader(page.url()), 10000);
      const openHash = hashOf(page.url());
      const openReady = openHash ? await readerReady(page) : false;
      await sleep(500);
      check('open PDF lands in the reader with a ready raster and no console errors',
        Boolean(openHash && openReady) && errors.length === 0
          && !commits.some((u) => u.includes('_pdfvw=passthrough')),
        `url ${page.url()}; errors ${JSON.stringify(errors)}`);

      // ------------------------------------------------------------ gated PDF
      await gotoLoose(page, `${ORIGIN}/login`);
      errors.length = 0;
      commits = trackCommits(page);
      const started = Date.now();
      await gotoLoose(page, `${ORIGIN}/gated/doc.pdf`);
      const wentNative = await waitFor(
        () => commits.some((u) => u.startsWith(`${ORIGIN}/gated/doc.pdf`) && u.includes('_pdfvw=passthrough')), 10000, 20);
      const swapped = await waitFor(() => isReader(page.url()), RELAY_BOUND_MS);
      const gatedHash = hashOf(page.url());
      const gatedReady = gatedHash ? await readerReady(page) : false;
      const stored = gatedHash ? path.join(daemon.cache, gatedHash, '_source', 'Gated Notes.pdf') : '';
      check('signed in: gated PDF shows natively, then the same tab swaps to the reader',
        Boolean(wentNative && swapped && gatedReady) && fs.existsSync(stored),
        `${Date.now() - started} ms; commits ${JSON.stringify(commits)}; source ${stored ? path.basename(stored) : 'none'}`);
      check('relayed source came from the browser session (cookie sent by the extension fetch)',
        originLog.some((r) => r.path === '/gated/doc.pdf' && r.signedIn && r.mode !== 'navigate'),
        JSON.stringify(originLog.filter((r) => r.path === '/gated/doc.pdf')));

      commits = trackCommits(page);
      await gotoLoose(page, `${ORIGIN}/gated/doc.pdf`);
      await waitFor(() => isReader(page.url()), 10000);
      check('second visit to the gated PDF opens the reader directly',
        hashOf(page.url()) === gatedHash && !commits.some((u) => u.includes('_pdfvw=passthrough')),
        `commits ${JSON.stringify(commits)}`);

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
    } finally {
      await context.close();
    }
  } catch (error) {
    check('harness', false, error.stack || String(error));
  } finally {
    for (const step of cleanup.reverse()) {
      try { await step(); } catch (_) {}
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const failed = results.filter((ok) => !ok).length;
  console.log(failed ? `FAIL ${failed} of ${results.length} checks` : `PASS all ${results.length} checks`);
  process.exit(failed ? 1 : 0);
}

main();

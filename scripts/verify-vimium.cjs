#!/usr/bin/env node
/*
 * verify-vimium.cjs — the viewer under the real Vimium extension.
 *
 * Loads an unpacked copy of the locally installed Vimium (read-only copy of
 * the Chrome profile's extension directory, into a temp dir) and a patched
 * copy of the repo's extension into headless Chromium for Testing, against a
 * scratch reader-mode daemon on the first free port in 7470–7479 with a temp
 * cache and state db. Keys are trusted CDP key events (Playwright keyboard),
 * so they go through Vimium's own window-capture handlers exactly as typed
 * keys do. Nothing touches ~/.cache/pdf_viewer, ports 7435–7437 or a real
 * browser profile.
 *
 * Vimium is configured as docs/keybindings.md "Vimium setup" says: one
 * exclusion rule for the daemon origin passing through
 * `? s / n N h l e q E c C 0 1 2 3 4 5 6 7 8 9` (no `<c-f>`), written to
 * chrome.storage.sync `exclusionRules` through Vimium's service worker.
 * A rule that does contain `<c-f>` is checked as a string only: Vimium
 * would then pass plain `f` to the page.
 *
 * Documents are generated at run time (reportlab via uv): a 14-page PDF with
 * an outline, an internal link, an external link and URL/DOI text. The reader
 * opens it through /read?path=.
 *
 * Usage: scripts/verify-vimium.sh
 *   PDFV_CHROMIUM=<binary>  Chromium for Testing to use
 *   PDFV_VIMIUM_DIR=<dir>   unpacked Vimium to copy (default: newest version
 *                           in the Chrome Default profile)
 *   PDFV_HEADED=1           show the browser window
 */
'use strict';

const { chromium } = require('playwright');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const VIMIUM_ID = 'dbepggeogbaibhgnhhndojpepiihcmeb';
// docs/keybindings.md, "Vimium setup", verbatim.
const DOC_PASS_KEYS = '? s / n N h l e q E c C 0 1 2 3 4 5 6 7 8 9';
const VIEWPORT = { width: 1280, height: 900 };
const PAGE_LEAD = 8;
const STEP = 60; // Vimium's default scrollStepSize
const TOL = 1.5;
const HARNESS_TIMEOUT_MS = 6 * 60 * 1000;

const results = [];
let section = '';
function check(name, ok, detail = '') {
  const label = section ? `[${section}] ${name}` : name;
  results.push({ name: label, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
}
function note(text) { console.log(`NOTE ${section ? `[${section}] ` : ''}${text}`); }
function skip(name, why) { console.log(`SKIP ${section ? `[${section}] ` : ''}${name} — ${why}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b, tol = TOL) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= tol;
const fmt = (n) => (typeof n === 'number' ? (Math.round(n * 10) / 10).toString() : String(n));

async function waitFor(fn, timeoutMs, stepMs = 100) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await sleep(stepMs);
  }
  return null;
}

// ----------------------------------------------------------------- environment

function findChromium() {
  if (process.env.PDFV_CHROMIUM) return process.env.PDFV_CHROMIUM;
  // Chromium for Testing still honours --load-extension; branded Chrome no
  // longer does, and the headless shell cannot run extensions.
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

function findVimium() {
  if (process.env.PDFV_VIMIUM_DIR) return process.env.PDFV_VIMIUM_DIR;
  const base = path.join(os.homedir(), 'Library/Application Support/Google/Chrome/Default/Extensions', VIMIUM_ID);
  if (!fs.existsSync(base)) throw new Error(`Vimium not installed in the Chrome Default profile (${base}); set PDFV_VIMIUM_DIR`);
  const versions = fs.readdirSync(base).filter((d) => fs.existsSync(path.join(base, d, 'manifest.json')))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!versions.length) throw new Error(`no Vimium version under ${base}`);
  return path.join(base, versions[versions.length - 1]);
}

// Chromium refuses unpacked extensions with reserved `_` entries such as the
// Web Store's _metadata; the copy leaves the profile's directory untouched.
function copyVimium(src, dst) {
  fs.cpSync(src, dst, { recursive: true, filter: (p) => !p.split(path.sep).includes('_metadata') });
  return JSON.parse(fs.readFileSync(path.join(dst, 'manifest.json'), 'utf8')).version;
}

function copyExtension(dir, port) {
  fs.cpSync(path.join(REPO, 'extension'), dir, {
    recursive: true,
    filter: (src) => !src.includes(`${path.sep}_metadata`),
  });
  for (const [file, count] of [['background.js', 2], ['rules.json', 2]]) {
    const target = path.join(dir, file);
    const text = fs.readFileSync(target, 'utf8');
    const replaced = (text.match(/(127\.0\.0\.1|localhost):7435/g) || []).length;
    if (replaced !== count) throw new Error(`${file}: expected ${count} daemon origins, found ${replaced}`);
    fs.writeFileSync(target, text.replace(/(127\.0\.0\.1|localhost):7435/g, `$1:${port}`));
  }
}

function portFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => resolve(true));
  });
}
async function pickPort() {
  if (process.env.PDFV_PORT) {
    const port=Number(process.env.PDFV_PORT);
    if (!Number.isInteger(port) || port < 1024 || port > 65535 || !(await portFree(port)))
      throw new Error('requested PDFV_PORT is invalid or occupied');
    return port;
  }
  for (let port = 7470; port <= 7479; port++) {
    if (await portFree(port) && await portFree(port, '::1')) return port;
  }
  throw new Error('no free port in 7470–7479');
}

// What Vimium 2.x does with a rule's passKeys (background_scripts/
// exclusions.js getRule + Utils.distinctCharacters): whitespace removed, then
// the distinct characters, sorted. A key is passed when this string
// `includes` Vimium's key name for it (KeyboardUtils.getKeyCharString).
function vimiumPassKeyString(passKeys) {
  return Array.from(new Set(passKeys.split(/\s+/).join('').split(''))).sort().join('');
}
// Vimium's exclusion pattern match: "^" + pattern with * → .* + "$".
function vimiumPatternMatches(pattern, url) {
  return url.search(new RegExp('^' + pattern.replace(/\*/g, '.*') + '$')) >= 0;
}

const GENERATOR = String.raw`
import sys
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

out, title = sys.argv[1], sys.argv[2]
W, H = A4
WORDS = ("reading documents with the keyboard should feel ordinary and quiet while every page "
         "keeps its layout and its text remains selectable searchable and copyable across lines "
         "chapters figures footnotes tables margins and references").split()
CHAPTERS = {1: "Introduction", 4: "Methods", 8: "Results", 12: "Discussion"}
c = canvas.Canvas(out, pagesize=A4)
c.setTitle(title)
number = 0
for n in range(1, 15):
    key = "p%d" % n
    c.bookmarkPage(key, fit="XYZ", top=H - 60)
    if n in CHAPTERS:
        number += 1
        c.addOutlineEntry("%d %s" % (number, CHAPTERS[n]), key, level=0)
    if n == 12:
        c.bookmarkPage("discussion-section", fit="XYZ", top=H - 60)
        c.addOutlineEntry("Discussion section", "discussion-section", level=1)
        c.bookmarkPage("discussion-detail", fit="XYZ", top=H - 60)
        c.addOutlineEntry("Discussion detail", "discussion-detail", level=2)
    c.setFont("Helvetica-Bold", 18)
    c.drawString(72, H - 80, "Page %d heading" % n + (": " + CHAPTERS[n] if n in CHAPTERS else ""))
    c.setFont("Helvetica", 11)
    y = H - 120
    for line in range(0 if n == 13 else 38):
        words = [WORDS[(n * 7 + line * 5 + i) % len(WORDS)] for i in range(12)]
        text = "Line %d of page %d: %s." % (line + 1, n, " ".join(words))
        if line == 20 and n % 3 == 2:
            text = "Line %d of page %d holds the marker word zymurgical among ordinary words." % (line + 1, n)
        c.drawString(72, y, text)
        y -= 16
    if n == 13:
        for col in range(2):
            for row in range(6):
                c.drawString(72 + col*250, H-120-row*24-col*12, f'Column {col+1} row {row+1} selectable text.')
        c.drawString(72, H-350, 'Before the figure selectable text.')
        c.rect(72, H-470, 220, 90)
        c.drawString(72, H-490, 'Figure caption selectable text.')
        c.drawString(72, H-530, 'After the figure selectable text.')
    if n == 1:
        c.drawString(72, 100, "Source https://example.org/vimium-harness/paper and doi:10.1234/vimium.5678 here.")
        c.drawString(72, 60, "See the results on page nine. Visit the example site.")
        c.linkAbsolute("", "p9", Rect=(72, 56, 240, 72))
        c.linkURL("https://example.com/vimium-harness", (260, 56, 400, 72), relative=0)
    c.showPage()
c.save()
`;

function generatePdf(tmp, file, title) {
  const script = path.join(tmp, 'gen.py');
  fs.writeFileSync(script, GENERATOR);
  const out = path.join(tmp, 'docs', file);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const r = spawnSync('uv', ['run', '--quiet', '--no-project', '--with', 'reportlab', 'python', '-I', script, out, title],
    { encoding: 'utf8', cwd: tmp });
  if (r.status !== 0) throw new Error(`PDF generation failed: ${r.stderr || r.stdout}`);
  return out;
}

async function startDaemon(tmp, port) {
  const cache = path.join(tmp, 'cache');
  fs.mkdirSync(cache, { recursive: true });
  const logPath = path.join(tmp, 'daemon.log');
  const out = fs.openSync(logPath, 'a');
  const child = spawn('uv', ['run', '--directory', path.join(REPO, 'daemon'), 'uvicorn', 'main:app',
    '--host', '127.0.0.1', '--port', String(port), '--log-level', 'warning'], {
    env: {
      ...process.env,
      PDF_VIEWER_CACHE_DIR: cache,
      PDFV_STATE_DB: path.join(tmp, 'state.db'),
      PYTHONUNBUFFERED: '1',
    },
    stdio: ['ignore', out, out],
    detached: true,
  });
  const health = await waitFor(async () => {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/healthz`);
      return resp.ok ? await resp.json() : null;
    } catch (_) { return null; }
  }, 30000, 200);
  if (!health || health.cache_dir !== cache || health.engine !== 'reader') {
    throw new Error(`scratch daemon did not come up as expected: ${JSON.stringify(health)}; log ${logPath}`);
  }
  return { child, cache, logPath };
}

// ------------------------------------------------------------------- in page

// Installed after every load. Engine-neutral: pages are `.pf`, the scroller
// is #page-container, the counter is #pdf2html-pageno-current.
function installProbe() {
  const pc = document.getElementById('page-container');
  const pages = Array.from(pc.querySelectorAll('.pf'));
  const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const sidebarBody = () => document.getElementById('pdf2html-sidebar-body');
  const positions = () => [pc.scrollTop, pc.scrollLeft, (sidebarBody() || {}).scrollTop || 0];
  window.__vp = {
    pc,
    pages,
    frames,
    // Vimium's smooth scroll and the overlay's jumps run over several frames
    // and can start late. Wait for a first change (up to `startMs`), then for
    // `quietMs` without change.
    async settle(startMs = 250, quietMs = 300) {
      const t0 = performance.now();
      let last = positions().join();
      while (performance.now() - t0 < startMs) {
        await frames();
        if (positions().join() !== last) break;
      }
      let quietSince = performance.now();
      const deadline = performance.now() + 5000;
      while (performance.now() < deadline) {
        await frames();
        const now = positions().join();
        if (now !== last) { last = now; quietSince = performance.now(); }
        else if (performance.now() - quietSince >= quietMs) break;
      }
    },
    page(n) { return document.getElementById('pf' + n.toString(16)); },
    pageTop(n) {
      const pf = this.page(n);
      return pf.getBoundingClientRect().top - pc.getBoundingClientRect().top;
    },
    // Screen px per page px for page n (zoom × fit).
    scale(n) {
      const pf = this.page(n);
      const h = parseFloat(pf.style.height) || pf.offsetHeight;
      return pf.getBoundingClientRect().height / h;
    },
    counter() {
      const el = document.getElementById('pdf2html-pageno-current');
      return el ? parseInt(el.textContent, 10) : null;
    },
    mostVisible() {
      const box = pc.getBoundingClientRect();
      let best = -1, bestO = -1;
      pages.forEach((pf, i) => {
        const r = pf.getBoundingClientRect();
        const o = Math.min(r.bottom, box.bottom) - Math.max(r.top, box.top);
        if (o > bestO) { bestO = o; best = i; }
      });
      return best + 1;
    },
    scrollToPage(n, frac) {
      const pf = this.page(n);
      pc.scrollTop += this.pageTop(n) + (frac || 0) * pf.getBoundingClientRect().height;
    },
    state() {
      const sb = sidebarBody();
      return {
        top: pc.scrollTop,
        left: pc.scrollLeft,
        max: pc.scrollHeight - pc.clientHeight,
        clientHeight: pc.clientHeight,
        sidebarTop: sb ? sb.scrollTop : null,
        sidebarScrollable: sb ? sb.scrollHeight - sb.clientHeight : null,
        page: this.counter(),
        visible: this.mostVisible(),
        zoom: parseFloat(getComputedStyle(pc).getPropertyValue('--pdf2html-zoom')) || null,
        sidebar: document.body.classList.contains('sidebar-shown'),
        active: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : null,
      };
    },
    // Vimium link-hint markers (content_scripts/link_hints.js) live in the
    // page DOM as .vimiumHintMarker, positioned at the hinted element's
    // visible rect.
    markers() {
      return Array.from(document.querySelectorAll('.vimiumHintMarker')).map((m) => {
        const r = m.getBoundingClientRect();
        return { hint: m.textContent.trim().toLowerCase(), x: r.left, y: r.top };
      });
    },
    markerFor(el, markers) {
      const rects = Array.from(el.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
      let best = null, bestD = Infinity;
      for (const m of markers) {
        for (const r of rects) {
          const x = Math.max(r.left, 0), y = Math.max(r.top, 0);
          const d = Math.hypot(m.x - x, m.y - y);
          if (d < bestD) { bestD = d; best = m; }
        }
      }
      return bestD <= 4 ? best : null;
    },
    visibleIn(el) {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const cx = Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1);
      const cy = Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1);
      if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return false;
      const hit = document.elementFromPoint(cx, cy);
      return !!hit && (hit === el || el.contains(hit) || hit.contains(el));
    },
    describe(el) {
      if (!el) return null;
      const id = el.id ? '#' + el.id : '';
      const cls = el.classList.length ? '.' + Array.from(el.classList).join('.') : '';
      return `${el.tagName.toLowerCase()}${id}${cls}${el.getAttribute('href') ? `[href=${el.getAttribute('href')}]` : ''}`;
    },
    selection() {
      const sel = getSelection();
      if (!sel || !sel.rangeCount) return { text: '', type: sel ? sel.type : 'None' };
      const r = sel.getRangeAt(0);
      const pageOf = (node) => {
        const el = node && (node.nodeType === 1 ? node : node.parentElement);
        const pf = el && el.closest && el.closest('.pf');
        return pf ? parseInt(pf.getAttribute('data-page-no'), 10) || null : null;
      };
      const inText = (node) => {
        const el = node && (node.nodeType === 1 ? node : node.parentElement);
        return !!(el && el.closest && el.closest('.t'));
      };
      const lineOf = (node) => {
        const el = node && (node.nodeType === 1 ? node : node.parentElement);
        const t = el && el.closest && el.closest('.t');
        const pf = t && t.closest('.pf');
        return t && pf ? `${pf.getAttribute('data-page-no')}:${Array.prototype.indexOf.call(pf.querySelectorAll('.t'), t)}` : null;
      };
      return {
        text: sel.toString(),
        type: sel.type,
        line: lineOf(sel.anchorNode),
        anchorPage: pageOf(sel.anchorNode),
        focusPage: pageOf(sel.focusNode),
        anchorInText: inText(sel.anchorNode),
        focusInText: inText(sel.focusNode),
        top: r.getBoundingClientRect().top - pc.getBoundingClientRect().top,
      };
    },
    // Vimium UI components (HUD, help dialog, vomnibar) are iframes inside
    // open shadow roots appended to <html>.
    vimiumFrames() {
      const out = [];
      for (const host of document.documentElement.children) {
        const root = host.shadowRoot;
        if (!root) continue;
        for (const f of root.querySelectorAll('iframe')) {
          const style = getComputedStyle(f);
          const r = f.getBoundingClientRect();
          out.push({
            src: (f.getAttribute('src') || '').replace(/^chrome-extension:\/\/[a-z]+\//, ''),
            shown: style.display !== 'none' && style.visibility !== 'hidden' && r.width > 0 && r.height > 0
              && !f.classList.contains('vimium-ui-component-hidden') && style.opacity !== '0',
          });
        }
      }
      return out;
    },
  };
}

// ------------------------------------------------------------------- checks

async function runEngine(ctx, spec) {
  const { page, viewer } = ctx;
  section = spec.label;
  const probe = (fn, arg) => page.evaluate(fn, arg);
  const settle = (startMs, quietMs) => probe(([a, b]) => window.__vp.settle(a, b), [startMs, quietMs]);
  const state = () => probe(() => window.__vp.state());
  const press = async (key) => { await page.keyboard.press(key); };
  const pressSettled = async (key) => { await press(key); await settle(); return state(); };
  const blur = () => probe(() => {
    if (document.activeElement && document.activeElement !== document.body && document.activeElement.blur) {
      document.activeElement.blur();
    }
  });
  const clearSelection = () => probe(() => getSelection().removeAllRanges());
  const errorsAtStart = ctx.pageErrors.length;

  async function load() {
    await page.goto(viewer + spec.path, { waitUntil: 'load', timeout: 60000 });
    await page.waitForSelector('#pdf2html-pageno-current', { state: 'attached', timeout: 30000 });
    await page.waitForFunction(() => document.getElementById('page-container')
      && document.getElementById('page-container').style.getPropertyValue('--pdf2html-zoom'),
    null, { timeout: 30000, polling: 100 });
    await page.evaluate(installProbe);
    await page.bringToFront();
    await settle(100, 300);
    await page.waitForTimeout(300);
  }
  async function palette(text) {
    // A palette left open (see the Esc check) would swallow the next `:`.
    await probe(() => { const p = document.getElementById('pdf2html-palette'); if (p) p.remove(); });
    await blur();
    await press(':');
    await page.waitForSelector('#pdf2html-palette-input', { timeout: 3000 });
    await page.keyboard.type(text);
    await press('Enter');
    await page.waitForTimeout(150);
    await settle();
  }
  async function resetState() {
    if (spec.hash) await fetch(`${ctx.daemon}/entry/${spec.hash}/state`, { method: 'DELETE' }).catch(() => {});
  }
  async function hintMode() {
    await press('f');
    const markers = await waitFor(async () => {
      const m = await probe(() => window.__vp.markers());
      return m.length ? m : null;
    }, 2000, 100);
    return markers || [];
  }
  async function exitHints() {
    if ((await probe(() => window.__vp.markers())).length) await press('Escape');
    await page.waitForTimeout(150);
  }
  // Positions the page so `selector` (inside the scroller) is mid-viewport.
  async function bringIntoView(selector) {
    await probe((sel) => {
      const el = document.querySelector(sel);
      const pc = window.__vp.pc;
      const r = el.getBoundingClientRect();
      pc.scrollTop += r.top - pc.getBoundingClientRect().top - pc.clientHeight / 2;
    }, selector);
    await settle(50, 250);
  }

  await resetState();
  await load();
  const meta = await probe(() => ({
    pages: window.__vp.pages.length,
    reader: document.documentElement.getAttribute('data-pdf2html-representation'),
    zoom: window.__vp.state().zoom,
  }));
  note(`${spec.path}: ${meta.pages} pages, representation ${meta.reader}, fit zoom ${fmt(meta.zoom)}`);

  // ---------------------------------------------------------- rule is active
  // `?` is not a Vimium pass key by default; with the rule active it reaches
  // the overlay (cheatsheet) and Vimium's help dialog stays closed.
  {
    await blur();
    await press('?');
    await page.waitForTimeout(500);
    const r = await probe(() => ({
      cheatsheet: !!document.getElementById('pdf2html-cheatsheet'),
      vimiumHelp: window.__vp.vimiumFrames().filter((f) => /help_dialog/.test(f.src) && f.shown).length,
    }));
    check('exclusion rule active on the viewer: `?` opens the overlay cheatsheet, not Vimium help',
      r.cheatsheet && r.vimiumHelp === 0, JSON.stringify(r));
    if (r.cheatsheet) await press('Escape');
    if (r.vimiumHelp) await press('Escape');
    await page.waitForTimeout(200);
  }

  // ------------------------------------------------------------ 1. j/k/d/u
  async function steps(label) {
    await probe(() => window.__vp.scrollToPage(5, 0.3));
    await settle(50, 250);
    await blur();
    const out = {};
    for (const key of ['j', 'k', 'd', 'u']) {
      const a = await state();
      const b = await pressSettled(key);
      out[key] = { delta: b.top - a.top, clientHeight: a.clientHeight };
    }
    const half = out.d.clientHeight / 2;
    check(`1 ${label}: j scrolls #page-container by ${STEP} px`, near(out.j.delta, STEP), `Δ ${fmt(out.j.delta)} px`);
    check(`1 ${label}: k scrolls back by ${STEP} px`, near(out.k.delta, -STEP), `Δ ${fmt(out.k.delta)} px`);
    // Vimium's scrollPageDown is half the element's clientHeight.
    check(`1 ${label}: d scrolls half the scroller height`, near(out.d.delta, half, 1.5), `Δ ${fmt(out.d.delta)} px of ${fmt(half)} px`);
    check(`1 ${label}: u scrolls back half the scroller height`, near(out.u.delta, -half, 1.5), `Δ ${fmt(out.u.delta)} px`);
    return out;
  }
  const atFit = await steps(`fit zoom ${fmt(meta.zoom)}`);
  await palette('zoom 2');
  const zoom2 = (await state()).zoom;
  check('1 `:zoom 2` through the palette applies zoom 2', near(zoom2, 2, 0.001),
    `--pdf2html-zoom ${zoom2}${near(zoom2, 2, 0.001) ? '' : '; Enter ran the highlighted completion, not the typed argument'}`);
  if (!near(zoom2, 2, 0.001)) {
    await palette('zoom 2.0');
    note(`steps at zoom 2 use \`:zoom 2.0\` instead: --pdf2html-zoom ${(await state()).zoom}`);
  }
  const atTwo = await steps('zoom 2');
  check('1 steps are the same screen px at both zooms (ADR 0012)',
    ['j', 'k', 'd', 'u'].every((k) => near(atFit[k].delta, atTwo[k].delta, 1.5)),
    ['j', 'k', 'd', 'u'].map((k) => `${k} ${fmt(atFit[k].delta)}/${fmt(atTwo[k].delta)}`).join(', '));
  await palette('zoom auto');

  // ------------------------------------------------------------- 2. gg / G
  {
    await probe(() => window.__vp.scrollToPage(6, 0.5));
    await settle(50, 250);
    await blur();
    await press('g'); await press('g');
    await settle(250, 400);
    const top = await state();
    check('2 gg goes to the top', near(top.top, 0, 1), `scrollTop ${fmt(top.top)}, page ${top.page}`);
    await press('G');
    await settle(250, 400);
    const bottom = await state();
    check('2 G goes to the bottom', near(bottom.top, bottom.max, 1),
      `scrollTop ${fmt(bottom.top)} of max ${fmt(bottom.max)}, page ${bottom.page}/${meta.pages}`);
  }

  // ------------------------------------------------------------ 3. f hints
  {
    const internalSel = spec.internalLink;
    const externalSel = spec.externalLink;
    await bringIntoView(internalSel);
    await blur();
    const markers = await hintMode();
    const view = await probe(([i, e, m]) => {
      const vp = window.__vp;
      const internal = document.querySelector(i);
      const external = document.querySelector(e);
      const buttons = Array.from(document.querySelectorAll('button, [role=button]'))
        .filter((b) => !b.closest('#page-container') && vp.visibleIn(b));
      return {
        internal: internal && vp.markerFor(internal, m),
        internalVisible: !!internal && vp.visibleIn(internal),
        internalHit: internal ? vp.describe(document.elementFromPoint(
          internal.getBoundingClientRect().left + 3, internal.getBoundingClientRect().top + 3)) : null,
        external: external && vp.markerFor(external, m),
        externalVisible: !!external && vp.visibleIn(external),
        buttons: buttons.map((b) => ({ el: vp.describe(b), hint: (vp.markerFor(b, m) || {}).hint || null })),
      };
    }, [internalSel, externalSel, markers]);
    const passed = vimiumPassKeyString(ctx.passKeys).includes('f');
    check('3 f enters Vimium link-hint mode', markers.length > 0,
      `${markers.length} markers${markers.length ? '' : passed
        ? `; Vimium's effective pass keys "${vimiumPassKeyString(ctx.passKeys)}" contain "f" — the rule passes f to the page`
        : ''}`);
    if (markers.length) {
      const reportLinkHint = check;
      reportLinkHint('3 the internal PDF link gets a hint', !!view.internal,
        `${view.internal ? `hint "${view.internal.hint}"` : 'no marker'}; visible ${view.internalVisible}, hit-test ${view.internalHit}`);
      reportLinkHint('3 the external PDF link gets a hint', !!view.external,
        `${view.external ? `hint "${view.external.hint}"` : 'no marker'}; visible ${view.externalVisible}`);
      const unhinted = view.buttons.filter((b) => !b.hint);
      check('3 visible overlay buttons get hints', view.buttons.length > 0 && unhinted.length === 0,
        view.buttons.map((b) => `${b.el}=${b.hint || 'none'}`).join(', ') || 'no visible overlay buttons');
      if (view.internal) {
        await page.keyboard.type(view.internal.hint, { delay: 30 });
        await settle(300, 400);
        const landed = await state();
        const dest = await probe(() => {
          const vp = window.__vp;
          return { y: vp.pageTop(9) + 60 * vp.scale(9), markers: vp.markers().length };
        });
        check('3 typing the internal link hint jumps to its destination page (9)',
          landed.page === 9 && dest.y >= -2 && dest.y <= PAGE_LEAD + 4,
          `page ${landed.page}, destination point at ${fmt(dest.y)} px below the viewport top, markers left ${dest.markers}`);
      }
    }
    await exitHints();

    // Outline entries need the sidebar open (outline tab).
    await clearSelection();
    await blur();
    await press('Meta+b');
    await page.waitForTimeout(600);
    await press('h'); // outline tab
    await page.waitForTimeout(200);
    await probe(() => window.__vp.scrollToPage(2, 0.1));
    await settle(50, 250);
    const sbMarkers = await hintMode();
    const outline = await probe((m) => {
      const vp = window.__vp;
      const links = Array.from(document.querySelectorAll('#outline a'));
      return links.map((a) => ({ text: a.textContent.trim(), visible: vp.visibleIn(a), hint: (vp.markerFor(a, m) || {}).hint || null }));
    }, sbMarkers);
    const target = outline.find((o) => /Results/.test(o.text));
    if (!sbMarkers.length) {
      check('3 outline entries get hints with the sidebar open', false, `${sbMarkers.length} markers; sidebar shown ${(await state()).sidebar}`);
    } else {
      check('3 outline entries get hints with the sidebar open', outline.length > 0 && outline.every((o) => !o.visible || o.hint),
        outline.map((o) => `"${o.text}"=${o.hint || (o.visible ? 'none' : 'hidden')}`).join(', '));
      if (target && target.hint) {
        await page.keyboard.type(target.hint, { delay: 30 });
        await settle(300, 400);
        const landed = await state();
        const dest = await probe(() => {
          const vp = window.__vp;
          return vp.pageTop(8) + 60 * vp.scale(8);
        });
        check('3 the outline hint ("3 Results") jumps to page 8', landed.page === 8 && dest >= -2 && dest <= PAGE_LEAD + 4,
          `page ${landed.page}, destination at ${fmt(dest)} px`);
      }
    }
    await exitHints();
    if ((await state()).sidebar) { await blur(); await press('Meta+b'); await page.waitForTimeout(500); }
  }

  // ------------------------------------------------------- 4. visual mode
  {
    await clearSelection();
    await probe(() => window.__vp.scrollToPage(3, 0.05));
    await settle(50, 250);
    await blur();
    // v with no selection: Vimium enters caret mode at the first visible text
    // node of 50+ characters; a second v starts visual mode from the caret.
    await press('v');
    await page.waitForTimeout(250);
    const caret = await probe(() => window.__vp.selection());
    await press('v');
    await page.waitForTimeout(250);
    const start = await probe(() => window.__vp.selection());
    const trail = [];
    for (const key of ['e', 'e', 'w', 'j']) {
      await press(key);
      await page.waitForTimeout(120);
      trail.push({ key, ...(await probe(() => window.__vp.selection())) });
    }
    await settle(50, 200);
    const grew = trail.every((t, i) => t.text.length > (i ? trail[i - 1].text.length : start.text.length));
    check('4 v v starts a selection inside the transparent text layer',
      caret.anchorInText && start.anchorInText && start.text.length >= 1,
      `caret ${JSON.stringify(caret.text.slice(0, 20))} on page ${caret.anchorPage} (type ${caret.type}), visual start ${JSON.stringify(start.text.slice(0, 20))}`);
    check('4 visual motions e e w j extend the selection inside the text layer',
      grew && trail.every((t) => t.focusInText),
      trail.map((t) => `${t.key}:${t.text.length}${t.focusInText ? '' : '(focus outside .t)'}`).join(' '));
    const last = trail[trail.length - 1];
    check('4 visual `e` is Vimium\'s word motion, not the overlay\'s page extension',
      trail.slice(0, 2).every((t) => t.focusPage === start.anchorPage),
      trail.slice(0, 2).map((t) => `e→focus page ${t.focusPage}`).join(', ') + `, anchor page ${start.anchorPage}`);
    const selected = last.text;
    await probe(() => navigator.clipboard.writeText('pdfv-clipboard-sentinel').catch(() => {}));
    await press('y');
    await page.waitForTimeout(400);
    const clip = await probe(() => navigator.clipboard.readText().then((t) => ({ ok: true, t }), (e) => ({ ok: false, t: String(e) })));
    if (!clip.ok) {
      check('4 y yanks the selection (clipboard unreadable headless; selection only)', selected.length > 0,
        `clipboard read failed: ${clip.t}; selection ${JSON.stringify(selected.slice(0, 60))}`);
    } else {
      check('4 y yanks exactly the selected text to the clipboard', clip.t === selected,
        `clipboard ${JSON.stringify(clip.t.slice(0, 80))} vs selection ${JSON.stringify(selected.slice(0, 80))}`);
    }
    await press('Escape');
    await clearSelection();

    // Trusted Vimium line motions from the last line across a page break.
    if (spec.label === 'reader') {
      await probe(() => window.__vp.scrollToPage(3, 0.7));
      await settle(50, 250);
      await probe(() => {
        const lines = document.querySelectorAll('#pf3 .t');
        const walker = document.createTreeWalker(lines[lines.length-1], NodeFilter.SHOW_TEXT);
        const node = walker.nextNode();
        getSelection().setBaseAndExtent(node, 0, node, 1);
      });
      await press('v');
      for (let i=0;i<4;i++) { await press('j'); await page.waitForTimeout(80); }
      const down = await probe(() => window.__vp.selection());
      check('4 visual j crosses a page boundary', down.focusPage === 4, `focus page ${down.focusPage}`);
      for (let i=0;i<5;i++) { await press('k'); await page.waitForTimeout(80); }
      const up = await probe(() => window.__vp.selection());
      check('4 visual k crosses back over a page boundary', up.focusPage === 3, `focus page ${up.focusPage}`);
      await press('Escape'); await clearSelection();
      for (const [label, startText, expected] of [
        ['column break', 'Column 1 row 6', 'Column 2'],
        ['figure', 'Before the figure', 'Figure caption'],
      ]) {
        await probe(() => window.__vp.scrollToPage(13, 0.1));
        await settle(50, 250);
        await probe(text => {
          const line=[...document.querySelectorAll('#pfd .t')].find(l=>l.textContent.startsWith(text));
          const node=document.createTreeWalker(line, NodeFilter.SHOW_TEXT).nextNode();
          getSelection().setBaseAndExtent(node,0,node,1);
        }, startText);
        await press('v');
        for (let i=0;i<3;i++) {await press('j'); await page.waitForTimeout(80);}
        const moved=await probe(()=>window.__vp.selection());
        check('4 visual j crosses a '+label, moved.text.includes(expected), JSON.stringify(moved.text));
        await press('Escape'); await clearSelection();
      }
    }

    // Caret from a find hit: overlay `/` search, Enter, then v extends from it.
    await probe(() => window.__vp.scrollToPage(5, 0.4));
    await settle(50, 250);
    await blur();
    await press('/');
    const opened = await page.waitForSelector('#pdf2html-search-input', { timeout: 2000 }).then(() => true, () => false);
    if (!opened) {
      check('4 visual mode from an overlay `/` hit', false, 'search bar did not open');
    } else {
      await page.keyboard.type('zymurgical');
      await press('Enter');
      await settle(200, 300);
      const hit = await probe(() => window.__vp.selection());
      await press('v');
      await page.waitForTimeout(250);
      await press('e');
      await page.waitForTimeout(120);
      await press('e');
      await page.waitForTimeout(150);
      const ext = await probe(() => window.__vp.selection());
      check('4 visual mode from an overlay `/` hit: v e e extends from the hit',
        hit.text.toLowerCase() === 'zymurgical' && ext.text.toLowerCase().startsWith('zymurgical') && ext.text.length > hit.text.length && ext.focusInText,
        `hit ${JSON.stringify(hit.text)} → ${JSON.stringify(ext.text)}`);
      await press('Escape');
      await press('Escape');
      await clearSelection();
    }
  }

  // ------------------------------------------------------ 5. overlay keys
  {
    await probe(() => { const s = document.getElementById('pdf2html-search'); if (s) s.remove(); });
    await clearSelection();
    await palette('3');
    const at3 = await state();
    await blur();
    const e1 = await pressSettled('e');
    const top4 = await probe(() => window.__vp.pageTop(4));
    check('5 e steps to the next page (top at the 8 px lead, no extra Vimium scroll)',
      at3.page === 3 && e1.page === 4 && near(top4, PAGE_LEAD), `page ${at3.page}→${e1.page}, page 4 top ${fmt(top4)} px`);
    const q1 = await pressSettled('q');
    const top3 = await probe(() => window.__vp.pageTop(3));
    check('5 q steps back a page', q1.page === 3 && near(top3, PAGE_LEAD), `page ${q1.page}, top ${fmt(top3)} px`);
    await pressSettled('e');
    const bigE = await pressSettled('E');
    check('5 E steps back a page (alias of q)', bigE.page === 3 && near(await probe(() => window.__vp.pageTop(3)), PAGE_LEAD),
      `page ${bigE.page}`);
    await press('1'); await press('0');
    const e10 = await pressSettled('e');
    const top13 = await probe(() => window.__vp.pageTop(13));
    check('5 10e steps ten pages (digits reach the overlay, not Vimium\'s count)',
      e10.page === 13 && near(top13, PAGE_LEAD), `page 3→${e10.page}, page 13 top ${fmt(top13)} px`);

    await palette('1');
    await blur();
    const c1 = await pressSettled('c');
    const ch1 = await probe(() => window.__vp.pageTop(4) + 60 * window.__vp.scale(4));
    check('5 c goes to the next chapter (page 4)', c1.page === 4 && ch1 >= -2 && ch1 <= PAGE_LEAD + 4,
      `page ${c1.page}, heading destination at ${fmt(ch1)} px`);
    const c2 = await pressSettled('c');
    check('5 c again goes to page 8', c2.page === 8, `page ${c2.page}`);
    const cb = await pressSettled('C');
    check('5 C goes back a chapter (page 4)', cb.page === 4, `page ${cb.page}`);

    // Esc from inside an overlay input. Vimium's insert mode handles Esc in a
    // focused input first (blur + suppress), so record each press.
    const escFromInput = async (label, opener, inputId, rootId) => {
      await blur();
      await press(opener);
      const opened = await page.waitForSelector('#' + inputId, { timeout: 2000 }).then(() => true, () => false);
      const focus = await probe(() => document.activeElement && document.activeElement.id);
      if (opener === '/') await page.keyboard.type('page');
      const after = [];
      for (let i = 0; i < 2; i++) {
        await press('Escape');
        await page.waitForTimeout(200);
        after.push(await probe((id) => ({
          open: !!document.getElementById(id),
          focus: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : null,
        }), rootId));
        if (!after[i].open) break;
      }
      check(`5 ${label} opens with focus in its input; one Esc closes it`, opened && focus === inputId && !after[0].open,
        `opened ${opened}, focus ${focus}; ` + after.map((a, i) => `Esc ${i + 1}: ${a.open ? 'still open' : 'closed'}, focus ${a.focus}`).join('; '));
      await probe((id) => { const el = document.getElementById(id); if (el) el.remove(); }, rootId);
    };
    await blur();
    await press('s');
    const sKey = await page.waitForSelector('#pdf2html-search-input', { timeout: 2000 }).then(() => true, () => false);
    check('5 s opens the overlay search', sKey && (await probe(() => document.activeElement && document.activeElement.id)) === 'pdf2html-search-input');
    await probe(() => { const el = document.getElementById('pdf2html-search'); if (el) el.remove(); });
    await escFromInput('`:` palette', ':', 'pdf2html-palette-input', 'pdf2html-palette');
    await escFromInput('`/` search bar', '/', 'pdf2html-search-input', 'pdf2html-search');
    for (const [label, key] of [['⌘O sections', 'Meta+o'], ['⌘P documents', 'Meta+p'], ['⌘K quick open', 'Meta+k']]) {
      await escFromInput(label, key, 'pdf2html-finder-input', 'pdf2html-finder');
    }
    {
      // A ⌘O preview moves the document; Vimium's Escape (a blur) puts it back.
      await blur();
      const before = await probe(() => window.__vp.pc.scrollTop);
      await press('Meta+o');
      await page.waitForSelector('#pdf2html-finder-input', { timeout: 2000 }).catch(() => {});
      await press('ArrowDown');
      await page.waitForTimeout(150);
      const moved = await probe(() => window.__vp.pc.scrollTop);
      await press('Escape');
      await page.waitForTimeout(200);
      const after = await probe(() => ({ top: window.__vp.pc.scrollTop, open: !!document.getElementById('pdf2html-finder') }));
      check('5 ⌘O preview moves the document; one Esc closes and restores it', moved !== before && !after.open && Math.abs(after.top - before) < 0.5,
        `before ${fmt(before)}, preview ${fmt(moved)}, after ${fmt(after.top)}${after.open ? ', still open' : ''}`);
    }
    await probe(() => window.__vp.pc.dispatchEvent(new Event('scroll')));
    await page.keyboard.press('Escape'); // clear any search highlights left behind
    await clearSelection();

    await blur();
    await press('?');
    await page.waitForTimeout(300);
    const sheet = await probe(() => ({
      open: !!document.getElementById('pdf2html-cheatsheet'),
      vimium: window.__vp.vimiumFrames().filter((f) => f.shown).map((f) => f.src),
    }));
    await press('?');
    await page.waitForTimeout(200);
    const sheetClosed = await probe(() => !document.getElementById('pdf2html-cheatsheet'));
    check('5 ? toggles the cheatsheet; no Vimium UI opens', sheet.open && sheetClosed && sheet.vimium.length === 0,
      `opened ${sheet.open}, closed by ? ${sheetClosed}, shown Vimium frames ${JSON.stringify(sheet.vimium)}`);

    // `/` search with n / N.
    await probe(() => window.__vp.scrollToPage(5, 0.4));
    await settle(50, 250);
    await blur();
    await press('/');
    const sOpen = await page.waitForSelector('#pdf2html-search-input', { timeout: 2000 }).then(() => true, () => false);
    const sFocus = await probe(() => document.activeElement && document.activeElement.id);
    await page.keyboard.type('page 5');
    await press('Enter');
    await settle(200, 300);
    const h0 = await probe(() => window.__vp.selection());
    const n1 = await pressSettled('n');
    const h1 = await probe(() => window.__vp.selection());
    await pressSettled('N');
    const h2 = await probe(() => window.__vp.selection());
    const vimFrames = await probe(() => window.__vp.vimiumFrames().filter((f) => f.shown).map((f) => f.src));
    check('5 / opens the overlay search (focus in its input, not Vimium find)', sOpen && sFocus === 'pdf2html-search-input',
      `opened ${sOpen}, focus ${sFocus}`);
    check('5 search Enter selects a hit; n moves to another; N comes back',
      /page 5/i.test(h0.text) && /page 5/i.test(h1.text) && h0.line && h1.line && h1.line !== h0.line
        && h2.line === h0.line && vimFrames.length === 0,
      `hit on page:line ${h0.line} → n ${h1.line} → N ${h2.line} ("${h1.text}"), page ${n1.page}, Vimium frames ${JSON.stringify(vimFrames)}`);
    await press('Escape');
    await page.waitForTimeout(150);
    const searchCleared = await probe(() => !document.body.classList.contains('pdf2html-search-entered')
      && !document.getElementById('pdf2html-search'));
    check('5 Esc clears the search', searchCleared);
    await clearSelection();

    // Ctrl-f finger mode on page 1's URL and DOI line (finger mode hints
    // visible tokens only).
    await palette('1');
    await probe(() => {
      const line = Array.from(document.querySelectorAll('#pf1 .t')).find((t) => /example\.org/.test(t.textContent));
      const pc = window.__vp.pc;
      pc.scrollTop += line.getBoundingClientRect().top - pc.getBoundingClientRect().top - pc.clientHeight / 2;
    });
    await settle(50, 250);
    await blur();
    await press('Control+f');
    await page.waitForTimeout(300);
    const fingers = await probe(() => ({
      active: document.body.classList.contains('pdf2html-fingers-active'),
      labels: document.querySelectorAll('.pdf2html-finger-label, [class*=finger-label]').length,
    }));
    await press('Escape');
    await page.waitForTimeout(150);
    const fingersClosed = await probe(() => !document.body.classList.contains('pdf2html-fingers-active'));
    check('5 Ctrl-f opens finger mode; Esc closes it', fingers.active && fingersClosed,
      `active ${fingers.active}, labels ${fingers.labels}, closed ${fingersClosed}`);

    // Esc chain: cheatsheet → sidebar → selection.
    await blur();
    await press('Meta+b');
    await page.waitForTimeout(500);
    await probe(() => {
      const t = document.querySelector('#pf1 .t');
      const r = document.createRange();
      r.selectNodeContents(t);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
    });
    await press('?');
    await page.waitForTimeout(250);
    const chain = [];
    const snap = () => probe(() => ({
      sheet: !!document.getElementById('pdf2html-cheatsheet'),
      sidebar: document.body.classList.contains('sidebar-shown'),
      sel: !getSelection().isCollapsed,
    }));
    chain.push(await snap());
    for (let i = 0; i < 3; i++) { await press('Escape'); await page.waitForTimeout(250); chain.push(await snap()); }
    const fmtChain = chain.map((s) => `${s.sheet ? 'S' : '-'}${s.sidebar ? 'B' : '-'}${s.sel ? 'T' : '-'}`).join(' → ');
    // Selection may be cleared by the sidebar's activateMain() (ADR 0005), so
    // the third Esc can find nothing left to clear.
    // Closing the sidebar clears the selection itself (activateMain, ADR
    // 0005), so select again for the last link of the chain.
    await probe(() => {
      const t = document.querySelector('#pf1 .t');
      const r = document.createRange();
      r.selectNodeContents(t);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
    });
    const reselected = await snap();
    await press('Escape');
    await page.waitForTimeout(200);
    const last = await snap();
    check('5 Esc chain closes cheatsheet, then sidebar, then clears a selection',
      chain[0].sheet && chain[0].sidebar && !chain[1].sheet && chain[1].sidebar && !chain[2].sidebar
        && reselected.sel && !last.sel,
      `${fmtChain} | reselect ${reselected.sel ? 'T' : '-'} → Esc ${last.sel ? 'T' : '-'} (S cheatsheet, B sidebar, T selection)`);
  }

  // Return pins use trusted keys with Vimium active, no extra pass keys.
  {
    await clearSelection(); await blur();
    if ((await state()).sidebar) await press('Meta+b');
    await probe(() => window.__vp.scrollToPage(1,0.25)); await settle();
    await press('Control+Shift+P'); await page.waitForTimeout(300);
    check('pins drop chord reaches the page under Vimium', await page.locator('.pdf2html-pin-marker').count()===1);
    await probe(() => window.__vp.scrollToPage(8,0.2)); await settle();
    await press('Control+Shift+O'); await settle();
    check('pins latest chord reaches page and restores position', (await state()).page===1);
    async function activateHint(selector, name) {
      await blur();
      await probe(s=>{const e=document.querySelector(s);if(e){e.dataset.hintActivated='0';e.addEventListener('click',()=>e.dataset.hintActivated='1',{once:true});}},selector);
      const m=await hintMode();
      const hint=await probe(([s,m])=>{ const e=document.querySelector(s); return e && window.__vp.markerFor(e,m); },[selector,m]);
      check(name+' receives f hint', !!hint);
      if(hint) { await page.keyboard.type(hint.hint,{delay:30}); await page.waitForTimeout(200); }
      else await exitHints();
    }
    await activateHint('.pdf2html-pin-marker','pin margin marker');
    await palette('pins'); await blur();
    await activateHint('[data-tab="pins"]','Pins tab');
    await activateHint('.pdf2html-pin-jump','pin row');
    await activateHint('.pdf2html-pin-remove','pin remove');
    await activateHint('[data-tab="thumbs"]','Pages tab');
    await activateHint('.pdf2html-thumb','thumbnail');
    await activateHint('[data-tab="outline"]','Outline tab');
    await activateHint('.pdf2html-disclosure','outline disclosure');
    await activateHint('.pdf2html-sidebar-close','sidebar close');
    await palette('counter'); await blur();
    await activateHint('#pdf2html-pageno','page counter');
    await activateHint('.pdf2html-sidebar-footer-btn.icon-only','Help footer');
    await activateHint('#pdf2html-cheatsheet .close','cheatsheet close');
    await activateHint('.pdf2html-sidebar-footer-btn:not(.icon-only)','Settings footer');
    const controls = await probe(() => Array.from(document.querySelectorAll('#pdf2html-settings .pdf2html-switch, #pdf2html-settings input:not(:disabled)')).map((e,i)=>{ e.dataset.auditControl=i; return i; }));
    for (const i of controls) await activateHint('[data-audit-control="'+i+'"]','settings control '+i);
    await activateHint('#pdf2html-settings .close','settings close');
    if ((await state()).sidebar) await press('Meta+b');
    await activateHint('#pdf2html-toggle','sidebar toggle');
    if ((await state()).sidebar) await press('Meta+b');
  }

  // ------------------------------------------------------ 6. sidebar scope
  {
    await clearSelection();
    await probe(() => window.__vp.scrollToPage(5, 0.3));
    await settle(50, 250);
    await blur();
    await press('Meta+b');
    await page.waitForTimeout(600);
    await page.locator('[data-tab=outline]').click();
    const tab0 = await probe(() => document.body.getAttribute('data-sidebar-tab'));
    const left0 = (await state()).left;
    await press('Control+ArrowRight'); // Pages tab: 14 thumbnails, so the body scrolls
    await page.waitForTimeout(700);
    const s0 = await state();
    const tab1 = await probe(() => document.body.getAttribute('data-sidebar-tab'));
    await press('Control+ArrowLeft');
    await page.waitForTimeout(200);
    const tab2 = await probe(() => document.body.getAttribute('data-sidebar-tab'));
    const left2 = (await state()).left;
    check('6 Ctrl-arrows switch sidebar tabs without a Vimium horizontal scroll',
      tab1 === 'thumbs' && tab2 === 'outline' && left0 === s0.left && left2 === left0,
      `tab ${tab0} → l ${tab1} → h ${tab2}, scrollLeft ${left0}/${s0.left}/${left2}`);
    await press('Control+ArrowRight');
    await page.waitForTimeout(500);
    if (!s0.sidebar || !(s0.sidebarScrollable > STEP)) {
      check('6 sidebar body is open and scrollable', false, JSON.stringify(s0));
    } else {
      const j1 = await pressSettled('j');
      const k1 = await pressSettled('k');
      check('6 with the sidebar open, j scrolls the sidebar body, not the document',
        near(j1.sidebarTop - s0.sidebarTop, STEP) && near(j1.top, s0.top, 0.5),
        `sidebar Δ ${fmt(j1.sidebarTop - s0.sidebarTop)}, document Δ ${fmt(j1.top - s0.top)}, focus ${s0.active}`);
      check('6 with the sidebar open, k scrolls the sidebar body back',
        near(k1.sidebarTop - j1.sidebarTop, -STEP) && near(k1.top, s0.top, 0.5),
        `sidebar Δ ${fmt(k1.sidebarTop - j1.sidebarTop)}, document Δ ${fmt(k1.top - j1.top)}`);
      await press('h');
      await page.waitForTimeout(200);
      await press('Meta+b');
      await page.waitForTimeout(600);
      const c0 = await state();
      const j2 = await pressSettled('j');
      const k2 = await pressSettled('k');
      check('6 after closing the sidebar, j / k scroll the document again',
        !c0.sidebar && near(j2.top - c0.top, STEP) && near(k2.top - j2.top, -STEP),
        `sidebar shown ${c0.sidebar}, document Δ j ${fmt(j2.top - c0.top)}, k ${fmt(k2.top - j2.top)}`);
    }
  }

  // ------------------------------------------------------------- 7. marks
  {
    await probe(() => window.__vp.scrollToPage(4, 0.5));
    await settle(50, 250);
    await blur();
    const m0 = await state();
    await press('m'); await press('a');
    await page.waitForTimeout(250);
    const stored = await probe(() => Object.keys(localStorage).filter((k) => /vimium|mark/i.test(k))
      .map((k) => `${k}=${localStorage.getItem(k)}`));
    await probe(() => window.__vp.scrollToPage(10, 0.2));
    await settle(50, 250);
    const moved = await state();
    await press("'"); await press('a');
    await settle(300, 400);
    const back = await state();
    note("7 Vimium ma, scroll, 'a returns to the marked position: known Vimium limitation — marks store window scroll, which is always 0 here; :mark / :jump is the supported path. "
      + `marked scrollTop ${fmt(m0.top)} (page ${m0.page}), moved to ${fmt(moved.top)} (page ${moved.page}), after 'a ${fmt(back.top)} (page ${back.page}); stored ${JSON.stringify(stored)}`);
  }

  // ------------------------------------------------------- 8. console errors
  {
    const errs = ctx.pageErrors.slice(errorsAtStart);
    check('8 no console errors from the page', errs.length === 0, errs.slice(0, 5).join(' | '));
  }
}

// ---------------------------------------------------------------------- main

async function main() {
  const t0 = Date.now();
  // Real path: macOS's /var is a symlink, and the daemon stores resolved paths.
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pdfv-verify-vimium-'));
  const cleanup = [];
  try {
    const port = await pickPort();
    const viewer = `http://localhost:${port}`;
    const daemonUrl = `http://127.0.0.1:${port}`;
    const executablePath = findChromium();
    const vimiumSrc = findVimium();
    const vimiumDir = path.join(tmp, 'vimium');
    const vimiumVersion = copyVimium(vimiumSrc, vimiumDir);
    const extensionDir = path.join(tmp, 'extension');
    copyExtension(extensionDir, port);
    console.log(`chromium: ${executablePath}`);
    console.log(`vimium: ${vimiumVersion} (copied from ${vimiumSrc})`);
    console.log(`scratch: ${tmp}, daemon ${viewer}`);

    const readerPdf = generatePdf(tmp, 'harness.pdf', 'Vimium harness document');
    const daemon = await startDaemon(tmp, port);
    cleanup.push(async () => {
      try { process.kill(-daemon.child.pid, 'SIGTERM'); } catch (_) {}
      await sleep(300);
      try { process.kill(-daemon.child.pid, 'SIGKILL'); } catch (_) {}
    });

    const engines = [];
    {
      const resp = await fetch(`${daemonUrl}/read?path=${encodeURIComponent(readerPdf)}`, { redirect: 'manual' });
      const loc = resp.headers.get('location') || '';
      const m = /\/r\/([a-f0-9]{16})\//.exec(loc);
      if (!m) throw new Error(`/read did not redirect to a reader shell: ${resp.status} ${loc}`);
      engines.push({
        label: 'reader',
        path: `/r/${m[1]}/`,
        hash: m[1],
        internalLink: '#pf1 a.l[data-reader-dest]',
        externalLink: '#pf1 a.l[href^="https://example.com"]',
      });
    }
    const profile = path.join(tmp, 'profile');
    const context = await chromium.launchPersistentContext(profile, {
      executablePath,
      headless: !process.env.PDFV_HEADED,
      viewport: VIEWPORT,
      ignoreDefaultArgs: ['--disable-extensions'],
      args: [
        `--disable-extensions-except=${vimiumDir},${extensionDir}`,
        `--load-extension=${vimiumDir},${extensionDir}`,
      ],
    });
    cleanup.push(() => context.close());
    const vimiumWorker = context.serviceWorkers().find((w) => w.url().includes(VIMIUM_ID))
      || await context.waitForEvent('serviceworker', { predicate: (w) => w.url().includes(VIMIUM_ID), timeout: 15000 });
    const extWorker = await waitFor(() => context.serviceWorkers().find((w) => !w.url().includes(VIMIUM_ID)), 10000);
    console.log(`extensions: vimium ${vimiumWorker.url().split('/')[2]}, pdf_viewer ${extWorker ? extWorker.url().split('/')[2] : 'not loaded'}`);

    // ------------------------------------------------------ Vimium setup
    section = 'setup';
    const pattern = `https?://localhost:${port}/*`;
    const rule = { pattern, passKeys: DOC_PASS_KEYS };
    const stored = await vimiumWorker.evaluate(async (r) => {
      await chrome.storage.sync.set({ settingsVersion: chrome.runtime.getManifest().version, exclusionRules: [r] });
      return (await chrome.storage.sync.get('exclusionRules')).exclusionRules;
    }, rule);
    check('Vimium exclusion rule stored in chrome.storage.sync',
      Array.isArray(stored) && stored.length === 1 && stored[0].pattern === pattern && stored[0].passKeys === DOC_PASS_KEYS,
      JSON.stringify(stored));
    const effective = vimiumPassKeyString(DOC_PASS_KEYS);
    note(`Vimium's effective pass keys for "${DOC_PASS_KEYS}": "${effective}" (whitespace removed, distinct characters, sorted)`);
    const docPattern = 'localhost:7435';
    note(`the docs' literal pattern "${docPattern}" ${vimiumPatternMatches(docPattern, 'http://localhost:7435/r/0123456789abcdef/') ? 'matches' : 'does not match'} a viewer URL under Vimium's ^pattern$ rule; this run uses "${pattern}"`);
    for (const key of ['f', '<c-f>']) {
      note(`key ${key} is ${effective.includes(key) ? '' : 'not '}a pass key`);
    }
    // Vimium's own first-run tab, if any, is noise.
    for (const p of context.pages()) if (/^chrome-extension:|vimium/.test(p.url())) await p.close().catch(() => {});

    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: viewer });
    const page = await context.newPage();
    const pageErrors = [];
    const extensionLogs = [];
    page.on('console', (msg) => {
      const url = (msg.location() && msg.location().url) || '';
      if (url.startsWith('chrome-extension://')) {
        extensionLogs.push(`${msg.type()}: ${msg.text()} (${url.replace(/^chrome-extension:\/\/[a-z]+\//, '')})`);
      } else if (msg.type() === 'error') {
        pageErrors.push(msg.text());
      }
    });
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    try {
      vimiumWorker.on('console', (msg) => extensionLogs.push(`${msg.type()}: ${msg.text()} (Vimium service worker)`));
    } catch (_) { /* older Playwright: worker console not exposed */ }
    // Console "Failed to load resource" lines carry no URL; record which.
    page.on('response', (resp) => {
      if (resp.status() >= 400) pageErrors.push(`HTTP ${resp.status()} ${resp.url().replace(viewer, '')}`);
    });
    for (const p of context.pages()) if (p !== page && p.url() === 'about:blank') await p.close().catch(() => {});

    // Control: a URL the rule does not match (the 127.0.0.1 spelling of the
    // same daemon). There Vimium takes `?` itself, which shows the rule is
    // what lets the overlay see it.
    if (engines.length) {
      section = 'control';
      await page.goto(`${daemonUrl}${engines[0].path}`, { waitUntil: 'load' });
      await page.waitForSelector('#pdf2html-pageno-current', { state: 'attached', timeout: 30000 });
      await page.evaluate(installProbe);
      await page.waitForTimeout(500);
      await page.keyboard.press('?');
      await page.waitForTimeout(800);
      const ctl = await page.evaluate(() => ({
        cheatsheet: !!document.getElementById('pdf2html-cheatsheet'),
        vimiumHelp: window.__vp.vimiumFrames().filter((f) => /help_dialog/.test(f.src) && f.shown).length,
      }));
      check('without the rule (127.0.0.1 origin) Vimium takes `?` and the overlay does not see it',
        !ctl.cheatsheet && ctl.vimiumHelp > 0, JSON.stringify(ctl));
      await page.keyboard.press('Escape');
      pageErrors.length = 0;
    }

    const ctx = { page, viewer, daemon: daemonUrl, pageErrors, passKeys: DOC_PASS_KEYS };
    for (const spec of engines) {
      try {
        await runEngine(ctx, spec);
      } catch (error) {
        check('checks ran to completion', false, error.stack || String(error));
      }
    }

    // The main run uses the documented rule, which does not contain `<c-f>`.
    // This only records the trap: a rule that does contain it makes Vimium
    // pass plain `f` (distinct characters of `<c-f>` include `f`).
    section = '';
    {
      const ruleWithCtrlF = '? s / n N h l e q E c C <c-f> 0 1 2 3 4 5 6 7 8 9';
      const trapKeys = vimiumPassKeyString(ruleWithCtrlF);
      check('a rule containing <c-f> would pass plain f to the page (keep <c-f> out of the rule)',
        trapKeys.includes('f'), `effective pass keys "${trapKeys}"`);
    }

    if (extensionLogs.length) {
      note(`extension-context console messages (not counted): ${extensionLogs.length}`);
      for (const l of extensionLogs.slice(0, 10)) console.log(`  ${l}`);
    } else {
      note('no extension-context console messages');
    }
  } catch (error) {
    section = '';
    check('harness', false, error.stack || String(error));
  } finally {
    for (const step of cleanup.reverse()) {
      try { await step(); } catch (_) {}
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`time: ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  console.log(failed.length ? `FAIL ${failed.length} of ${results.length} checks` : `PASS all ${results.length} checks`);
  process.exit(failed.length ? 1 : 0);
}

setTimeout(() => {
  console.log(`FAIL harness did not finish within ${HARNESS_TIMEOUT_MS / 1000} s`);
  process.exit(1);
}, HARNESS_TIMEOUT_MS).unref();

main();

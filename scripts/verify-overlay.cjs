#!/usr/bin/env node
/*
 * Overlay behavior proof against a real cached document.
 *
 * Usage: verify-overlay.cjs <viewer-url-or-path> [--base URL] [--only <group,...>]
 *   e.g. /7319a537e6c3b9da/kompendium.light.html
 *
 * Groups (all by default):
 *   geometry    zoom lives on pages; Vimium-sized steps; pdf2htmlEX links;
 *               zoom changes keep the reading position; sidebar shift
 *   navigation  page jumps land the page top 8 px below the viewport top;
 *               outline jumps land their destination at the viewport top;
 *               marks, resume, e/q, c
 *   sidebar     outline + thumbnail keyboard commits, one active outline row
 *   commands    palette commands, preferences, settings, cheatsheet, yank
 *   search      `/` search, Enter lands inside the scrolloff band, n cycles
 *   interaction arrows, paging/history/zoom keys, dark, counter, quote, state
 *   smoke       boot, raster readiness (reader), find, assets, console
 *
 * The document should have an outline and internal links. This is a
 * supplement to the real Comet + Vimium check, not a replacement: synthetic
 * keys reach the page, but Vimium itself is not loaded.
 */
'use strict';

const { chromium } = require('playwright');

let BASE = process.env.PDFV_BASE || 'http://localhost:7435';
const VIEWPORT = { width: 1440, height: 1000 };
const TOL = 1.5;
const PAGE_LEAD = 8;

const args = process.argv.slice(2);
const target = args[0] && !args[0].startsWith('--') ? args[0] : null;
const baseIdx = args.indexOf('--base');
if (baseIdx >= 0 && args[baseIdx + 1]) BASE = args[baseIdx + 1].replace(/\/$/, '');
const onlyIdx = args.indexOf('--only');
const only = onlyIdx >= 0 && args[onlyIdx + 1] ? new Set(args[onlyIdx + 1].split(',')) : null;
if (!target) {
  console.error('usage: verify-overlay.cjs <viewer-url-or-path> [--only geometry,navigation,...]');
  process.exit(2);
}
const URL = /^https?:/.test(target) ? target : BASE + (target.startsWith('/') ? '' : '/') + target;

BASE = new globalThis.URL(URL).origin;
let activeBrowser;
const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
const near = (a, b, tol = TOL) => typeof a === 'number' && Math.abs(a - b) <= tol;

// In-page helpers, installed after every load.
function installProbe() {
  const pc = document.getElementById('page-container');
  const pages = Array.from(pc.querySelectorAll('.pf'));
  const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  // Wait for any scroll the last action started to finish. A smooth scroll
  // can begin a few frames late, so give it a moment to start, then wait for
  // scrollend (with a ceiling), then for the trackers' next frame.
  let scrolling = false;
  pc.addEventListener('scroll', () => { scrolling = true; }, { passive: true });
  pc.addEventListener('scrollend', () => { scrolling = false; });
  const settle = async () => {
    const start = performance.now();
    while (!scrolling && performance.now() - start < 250) await frames();
    const deadline = performance.now() + 5000;
    while (scrolling && performance.now() < deadline) await frames();
    scrolling = false;
    await frames();
  };
  window.__probe = {
    pc,
    pages,
    frames,
    settle,
    page(n) { return document.getElementById('pf' + n.toString(16)); },
    pageTop(pf) { return pf.getBoundingClientRect().top - pc.getBoundingClientRect().top; },
    anchor() {
      const top = pc.getBoundingClientRect().top;
      for (const pf of pages) {
        const r = pf.getBoundingClientRect();
        if (r.bottom > top) return { id: pf.id, frac: (top - r.top) / r.height };
      }
      return null;
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
      pc.scrollTop += this.pageTop(pf) + (frac || 0) * pf.getBoundingClientRect().height;
    },
    // Screen y (relative to the viewport top) of a pdf2htmlEX link's XYZ
    // destination, or null when it has none.
    destY(a) {
      const reader = a.getAttribute('data-reader-dest');
      if (reader) {
        const d = JSON.parse(reader), pf = this.page(d[0]);
        const r = pf.getBoundingClientRect();
        return {page: pf.id, y: r.top + d[3] * r.height / parseFloat(pf.style.height) - pc.getBoundingClientRect().top,
          atEnd: pc.scrollTop >= pc.scrollHeight - pc.clientHeight - 1};
      }
      const v = window.pdf2htmlEX.defaultViewer;
      let dest;
      try { dest = JSON.parse(a.getAttribute('data-dest-detail')); } catch (e) { return null; }
      if (!Array.isArray(dest) || dest[1] !== 'XYZ' || typeof dest[3] !== 'number') return null;
      const idx = v.page_map[dest[0]];
      if (idx === undefined) return null;
      const pg = v.pages[idx];
      const r = pg.page.getBoundingClientRect();
      const toScreen = r.height / pg.page.offsetHeight;   // page-local px -> screen px
      const x = dest[2] === null ? 0 : dest[2];
      const localY = pg.height() - (pg.ctm[1] * x + pg.ctm[3] * dest[3] + pg.ctm[5]);
      return {
        page: pg.page.id,
        y: r.top + localY * toScreen - pc.getBoundingClientRect().top,
        atEnd: pc.scrollTop >= pc.scrollHeight - pc.clientHeight - 1,
      };
    },
    outlineLinks() { return Array.from(document.querySelectorAll('#outline a.l[data-dest-detail], #outline a.l[data-reader-dest]')); },
    activeOutline() { return Array.from(document.querySelectorAll('#outline a.pdf2html-active')); },
    zoomVar() { return parseFloat(getComputedStyle(pc).getPropertyValue('--pdf2html-zoom')); },
    clips: [],
  };
  // Record clipboard writes: headless Chromium does not hand them back.
  const write = navigator.clipboard.writeText.bind(navigator.clipboard);
  navigator.clipboard.writeText = (t) => { window.__probe.clips.push(t); return write(t).catch(() => {}); };
}

async function main() {
  const browser = activeBrowser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: VIEWPORT });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new globalThis.URL(URL).origin });
  const page = await context.newPage();
  const errors = [];
  const failedAssets = [];
  page.on('requestfailed', r => {if(r.url().includes('/_assets/')) failedAssets.push(r.url());});
  page.on('response', r => {if(r.url().includes('/_assets/') && r.status()>=400) failedAssets.push(r.url());});
  let reader = false;
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });

  const probe = (fn, arg) => page.evaluate(fn, arg);
  const settle = () => probe(() => window.__probe.settle());

  async function load({ reset = false, prefs = {} } = {}) {
    total = 0;
    if (reset) {
      // Leave the old viewer and drain its pagehide keepalive writes before
      // deleting state, or it can repopulate the daemon after the reset.
      await page.goto(BASE + '/healthz', { waitUntil: 'networkidle' });
      // Position, marks and zoom also live in the daemon (daemon/state.py);
      // a daemon without those routes answers 404/405, which is fine.
      const entry = /^\/(?:r\/)?([a-f0-9]{6,32})\//.exec(new globalThis.URL(URL).pathname);
      if (entry) await context.request.delete(`${BASE}/entry/${entry[1]}/state`).catch(() => {});
      await page.evaluate((p) => {
        localStorage.clear();
        for (const [k, v] of Object.entries(p)) localStorage.setItem(k, v);
      }, prefs);
    }
    const resp = await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
    if (!resp || !resp.ok()) throw new Error(`viewer did not load: ${URL}`);
    await page.waitForSelector('#pdf2html-pageno-current', { state: 'attached', timeout: 30000 });
    await page.waitForFunction(() => (document.querySelector('[data-reader-raster]') || (window.pdf2htmlEX && window.pdf2htmlEX.defaultViewer))
      && document.getElementById('page-container').style.getPropertyValue('--pdf2html-zoom'),
      null, { timeout: 30000, polling: 100 });
    reader = await page.evaluate(() => !!document.querySelector('[data-reader-raster]'));
    if (reader) await page.waitForFunction(() => document.documentElement.dataset.readerText === 'complete', null, {timeout: 60000});
    await page.evaluate(installProbe);
    total = await probe(() => window.__probe.pages.length);
    await settle();
    await page.waitForTimeout(300);
  }
  async function blurToDocument() {
    await probe(() => {
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      getSelection().removeAllRanges();
    });
  }
  async function palette(text) {
    await blurToDocument();
    await page.keyboard.press(':');
    await page.waitForSelector('#pdf2html-palette-input', { timeout: 3000 });
    await page.keyboard.type(text);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);
    await settle();
  }
  const run = (group) => !only || only.has(group);
  // Test pages scale with the document so short papers and long books both
  // work: pick(n) is n clamped to the document, minus a margin at the end.
  let total = 0;
  const pick = (n, margin = 3) => Math.max(2, Math.min(n, total - margin));

  if (run('interaction') && process.env.PDFV_SYNTHETIC === '1') {
    let release;
    const gate = new Promise(r => {release=r;});
    let ranges = 0;
    await page.route('**/r/*/text/**', async route => {ranges++; await gate; await route.continue();});
    try {
      await page.goto(URL, {waitUntil:'load'});
      await page.waitForSelector('.pf[data-pdf2html-raster-state="ready"]', {timeout:30000});
      await probe(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
      record('[reader] first raster paints before all text', await probe(() => document.documentElement.dataset.readerText==='loading' && document.querySelectorAll('[data-reader-pending]').length>0));
    } finally {release();}
    await page.waitForFunction(() => document.documentElement.dataset.readerText==='complete', null, {timeout:60000});
    record('[reader] progressive ranges complete the text layer', ranges>0 && await probe(() => !document.querySelector('[data-reader-pending]') && document.querySelector('#pf9f .t')!==null));
    await page.unroute('**/r/*/text/**');
  }

  if (run('smoke')) {
    await load({reset: true});
    record('overlay boots with pages and sidebar', (process.env.PDFV_FIXTURE_PAGES ? total === +process.env.PDFV_FIXTURE_PAGES : total > 0) && await page.locator('#sidebar').count() === 1);
    if (reader) {
      await page.waitForSelector('.pf[data-pdf2html-raster-state="ready"]', {timeout:30000});
      record('[reader] first raster is ready', true);
    }
    record('native find works', await probe(() => window.find('heading')));
    if (!reader) record('[pdf2htmlEX] render loop stopped', await probe(() => window.pdf2htmlEX.defaultViewer.render_timer === null));
  }

  if (run('interaction')) {
    await load({reset: true});
    {
      const top = () => probe(() => window.__probe.pc.scrollTop);
      const pageTop = n => probe(n => window.__probe.pageTop(window.__probe.page(n)), n);
      await palette('5');
      await blurToDocument();
      await page.keyboard.press('ArrowRight'); await settle();
      record('ArrowRight advances a page', near(await pageTop(6), PAGE_LEAD));
      await page.keyboard.press('ArrowLeft'); await settle();
      record('ArrowLeft goes back a page', near(await pageTop(5), PAGE_LEAD));
      for (const [key, amount] of [['ArrowDown',60], ['ArrowUp',-60], ['Space',900], ['Shift+Space',-900], ['PageDown',900], ['PageUp',-900]]) {
        const before = await top();
        await page.keyboard.press(key); await settle();
        record(key + ' scrolls the document', near((await top()) - before, amount));
      }
      await page.keyboard.press('End'); await settle();
      record('End reaches document end', await probe(() => {const p=window.__probe.pc; return p.scrollTop >= p.scrollHeight-p.clientHeight-1;}));
      await page.keyboard.press('Home'); await settle();
      record('Home reaches document start', near(await top(),0));
      await palette('5'); await palette('12'); await blurToDocument();
      await page.keyboard.press('Meta+z'); await settle();
      record('Cmd-Z restores the previous jump', near(await pageTop(5),PAGE_LEAD));
      await page.keyboard.press('Meta+Shift+z'); await settle();
      record('Cmd-Shift-Z redoes the jump', near(await pageTop(12),PAGE_LEAD));
      await page.keyboard.press('Meta+b'); await page.waitForTimeout(900);
      const sizes = () => probe(() => ({sidebar:document.getElementById('sidebar').getBoundingClientRect().width, page:window.__probe.pages[0].getBoundingClientRect().width}));
      for (const mod of ['Meta','Control']) {
        await palette('zoom 1');
        const a=await sizes();
        await blurToDocument(); await page.keyboard.press(mod+'+Equal'); await settle();
        const b=await sizes();
        record(mod+' plus zooms pages without changing sidebar width', b.page>a.page && near(a.sidebar,b.sidebar));
        await page.keyboard.press(mod+'+Minus'); await settle();
        const c=await sizes();
        record(mod+' minus shrinks pages without changing sidebar width', c.page<b.page && near(a.sidebar,c.sidebar));
        await page.keyboard.press(mod+'+Digit0'); await settle();
        record(mod+' 0 restores auto zoom', await probe(() => Object.keys(localStorage).some(k=>k.startsWith('pdf2html-zoom:') && localStorage[k]==='auto')));
      }
      await page.keyboard.press('Escape');
      await palette('dark');
      record(':dark enables dark pages', await probe(() => document.body.classList.contains('pdf2html-dark-pages')));
      if (reader) record('[reader] text remains transparent in dark mode', await probe(() => getComputedStyle(document.querySelector('.t')).color === 'rgba(0, 0, 0, 0)'));
      await palette('dark');
      record(':dark disables dark pages', !await probe(() => document.body.classList.contains('pdf2html-dark-pages')));
      await palette('counter brief');
      record(':counter brief hides the persistent counter', await probe(() => localStorage.getItem('pdf2html-pageno-brief')==='1' && document.body.classList.contains('pageno-hidden')));
      await palette('5');
      record('brief counter flashes on page change', await probe(() => document.body.classList.contains('pageno-flash')));
      await page.waitForTimeout(1800);
      record('brief counter flash expires', !await probe(() => document.body.classList.contains('pageno-flash')));
      await probe(() => {const r=document.createRange(); r.selectNodeContents(window.__probe.page(5).querySelector('.t')); getSelection().removeAllRanges(); getSelection().addRange(r);});
      // Palette opening must preserve the selected quote.
      await page.keyboard.press(':'); await page.keyboard.type('yank quote'); await page.keyboard.press('Enter');
      await page.waitForTimeout(300);
      const quote=await probe(() => window.__probe.clips.at(-1)||'');
      record(':yank quote copies selection and page reference', quote.includes('Page 5 heading') && quote.includes('5'));
      record('copy toast is visible and accessible', await probe(() => {const t=document.getElementById('pdf2html-toast'); return t && t.classList.contains('shown') && t.getAttribute('role')==='status' && /copied/i.test(t.textContent);}));
      await page.waitForTimeout(2000);
      record('toast expires', !await probe(() => document.getElementById('pdf2html-toast').classList.contains('shown')));
      await palette('5'); await palette('mark b'); await palette('zoom 1.5'); await palette('12');
      await page.waitForTimeout(1500);
      const hash = /^\/(?:r\/)?([a-f0-9]+)\//.exec(new globalThis.URL(URL).pathname)[1];
      const state = await (await context.request.get(BASE+'/entry/'+hash+'/state')).json();
      record('daemon stores position, zoom and marks', state.position?.value.page===12 && state.zoom?.value==='1.5' && state.marks?.value.b.page===5);
      await page.goto(BASE+'/healthz', {waitUntil:'networkidle'});
      await page.evaluate(() => localStorage.clear());
      await load();
      record('daemon restores position without localStorage', near(await pageTop(12),PAGE_LEAD));
      record('daemon restores zoom without localStorage', near(await probe(() => window.__probe.zoomVar()),1.5,.001));
      await palette('jump b');
      record('daemon restores marks without localStorage', near(await pageTop(5),PAGE_LEAD));
    }
  }

  // ===================================================================== geometry
  if (run('geometry')) {
    await load({ reset: true });
    const placement = await probe(() => {
      const p = window.__probe;
      return {
        scrollerZoom: getComputedStyle(p.pc).zoom,
        pageZoom: getComputedStyle(p.pages[0]).zoom,
        clientHeight: p.pc.clientHeight,
        boxHeight: p.pc.getBoundingClientRect().height,
      };
    });
    record('scroller carries no zoom', placement.scrollerZoom === '1',
      `#page-container zoom=${placement.scrollerZoom}, .pf zoom=${placement.pageZoom}`);
    record('scroller clientHeight is screen px', near(placement.clientHeight, placement.boxHeight, 1),
      `clientHeight=${placement.clientHeight}, visible height=${placement.boxHeight}`);

    await probe(() => window.__probe.scrollToPage(2, 0.2));
    const steps = await probe(async () => {
      const p = window.__probe;
      const pf = p.page(3);
      const a = pf.getBoundingClientRect().top;
      p.pc.scrollBy({ top: 60, behavior: 'instant' });
      await p.frames();
      const b = pf.getBoundingClientRect().top;
      p.pc.scrollBy({ top: 0.5 * p.pc.clientHeight, behavior: 'instant' });
      await p.frames();
      const c = pf.getBoundingClientRect().top;
      return { j: a - b, d: b - c, half: p.pc.getBoundingClientRect().height / 2 };
    });
    record('j step (scrollBy 60) moves 60 screen px', near(steps.j, 60), `moved ${steps.j.toFixed(1)} px`);
    record('d step (half clientHeight) moves half the viewport', near(steps.d, steps.half),
      `moved ${steps.d.toFixed(1)} px of ${steps.half.toFixed(1)} px`);

    const links = await probe(async () => {
      const p = window.__probe;
      const out = [];
      for (const a of p.pc.querySelectorAll('a.l[data-dest-detail], a.l[data-reader-dest]')) {
        if (out.length >= 4) break;
        if (!p.destY(a)) continue;
        p.pc.scrollTop = 0;
        await p.frames();
        a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await p.frames();
        out.push(p.destY(a));
      }
      history.replaceState(null, '', location.pathname);
      return out;
    });
    if (!links.length) record('internal links land at viewport top', true, 'skipped: no XYZ links');
    else {
      const bad = links.filter((l) => !l.atEnd && !near(l.y, 0, 2));
      record('internal links land at viewport top', bad.length === 0,
        links.map((l) => `${l.page}:${l.y.toFixed(1)}`).join(' '));
    }

    await probe(() => window.__probe.scrollToPage(4, 0.6));
    await page.waitForTimeout(200);
    const current = await probe(() => ({
      runtime: window.pdf2htmlEX ? window.pdf2htmlEX.defaultViewer.cur_page_idx + 1 : null,
      overlap: window.__probe.mostVisible(),
      counter: +document.getElementById('pdf2html-pageno-current').textContent,
    }));
    record(reader ? '[reader] counter matches viewport overlap' : '[pdf2htmlEX] current page matches viewport overlap', (reader ? current.counter : current.runtime) === current.overlap,
      `runtime=${current.runtime}, overlap=${current.overlap}`);

    const zoomCase = async (label, act) => {
      await probe(() => window.__probe.scrollToPage(5, 0.37));
      await settle();
      const a = await probe(() => window.__probe.anchor());
      await act();
      await page.waitForTimeout(250);
      await settle();
      const b = await probe(() => window.__probe.anchor());
      const ok = a && b && a.id === b.id && Math.abs(a.frac - b.frac) < 0.01;
      record(`${label} keeps reading position`, ok,
        `${a && a.id}@${a && a.frac.toFixed(3)} -> ${b && b.id}@${b && b.frac.toFixed(3)}`);
    };
    await zoomCase(':zoom 1.2', () => palette('zoom 1.2'));
    record(':zoom 1.2 applies the zoom', near(await probe(() => window.__probe.zoomVar()), 1.2, 0.001));
    await zoomCase(':zoom auto', () => palette('zoom auto'));
    const autoZoom = await probe(() => window.__probe.zoomVar());
    await zoomCase('Cmd+= (page zoom; pdf2htmlEX also keeps its private scale at 1)', async () => { await blurToDocument(); await page.keyboard.press('Meta+Equal'); });
    const plus = await probe(() => ({ z: window.__probe.zoomVar(), scale: (window.pdf2htmlEX ? window.pdf2htmlEX.defaultViewer.scale : 1) }));
    record('Cmd+= raises the one page zoom', plus.z > autoZoom + 0.01 && plus.scale === 1,
      `zoom ${autoZoom.toFixed(3)} -> ${plus.z.toFixed(3)}, pdf2htmlEX scale ${plus.scale}`);
    await zoomCase('Cmd+0 (back to auto-fit)', async () => { await page.keyboard.press('Meta+Digit0'); });
    record('Cmd+0 restores auto-fit', near(await probe(() => window.__probe.zoomVar()), autoZoom, 0.001));
    await zoomCase('window resize (auto)', () => page.setViewportSize({ width: 1100, height: 1000 }));
    await page.setViewportSize(VIEWPORT);
    await page.waitForTimeout(250);

    await page.keyboard.press('Meta+b');
    await page.waitForTimeout(900);
    const shift = await probe(() => {
      const sb = document.getElementById('sidebar').getBoundingClientRect();
      const pf = window.__probe.pages[0].getBoundingClientRect();
      return {
        shown: document.body.classList.contains('sidebar-shown'),
        shifted: document.body.classList.contains('pdf2html-page-shifted'),
        gap: pf.left - sb.right,
      };
    });
    if (!shift.shown) record('sidebar shift leaves 14 px gutter', false, 'sidebar did not open');
    else if (!shift.shifted) record('sidebar shift leaves 14 px gutter', shift.gap >= 14 - TOL, `no shift needed, gap ${shift.gap.toFixed(1)} px`);
    else record('sidebar shift leaves 14 px gutter', near(shift.gap, 14), `gap ${shift.gap.toFixed(1)} px`);
  }

  // =================================================================== navigation
  if (run('navigation')) {
    await load({ reset: true });
    const pageTop = (n) => probe((k) => window.__probe.pageTop(window.__probe.page(k)), n);

    const p1 = pick(42, 5);
    await palette(String(p1));
    record(`:${p1} lands the page top at the lead`, near(await pageTop(p1), PAGE_LEAD), `top ${(await pageTop(p1)).toFixed(1)} px`);

    await palette('mark a');
    await palette(String(pick(120, 1)));
    await palette('jump a');
    record(':jump returns to the marked page', near(await pageTop(p1), PAGE_LEAD),
      `top ${(await pageTop(p1)).toFixed(1)} px, marks ${await probe(() => JSON.stringify(Object.keys(localStorage).filter((k) => k.startsWith('pdf2html-marks')).map((k) => localStorage.getItem(k))))}`);

    await blurToDocument();
    await page.keyboard.press('e');
    await settle();
    record('e lands the next page at the lead', near(await pageTop(p1 + 1), PAGE_LEAD), `top ${(await pageTop(p1 + 1)).toFixed(1)} px`);
    await page.keyboard.press('3');
    await page.keyboard.press('q');
    await settle();
    record('3q steps back three pages', near(await pageTop(p1 - 2), PAGE_LEAD), `top ${(await pageTop(p1 - 2)).toFixed(1)} px`);

    // Chapter navigation lands on the outline destination.
    const chapter = await probe(() => {
      const p = window.__probe;
      const links = p.outlineLinks();
      return links.length > 3 ? { idx: Math.floor(links.length / 2), text: links[Math.floor(links.length / 2)].textContent.trim() } : null;
    });
    if (chapter) {
      await palette('chapter ' + chapter.text);
      const hit = await probe((i) => window.__probe.destY(window.__probe.outlineLinks()[i]), chapter.idx);
      record(':chapter lands its heading at the viewport top', hit && (hit.atEnd || near(hit.y, 0, 2)),
        hit ? `${hit.page} destination at ${hit.y.toFixed(1)} px` : 'no destination');
      await blurToDocument();
      await page.keyboard.press('c');
      await settle();
      const next = await probe((i) => {
        const p = window.__probe;
        const links = p.outlineLinks();
        const cur = links[i];
        const curPage = parseInt(cur.getAttribute('href').slice(3), 16);
        const nxt = links.slice(i + 1).find((a) => parseInt(a.getAttribute('href').slice(3), 16) > curPage);
        return nxt ? p.destY(nxt) : null;
      }, chapter.idx);
      record('c lands the next chapter heading at the viewport top', !next || next.atEnd || near(next.y, 0, 2),
        next ? `${next.page} destination at ${next.y.toFixed(1)} px` : 'no later chapter');

      await page.keyboard.press('Meta+k');
      await page.waitForSelector('#pdf2html-finder-input');
      await page.keyboard.type(chapter.text);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(150);
      await settle();
      const finderHit = await probe((i) => window.__probe.destY(window.__probe.outlineLinks()[i]), chapter.idx);
      record('Cmd-K outline pick lands its heading at the viewport top', finderHit && (finderHit.atEnd || near(finderHit.y, 0, 2)),
        finderHit ? `${finderHit.page} destination at ${finderHit.y.toFixed(1)} px` : 'no destination');
    }

    // Resume: leave the reader on a page, reload, expect that page at the lead.
    const p3 = pick(77, 3);
    await palette(String(p3));
    await page.waitForTimeout(700);
    await load();
    await page.waitForTimeout(300);
    record('reload resumes the saved page at the lead', near(await pageTop(p3), PAGE_LEAD), `p.${p3} top ${(await pageTop(p3)).toFixed(1)} px`);
  }

  // ====================================================================== sidebar
  if (run('sidebar')) {
    await load({ reset: true });
    await page.keyboard.press('Meta+b');
    await page.waitForTimeout(500);
    const hasOutline = (await probe(() => window.__probe.outlineLinks().length)) > 2;
    // Outline tab: Ctrl-j twice, Enter.
    await page.locator('[data-tab=outline]').click();
    await page.keyboard.press('Control+j');
    await page.keyboard.press('Control+j');
    const selected = await probe(() => {
      const s = document.querySelector('#outline a.pdf2html-selected');
      return s ? window.__probe.outlineLinks().indexOf(s) : -1;
    });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);
    await settle();
    const outlineCommit = await probe((i) => {
      const p = window.__probe;
      const link = p.outlineLinks()[i];
      return { dest: link ? p.destY(link) : null, active: p.activeOutline().map((a) => a.textContent.trim()) };
    }, selected);
    if (!hasOutline) {
      record('outline Enter lands the entry heading at the viewport top', true, 'skipped: no outline');
    } else {
      record('outline Enter lands the entry heading at the viewport top',
        !!outlineCommit.dest && (outlineCommit.dest.atEnd || near(outlineCommit.dest.y, 0, 2)),
        outlineCommit.dest ? `${outlineCommit.dest.page} destination at ${outlineCommit.dest.y.toFixed(1)} px` : `selected index ${selected}`);
      record('exactly one outline row is active', outlineCommit.active.length === 1, JSON.stringify(outlineCommit.active));
    }

    // Thumbnails tab: from the current page, Ctrl-j twice, Enter.
    await page.keyboard.press('Control+ArrowRight');
    await page.waitForTimeout(200);
    const start = await probe(() => window.__probe.mostVisible());
    await page.keyboard.press('Control+j');
    await page.keyboard.press('Control+j');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);
    await settle();
    const thumbTop = await probe((n) => window.__probe.pageTop(window.__probe.page(n)), start + 2);
    record('thumbnail Enter lands the page at the lead', near(thumbTop, PAGE_LEAD), `p.${start + 2} top ${thumbTop.toFixed(1)} px`);

    const thumbPage = pick(9, 3);
    await probe((n) => document.querySelector(`.pdf2html-thumb[data-page="${n}"]`).click(), thumbPage);
    await page.waitForTimeout(150);
    await settle();
    const clickTop = await probe((n) => window.__probe.pageTop(window.__probe.page(n)), thumbPage);
    record('thumbnail click lands the page at the lead', near(clickTop, PAGE_LEAD), `p.${thumbPage} top ${clickTop.toFixed(1)} px`);

    // A plain scroll afterwards still drives a single active outline row.
    await probe((n) => window.__probe.scrollToPage(n, 0.1), pick(200, 1));
    await page.waitForTimeout(300);
    const afterScroll = await probe(() => window.__probe.activeOutline().length);
    if (hasOutline) record('outline highlight stays single after scrolling', afterScroll === 1, `${afterScroll} active`);

    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    record('Esc closes the sidebar', !(await probe(() => document.body.classList.contains('sidebar-shown'))));
  }

  // ===================================================================== commands
  if (run('commands')) {
    await load({ reset: true });
    await palette('cursorpin');
    const pin = await probe(() => ({
      stored: localStorage.getItem('pdf2html-pinned'),
      css: document.getElementById('page-container').style.getPropertyValue('--pdf2html-scrolloff'),
    }));
    record(':cursorpin toggles pin-to-center off', pin.stored === '0' && pin.css.trim() === '25%', JSON.stringify(pin));
    await palette('so 10');
    const so = await probe(() => ({
      stored: localStorage.getItem('pdf2html-scrolloff'),
      css: document.getElementById('page-container').style.getPropertyValue('--pdf2html-scrolloff'),
    }));
    record(':so 10 sets the scrolloff band', so.stored === '0.1' && so.css.trim() === '10%', JSON.stringify(so));
    await palette('counter');
    record(':counter shows the page counter', !(await probe(() => document.body.classList.contains('pageno-hidden'))));
    await palette('case');
    record(':case turns case-sensitive search on', (await probe(() => localStorage.getItem('pdf2html-search-case'))) === '1');
    await palette('zoom 1.5');
    await load();
    record(':zoom persists per document', near(await probe(() => window.__probe.zoomVar()), 1.5, 0.001));

    const yankPage = pick(30, 2);
    await probe((n) => window.__probe.scrollToPage(n, 0.2), yankPage);
    await page.waitForTimeout(300);
    await palette('yank ref');
    const clip = await probe(() => window.__probe.clips.slice(-1)[0] || '');
    record(':yank ref copies chapter and page', clip.endsWith('p. ' + yankPage), JSON.stringify(clip));

    // Settings modal reflects and edits the same preferences.
    await blurToDocument();
    await page.keyboard.press('Meta+Comma');
    await page.waitForSelector('#pdf2html-settings');
    const settings = await probe(() => ({
      zoom: document.querySelector('#pdf2html-settings input[type=range]').value,
      switches: Array.from(document.querySelectorAll('#pdf2html-settings .pdf2html-switch')).map((s) => s.getAttribute('aria-checked')),
    }));
    record('settings show the effective zoom', settings.zoom === '1.5', JSON.stringify(settings));
    await probe(() => {
      const rows = Array.from(document.querySelectorAll('#pdf2html-settings .pdf2html-settings-row'));
      const row = rows.find((r) => /Case-sensitive/.test(r.textContent));
      row.querySelector('.pdf2html-switch').click();
    });
    record('settings switch writes the preference', (await probe(() => localStorage.getItem('pdf2html-search-case'))) === '0');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    record('Esc closes settings', !(await probe(() => !!document.getElementById('pdf2html-settings'))));

    // Cheatsheet lists every palette command and no removed ones.
    await page.keyboard.press('?');
    await page.waitForSelector('#pdf2html-cheatsheet');
    const sheet = await probe(() => document.getElementById('pdf2html-cheatsheet').textContent);
    const names = ['page', 'chapter', 'next', 'prev', 'mark', 'jump', 'clear', 'open', 'rename', 'path',
      'disable', 'delete', 'pin', 'scrolloff', 'yank', 'finger', 'counter', 'case', 'zoom', 'set', 'help'];
    const missing = names.filter((n) => sheet.indexOf(':' + n) === -1);
    const stale = [':buffer', ':all', 'render-all'].filter((s) => sheet.indexOf(s) !== -1);
    record('cheatsheet lists every command', missing.length === 0, missing.length ? `missing ${missing.join(' ')}` : '');
    record('cheatsheet lists no removed commands', stale.length === 0, stale.join(' '));
    await page.keyboard.press('Escape');
  }

  // ======================================================================= search
  if (run('search')) {
    await load({ reset: true, prefs: { 'pdf2html-pinned': '0', 'pdf2html-scrolloff': '0.25' } });
    const word = await probe(async (n) => {
      const p = window.__probe;
      const lines = Array.from(p.page(n).querySelectorAll('.t'));
      const t = lines.find((e) => /[A-Za-zæøå]{7,}/.test(e.textContent));
      const w = t.textContent.match(/[A-Za-zæøå]{7,}/)[0];
      p.pc.scrollTop += t.getBoundingClientRect().top - p.pc.getBoundingClientRect().top - (p.pc.clientHeight - 40);
      await p.settle();
      return w;
    }, pick(14, 1));
    await blurToDocument();
    await page.keyboard.press('/');
    await page.waitForSelector('#pdf2html-search-input');
    await page.keyboard.type(word);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);
    await settle();
    const hit = await probe(() => {
      const pc = window.__probe.pc;
      const sel = getSelection();
      const r = sel.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null;
      return { y: r && r.top - pc.getBoundingClientRect().top, h: pc.clientHeight, text: sel.toString() };
    });
    record('search Enter selects a hit inside the scrolloff band',
      hit.y !== null && hit.y >= hit.h * 0.25 - 2 && hit.y <= hit.h * 0.75 + 2,
      `"${hit.text}" at ${hit.y && hit.y.toFixed(1)} of ${hit.h}`);
    await page.keyboard.press('n');
    await settle();
    const count = await probe(() => {
      const el = document.getElementById('pdf2html-search-count');
      return { text: getSelection().toString(), entered: document.body.classList.contains('pdf2html-search-entered') };
    });
    record('n moves to another hit', count.entered && count.text.toLowerCase() === word.toLowerCase(), JSON.stringify(count));
    await page.keyboard.press('Escape');
  }

  if (run('pins')) {
    await load({reset:true});
    await page.keyboard.press('Control+Shift+P');
    record('pin chord drops a numbered pin and toast', await page.locator('.pdf2html-pin-marker').count() === 1 && /Pin 1/.test(await page.locator('#pdf2html-toast').innerText()));
    const quote = await probe(() => {const t=document.querySelector('#pf1 .t'),r=document.createRange();r.selectNodeContents(t);getSelection().removeAllRanges();getSelection().addRange(r);return t.textContent.trim();});
    await page.keyboard.press('Control+Shift+P');
    await palette('pins');
    record('selection supplies a single-line pin title', (await page.locator('.pdf2html-pin-copy strong').nth(1).innerText()).includes(quote));
    await page.keyboard.press('Control+j'); await page.keyboard.press('Enter');
    record('Pins keyboard selector commits the second row', await page.locator('.pdf2html-pin-row').count()===2);
    await palette('unpin 2'); await page.keyboard.press('Escape');
    const before = await probe(() => window.__probe.anchor());
    await palette('page 8');
    await page.keyboard.press('Control+Shift+O'); await settle();
    const after = await probe(() => window.__probe.anchor());
    record('latest-pin chord restores exact anchor', before.id===after.id && near(before.frac,after.frac,.005));
    await page.keyboard.press('Meta+z'); await settle();
    record('pin jump records a single undo', await probe(() => window.__probe.mostVisible())===8);
    await palette('pins');
    record('Pins third tab shows thumbnail and remove control', await page.locator('.pdf2html-pin-jump img').count()===1 && await page.locator('.pdf2html-pin-remove').count()===1);
    if (process.env.PDFV_SCREENSHOTS) { await page.locator('.pdf2html-pin-jump').click(); await settle(); await page.waitForTimeout(500); await page.screenshot({path:process.env.PDFV_SCREENSHOTS+'/pins.png'}); }
    await page.locator('.pdf2html-pin-remove').click();
    record('remove leaves an explanatory empty state', /:pin/.test(await page.locator('#pdf2html-pins').innerText()));
    if (process.env.PDFV_SCREENSHOTS) await page.screenshot({path:process.env.PDFV_SCREENSHOTS+'/pins-empty.png'});
    await page.keyboard.press('Escape');
    await palette('page 1'); await page.keyboard.press('Control+Shift+P');
    await page.waitForTimeout(1100);
    await probe(() => localStorage.clear());
    await page.reload(); await page.waitForSelector('.pdf2html-pin-marker');
    record('daemon restores pin after clearing localStorage', await page.locator('.pdf2html-pin-marker').count()===1);
    if (process.env.PDFV_SCREENSHOTS) await page.screenshot({path:process.env.PDFV_SCREENSHOTS+'/pin-marker.png'});
  }
  if (run('hierarchy') && reader) {
    // Generated shell only: replace its outline before the model reads it.
    await page.route(URL, async route => {
      const r = await route.fetch(); let html = await r.text();
      const children = Array.from({length:1998}, (_,i)=>'<li><a href="#pf8">Detail '+i+'</a></li>').join('');
      html = html.replace(/<div id="outline">[\s\S]*?<\/div>/, '<div id="outline"><ul><li><a href="#pf1">Chapter</a><ul><li><a href="#pf4">Section</a><ul>'+children+'</ul></li></ul></li></ul></div>');
      await route.fulfill({response:r,body:html});
    });
    async function keyboardCost() {
      return probe(() => {
        const times=[];
        for(let i=0;i<10;i++) {
          const t=performance.now();
          document.getElementById('pdf2html-sidebar-body').dispatchEvent(new KeyboardEvent('keydown',{key:'j',ctrlKey:true,bubbles:true}));
          void document.getElementById('outline').offsetHeight;
          times.push(performance.now()-t);
        }
        return times.sort((a,b)=>a-b)[5];
      });
    }
    if (process.env.PDFV_BASELINE_SIDEBAR) {
      await page.route('**/overlay-sidebar.js*', route=>route.fulfill({contentType:'text/javascript',body:require('fs').readFileSync(process.env.PDFV_BASELINE_SIDEBAR,'utf8')}));
      await load({reset:true}); await page.keyboard.press('Meta+b'); await page.waitForTimeout(300);
      record('2000-entry baseline keyboard median',true,(await keyboardCost()).toFixed(2)+' ms');
      await page.unroute('**/overlay-sidebar.js*');
    }
    const start = Date.now(); await load({reset:true});
    await page.keyboard.press('Meta+b'); await page.waitForTimeout(300);
    record('2000-entry tree starts below level two collapsed', await page.locator('#outline a').count()===2000 && await page.locator('#outline ul[hidden]').count()===1, 'load through mounted sidebar '+(Date.now()-start)+' ms (includes network/raster)');
    if (process.env.PDFV_SCREENSHOTS) await page.screenshot({path:process.env.PDFV_SCREENSHOTS+'/outline-collapsed.png'});
    await page.keyboard.press('h');
    record('h collapses selected outline branch', await page.locator('#outline > ul > li > ul[hidden]').count()===1);
    await page.keyboard.press('l');
    record('l expands selected outline branch', await page.locator('#outline > ul > li > ul[hidden]').count()===0);
    record('2000-entry tree keyboard median',true,(await keyboardCost()).toFixed(2)+' ms');
    const timing = await probe(() => { const b=document.querySelectorAll('.pdf2html-disclosure')[1], t=performance.now(); b.click(); return performance.now()-t; });
    record('2000-entry disclosure stays below 100 ms', timing<100, timing.toFixed(2)+' ms');
    if (process.env.PDFV_SCREENSHOTS) await page.screenshot({path:process.env.PDFV_SCREENSHOTS+'/outline-expanded.png'});
    await page.locator('.pdf2html-disclosure').nth(1).click();
    await page.waitForTimeout(1100); await page.reload(); await page.waitForSelector('.pdf2html-disclosure', {state:'attached'}); await page.evaluate(installProbe);
    record('collapsed state persists', await page.locator('#outline ul[hidden]').count()===1);
    await palette('page 8');
    record('current branch opens automatically', await page.locator('#outline ul[hidden]').count()===0);
    await palette('counter');
    record('counter prefers top-level chapter with deep hover', await page.locator('#pdf2html-pageno').innerText().then(t=>t.includes('Chapter')&&!t.includes('Detail')) && await page.locator('#pdf2html-pageno').getAttribute('title').then(t=>t.includes('Detail')));
    await page.unroute(URL);
  }

  record('no failed asset requests', failedAssets.length===0, failedAssets.join(' | '));
  record('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
}

// A wedged page must fail the run, not hang it.
const HARNESS_TIMEOUT_MS = 5 * 60 * 1000;
setTimeout(() => {
  record('harness finished in time', false, `no result after ${HARNESS_TIMEOUT_MS / 1000}s`);
  console.log('verify-overlay: FAIL — timed out');
  process.exit(1);
}, HARNESS_TIMEOUT_MS).unref();

main()
  .catch((err) => record('harness ran to completion', false, err.stack || String(err)))
  .finally(async () => {
    if (activeBrowser) await activeBrowser.close();
    const failed = results.filter((r) => !r.ok).length;
    console.log(`verify-overlay: ${failed ? 'FAIL' : 'PASS'} — ${results.length - failed}/${results.length} checks`);
    process.exitCode = failed ? 1 : 0;
  });

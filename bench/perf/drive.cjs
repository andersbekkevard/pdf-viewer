#!/usr/bin/env node
/*
 * One perf trial for bench/perf/run.py: one engine, one document, one fresh browser.
 *
 * Usage: drive.cjs <spec.json>   (writes <spec.outDir>/trial.json)
 *
 * The trial journey, identical for both engines:
 *   baseline   about:blank in a fresh browser; physical footprint of every browser process
 *   open-cold  navigate to the document (reader: cache entry deleted by run.py beforehand)
 *   open-warm  close that tab, open the same document again in a new tab
 *   scroll10   wheel events at a fixed schedule through ~10 pages (traced)
 *   jump       type the middle page number and press Enter (reader palette `:n`, native toolbar page field)
 *   scroll5    wheel through ~5 more pages
 *   memory     screencast stopped, 3 s idle, footprint of every browser process (+ daemon tree for the reader)
 *   zoom       one zoom-in step (native toolbar "Zoom in", 125 % -> 150 %; reader ⌘+, the key the owner uses, ×1/0.9)
 *   zoom_burst four zoom-out steps 60 ms apart (native toolbar "Zoom out"; reader ⌘−), timed from the last
 *   memory     footprint again after the zoom phases (memory.afterZoom)
 *
 * Every phase is timed from the screencast: frames are saved with their
 * compositor timestamps and run.py decides from the pixels when the viewport
 * stopped changing. The driver only decides when to stop waiting (no new
 * frame for quietMs, and for the reader also the DOM saying the visible pages
 * hold rasters at device width). Screenshots are private document content:
 * they go to outDir and run.py deletes them after scoring.
 */
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const { chromium } = require('playwright');

const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const out = {
    engine: spec.engine, phases: {}, memory: {}, rasters: [], abortedRasters: 0, errors: [], notes: [],
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FRAMES = path.join(spec.outDir, 'frames');
fs.mkdirSync(FRAMES, { recursive: true });

// ------------------------------------------------------------------ processes
function processTable() {
    const r = spawnSync('ps', ['-axo', 'pid=,ppid=,rss=,command='], { encoding: 'utf8' });
    return r.stdout.split('\n').map((l) => {
        const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
        return m ? { pid: +m[1], ppid: +m[2], rssKiB: +m[3], command: m[4] } : null;
    }).filter(Boolean);
}
function tree(rootPid) {
    const table = processTable();
    const kids = new Map();
    for (const p of table) { if (!kids.has(p.ppid)) kids.set(p.ppid, []); kids.get(p.ppid).push(p); }
    const root = table.find((p) => p.pid === rootPid);
    const list = root ? [root] : [];
    for (let i = 0; i < list.length; i++) for (const c of kids.get(list[i].pid) || []) list.push(c);
    return list;
}
function kind(command) {
    const m = command.match(/--type=([a-z-]+)/);
    if (!m) return command.includes('python') || command.includes('uv') ? 'daemon' : 'browser';
    if (m[1] === 'utility') {
        const s = command.match(/--utility-sub-type=([\w.]+)/);
        return 'utility:' + (s ? s[1].split('.').slice(-2).join('.') : '?');
    }
    if (m[1] === 'renderer' && command.includes('--extension-process')) return 'renderer:extension';
    return m[1];
}
function footprint(pid) {
    const r = spawnSync('footprint', ['-p', String(pid), '-f', 'bytes'], { encoding: 'utf8' });
    const m = `${r.stdout || ''}${r.stderr || ''}`.match(/^\s*phys_footprint:\s*(\d+)\s+B\s*$/m);
    return m ? Number(m[1]) : null;
}
function measureTree(rootPid) {
    const procs = tree(rootPid).map((p) => ({ pid: p.pid, kind: kind(p.command), rssKiB: p.rssKiB, footprint: footprint(p.pid) }));
    return { total: procs.reduce((s, p) => s + (p.footprint || 0), 0), missing: procs.filter((p) => p.footprint === null).length, procs };
}

// ------------------------------------------------------------- native server
// The native viewer gets the PDF over loopback HTTP with range support, as a web server would serve it.
function startServer() {
    if (spec.engine !== 'native') return null;
    const size = fs.statSync(spec.pdfPath).size;
    const server = http.createServer((req, res) => {
        if (!req.url.startsWith('/doc.pdf')) { res.writeHead(404); res.end(); return; }
        const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
        const headers = { 'content-type': 'application/pdf', 'accept-ranges': 'bytes', 'cache-control': 'no-cache' };
        if (range) {
            const start = range[1] ? +range[1] : size - +range[2];
            const end = range[1] && range[2] ? Math.min(+range[2], size - 1) : size - 1;
            res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
            fs.createReadStream(spec.pdfPath, { start, end }).pipe(res);
        } else {
            res.writeHead(200, { ...headers, 'content-length': size });
            fs.createReadStream(spec.pdfPath).pipe(res);
        }
    });
    // Port 0 (the default) takes a free port, so parallel benches never collide.
    return new Promise((resolve) => server.listen(spec.nativePort || 0, '127.0.0.1', () => resolve(server)));
}

// ---------------------------------------------------------- in-page helpers
// Reader only: are the pages under the content region holding rasters at
// their exact device width? Used to decide when to stop waiting and recorded
// as the DOM signal that validates the pixel signal.
const READER_CRISP = (region) => {
    const root = document.getElementById('page-container');
    if (!root) return { ok: false, why: 'no-container' };
    const dpr = window.devicePixelRatio || 1;
    const seen = new Set();
    const x = innerWidth * (region.x0 + region.x1) / 2;
    for (let i = 0; i <= 8; i++) {
        const y = innerHeight * (region.y0 + (region.y1 - region.y0) * i / 8);
        for (const el of document.elementsFromPoint(x, y)) {
            const pf = el.closest && el.closest('.pf');
            if (pf) { seen.add(pf); break; }
        }
    }
    if (!seen.size) return { ok: false, why: 'no-page' };
    for (const pf of seen) {
        if (pf.dataset.pdf2htmlRasterState !== 'ready') return { ok: false, why: 'state:' + pf.dataset.pdf2htmlRasterState };
        const img = pf.querySelector('img.bi');
        const want = Math.round(pf.getBoundingClientRect().width * dpr);
        if (!img || !img.complete || Math.abs(img.naturalWidth - want) > 3) {
            return { ok: false, why: `width ${img && img.naturalWidth} want ${want}` };
        }
    }
    return { ok: true, pages: [...seen].map((pf) => parseInt(pf.dataset.pageNo, 16)) };
};

async function readerVisiblePage(page) {
    return page.evaluate(() => {
        // The page covering the viewport's vertical centre (or the nearest one).
        const pfs = document.querySelectorAll('#page-container > .pf');
        const mid = innerHeight / 2;
        let lo = 0, hi = pfs.length - 1;
        while (lo < hi) {
            const m = (lo + hi) >> 1;
            if (pfs[m].getBoundingClientRect().bottom < mid) lo = m + 1; else hi = m;
        }
        const best = pfs.length ? parseInt(pfs[lo].dataset.pageNo, 16) : null;
        return { page: best, zoom: parseFloat(getComputedStyle(document.getElementById('page-container')).getPropertyValue('--pdf2html-zoom')) };
    }).catch(() => null);
}
function nativeFrame(page) {
    return page.frames().find((f) => f.url().startsWith('chrome-extension://'));
}
async function nativeState(page) {
    const ext = nativeFrame(page);
    if (!ext) return null;
    return ext.evaluate(() => {
        const sr = document.querySelector('pdf-viewer') && document.querySelector('pdf-viewer').shadowRoot;
        const ts = sr && sr.querySelector('viewer-toolbar') && sr.querySelector('viewer-toolbar').shadowRoot;
        const ps = ts && ts.querySelector('viewer-page-selector');
        const pin = ps && ps.shadowRoot && ps.shadowRoot.querySelector('input');
        const zin = ts && [...ts.querySelectorAll('input')].find((i) => /%$/.test(i.value));
        const sidenav = sr && sr.querySelector('viewer-pdf-sidenav');
        return {
            page: pin ? +pin.value : null, zoom: zin ? zin.value : null,
            sidenav: sidenav ? sidenav.getBoundingClientRect().width : null,
        };
    }).catch(() => null);
}

// ------------------------------------------------------------- input clock
// Playwright spends tens of ms between being asked for a key or click and the
// event reaching the page (actionability checks, scrolling, CDP round trips),
// and more for a click into the native viewer's frame than for a key. Latency
// is therefore timed from the event itself: a capture listener in the frame
// that receives the input records performance.timeOrigin + event.timeStamp,
// the same epoch clock as the screencast's frame timestamps.
const INPUT_CLOCK = () => {
    if (window.__pdfvInputs) return;
    window.__pdfvInputs = [];
    for (const type of ['keydown', 'pointerdown']) {
        window.addEventListener(type, (e) => {
            window.__pdfvInputs.push({ type, key: e.key || null, t: performance.timeOrigin + e.timeStamp });
        }, true);
    }
};
// The frame that gets the input: the reader's document, or the native viewer's extension frame.
function inputFrame(page) {
    return spec.engine === 'native' ? (nativeFrame(page) || page.mainFrame()) : page.mainFrame();
}
async function armInputClock(page) {
    await inputFrame(page).evaluate(INPUT_CLOCK).catch(() => {});
}
// Input events of `type` at or after wall-clock t0 (5 ms slack for clock rounding).
async function inputsSince(page, t0, type, key) {
    const all = await inputFrame(page).evaluate(() => window.__pdfvInputs || []).catch(() => []);
    return all.filter((e) => e.t >= t0 - 5 && e.type === type && (!key || e.key === key)).map((e) => e.t);
}

// ------------------------------------------------------------------ main
let browserRef = null;
async function main() {
    const server = await startServer();
    out.serverClose = () => server && server.close();
    const args = [`--window-size=${spec.window.width},${spec.window.height}`,
        `--window-position=${spec.windowPosition.x},${spec.windowPosition.y}`, `--force-device-scale-factor=${spec.dpr}`];
    if (spec.headless) args.push('--headless=new');
    const browser = await chromium.launch({ executablePath: spec.chromium, headless: false, args });
    browserRef = browser;
    // The browser process is this driver's direct child (Playwright launches it over a pipe).
    const own = processTable().filter((p) => p.ppid === process.pid && !/--type=/.test(p.command) && p.command.includes(path.basename(spec.chromium)));
    if (own.length !== 1) throw new Error(`browser process: ${own.length} candidates`);
    const browserPid = own[0].pid;
    out.browserVersion = browser.version();
    out.mode = spec.headless ? 'new-headless' : 'headed';
    const context = await browser.newContext({ viewport: null, serviceWorkers: 'block' });
    await context.addInitScript((zoom) => {
        try { localStorage.setItem('pdf2html-zoom', String(zoom)); } catch (e) { /* ignore */ }
    }, spec.readerZoom);
    // Frame pump: the screencast only captures when the top-level document
    // submits a compositor frame, so a repaint inside the native viewer's
    // out-of-process PDF frame can go uncaptured. A 4 px compositor-only
    // opacity animation, too faint to change any pixel, in the top-level document (both engines, outside the
    // compared region) makes every vsync capturable. It is switched off for
    // the traced scroll and the memory idle.
    await context.addInitScript(() => {
        if (window.top !== window) return;
        window.__pdfvPump = (on) => {
            let el = document.getElementById('__pdfv_pump');
            if (!on) { if (el) el.remove(); return; }
            if (el || !document.documentElement) return;
            const st = document.createElement('style');
            st.textContent = '@keyframes __pdfv_pump{from{opacity:.001}to{opacity:.002}}';
            el = document.createElement('div');
            el.id = '__pdfv_pump';
            el.style.cssText = 'position:fixed;right:0;bottom:0;width:4px;height:4px;background:#777;z-index:2147483647;'
                + 'pointer-events:none;will-change:opacity;animation:__pdfv_pump .2s linear infinite alternate';
            el.appendChild(st);
            document.documentElement.appendChild(el);
        };
        // A blinking caret (native page field, reader palette) would change
        // the frame every 500 ms and never let a phase look settled.
        const caret = () => {
            const st = document.createElement('style');
            st.textContent = ':root,*{caret-color:transparent!important}';
            document.documentElement.appendChild(st);
        };
        const start = () => { caret(); window.__pdfvPump(true); };
        if (document.documentElement) start();
        else document.addEventListener('readystatechange', start, { once: true });
    });
    const pump = (page, on) => page.evaluate((v) => window.__pdfvPump && window.__pdfvPump(v), on).catch(() => {});

    const frames = [];         // {t: compositor ms epoch, arrived, file, w, h}
    const writes = [];
    // Only frames whose JPEG differs from the previous one are kept: with the
    // pump running, identical frames arrive every vsync and mean "no change".
    let cdp = null, frameSeq = 0, lastArrival = 0, screencasting = false, lastHash = null;
    out.framesReceived = 0;
    const crypto = require('crypto');
    const startScreencast = async (page) => {
        cdp = await context.newCDPSession(page);
        lastHash = null;
        cdp.on('Page.screencastFrame', (f) => {
            cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
            out.framesReceived += 1;
            const hash = crypto.createHash('sha1').update(f.data).digest('hex');
            if (hash === lastHash) return;
            lastHash = hash;
            lastArrival = Date.now();
            const file = path.join(FRAMES, `${String(++frameSeq).padStart(5, '0')}.jpg`);
            frames.push({ t: f.metadata.timestamp * 1000, arrived: lastArrival, file });
            writes.push(fs.promises.writeFile(file, Buffer.from(f.data, 'base64')));
        });
        await cdp.send('Page.startScreencast', {
            format: 'jpeg', quality: spec.jpegQuality, maxWidth: spec.window.width * spec.dpr, maxHeight: spec.window.height * spec.dpr,
        });
        screencasting = true;
    };
    const stopScreencast = async () => {
        if (cdp && screencasting) await cdp.send('Page.stopScreencast').catch(() => {});
        screencasting = false;
    };

    const rasterRe = /\/r\/[0-9a-f]+\/p\/(\d+)\/(\d+)\.png$/;
    const watch = (page) => {
        page.on('requestfinished', async (req) => {
            const m = rasterRe.exec(new URL(req.url()).pathname);
            if (!m) return;
            const t = req.timing();
            const sizes = await req.sizes().catch(() => null);
            const resp = await req.response().catch(() => null);
            out.rasters.push({
                page: +m[1], width: +m[2], t: t.startTime, ms: t.responseEnd >= 0 ? Math.round(t.responseEnd) : null,
                bytes: sizes ? sizes.responseBodySize : null, status: resp ? resp.status() : null,
                fromCache: resp ? resp.fromServiceWorker() || (sizes && sizes.responseHeadersSize === 0) : null,
            });
        });
        page.on('requestfinished', async (req) => {
            if (req.resourceType() !== 'document' || !req.frame() || req.frame() !== page.mainFrame()) return;
            const t = req.timing();
            const sizes = await req.sizes().catch(() => null);
            const p = new URL(req.url()).pathname;
            out.documents = out.documents || [];
            out.documents.push({
                kind: p.startsWith('/read') ? 'read' : p.startsWith('/r/') ? 'shell' : 'pdf',
                t: t.startTime, serverMs: t.responseStart >= 0 ? Math.round(t.responseStart - Math.max(0, t.requestStart)) : null,
                totalMs: t.responseEnd >= 0 ? Math.round(t.responseEnd) : null, bytes: sizes ? sizes.responseBodySize : null,
            });
        });
        page.on('requestfailed', (req) => {
            if (rasterRe.test(new URL(req.url()).pathname)) out.abortedRasters += 1;
        });
        page.on('pageerror', (e) => { if (out.errors.length < 10) out.errors.push(String(e).slice(0, 200)); });
    };

    // Wait until the phase has settled; returns the wall-clock end time.
    const settle = async (page, name, tAction, maxMs, opts = {}) => {
        const quiet = opts.quietMs || spec.quietMs;
        const ph = out.phases[name];
        let domOk = spec.engine !== 'reader';
        while (true) {
            const now = Date.now();
            if (!domOk) {
                const r = await page.evaluate(READER_CRISP, spec.region).catch(() => ({ ok: false }));
                if (r.ok) { domOk = true; ph.domCrispAt = Date.now(); ph.domPages = r.pages; } else ph.domWhy = r.why;
            }
            if (domOk && now - Math.max(lastArrival, tAction) >= quiet && now - tAction >= (opts.minMs || 1000)) break;
            if (now - tAction > maxMs) { ph.timedOut = true; break; }
            await sleep(50);
        }
        ph.tEnd = Date.now();
        // A forced capture of the settled viewport, to check that the last
        // screencast frame really is the final state.
        try {
            const shot = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: spec.jpegQuality });
            ph.finalShot = path.join(FRAMES, `final-${name}.jpg`);
            fs.writeFileSync(ph.finalShot, Buffer.from(shot.data, 'base64'));
        } catch (e) { out.notes.push(`final shot ${name}: ${String(e).slice(0, 100)}`); }
        await sleep(150);   // the capture itself may produce a frame; keep it out of the next phase
    };

    // ---- baseline: empty tab
    let page = await context.newPage();
    await page.goto('about:blank');
    await sleep(spec.baselineIdleMs);
    out.viewport = await page.evaluate(() => ({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio, screenX, screenY }));
    out.memory.baseline = measureTree(browserPid);
    if (spec.daemonPid) out.memory.daemonBefore = measureTree(spec.daemonPid);

    const openUrl = spec.engine === 'reader' ? spec.readUrl
        : `http://127.0.0.1:${server.address().port}/doc.pdf#zoom=${spec.nativeZoom}`;
    const open = async (name, maxMs) => {
        out.phases[name] = { name };
        watch(page);
        await startScreencast(page);
        await sleep(300);
        const t0 = Date.now();
        out.phases[name].tAction = t0;
        const resp = await page.goto(openUrl, { waitUntil: 'commit', timeout: maxMs }).catch((e) => { out.errors.push(String(e).slice(0, 200)); return null; });
        out.phases[name].status = resp ? resp.status() : null;
        await settle(page, name, t0, maxMs, { quietMs: spec.openQuietMs });
        out.phases[name].state = spec.engine === 'reader' ? await readerVisiblePage(page) : await nativeState(page);
        if (spec.engine === 'native' && nativeFrame(page)) {
            await nativeFrame(page).addStyleTag({ content: ':root,*{caret-color:transparent!important}' }).catch(() => {});
        }
    };

    // ---- cold open, then warm open in a new tab
    await open('open_cold', spec.coldMaxMs);
    await stopScreencast();
    await page.close();
    if (spec.engine === 'reader' && spec.stateResetUrl) {
        await fetch(spec.stateResetUrl, { method: 'DELETE' }).catch(() => {});
    }
    page = await context.newPage();
    await open('open_warm', spec.coldMaxMs);

    // ---- held scroll through ~10 pages, traced
    const wheel = async (name, events) => {
        out.phases[name] = { name, events, delta: spec.wheelDelta, intervalMs: spec.wheelIntervalMs };
        const before = spec.engine === 'reader' ? await readerVisiblePage(page) : await nativeState(page);
        await page.mouse.move(spec.pointer.x, spec.pointer.y);
        const traced = name === 'scroll10';
        if (traced) {
            await stopScreencast();
            await pump(page, false);
            await browser.startTracing(page, { path: path.join(spec.outDir, 'scroll-trace.json'), categories: spec.traceCategories });
            await sleep(200);
        }
        const mark = await page.evaluate(() => { performance.mark('pdfv-perf-sync'); return Date.now(); });
        out.phases[name].syncMark = mark;
        await sleep(200);
        const t0 = Date.now();
        out.phases[name].tAction = t0;
        for (let i = 0; i < events; i++) {
            await page.mouse.wheel(0, spec.wheelDelta);
            const wait = t0 + (i + 1) * spec.wheelIntervalMs - Date.now();
            if (wait > 0) await sleep(wait);
        }
        out.phases[name].tLastInput = Date.now();
        if (traced) {
            // No frames are captured here; just let it settle before the next phase.
            await sleep(spec.quietMs * 2);
            out.phases[name].tEnd = Date.now();
            await browser.stopTracing();
            await pump(page, true);
            await startScreencast(page);
            await sleep(300);
        } else {
            await settle(page, name, out.phases[name].tLastInput, spec.phaseMaxMs);
        }
        out.phases[name].before = before;
        out.phases[name].state = spec.engine === 'reader' ? await readerVisiblePage(page) : await nativeState(page);
    };
    await wheel('scroll10', spec.wheelEvents10);

    // ---- far jump to the middle page
    out.phases.jump = { name: 'jump', target: spec.jumpPage };
    if (spec.engine === 'reader') {
        await page.keyboard.press(':');
        await page.waitForSelector('#pdf2html-palette-input', { timeout: 3000 });
        await page.keyboard.type(String(spec.jumpPage));
    } else {
        const input = nativeFrame(page).locator('viewer-page-selector input');
        await input.click();
        await page.keyboard.press('Meta+A');
        await page.keyboard.type(String(spec.jumpPage));
    }
    await sleep(500);
    await armInputClock(page);
    out.phases.jump.tAction = Date.now();
    await page.keyboard.press('Enter');
    out.phases.jump.tInput = (await inputsSince(page, out.phases.jump.tAction, 'keydown', 'Enter'))[0] || null;
    await settle(page, 'jump', out.phases.jump.tAction, spec.phaseMaxMs);
    out.phases.jump.state = spec.engine === 'reader' ? await readerVisiblePage(page) : await nativeState(page);

    // ---- five more pages, then idle and measure memory
    await wheel('scroll5', spec.wheelEvents5);
    await stopScreencast();
    await pump(page, false);
    await sleep(spec.idleMs);
    out.memory.after = measureTree(browserPid);
    if (spec.daemonPid) out.memory.daemonAfter = measureTree(spec.daemonPid);
    if (spec.engine === 'reader') {
        out.readerDom = await page.evaluate(() => {
            const pfs = [...document.querySelectorAll('#page-container > .pf')];
            let decoded = 0, withSrc = 0;
            for (const img of document.querySelectorAll('img.bi[src]')) {
                withSrc += 1;
                if (img.complete) decoded += img.naturalWidth * img.naturalHeight * 4;
            }
            const states = {};
            for (const pf of pfs) { const s = pf.dataset.pdf2htmlRasterState || 'none'; states[s] = (states[s] || 0) + 1; }
            return {
                pages: pfs.length, states, imagesWithSrc: withSrc, decodedBytesEstimate: decoded,
                textLines: document.querySelectorAll('.pc > .t').length, domNodes: document.getElementsByTagName('*').length,
                jsHeap: performance.memory ? performance.memory.usedJSHeapSize : null,
            };
        }).catch((e) => ({ error: String(e).slice(0, 200) }));
    } else {
        out.nativeState = await nativeState(page);
    }

    // ---- one zoom-in step, then a burst of zoom-out steps
    // The reader gets the key its owner presses (⌘+ / ⌘−, overlay.js); the
    // native viewer its toolbar buttons (its next preset). Playwright's
    // synthetic keys reach the page's handlers, never browser zoom.
    await pump(page, true);
    await startScreencast(page);
    await sleep(500);
    const stateNow = () => (spec.engine === 'reader' ? readerVisiblePage(page) : nativeState(page));
    const zoomButton = (label) => nativeFrame(page).locator(`viewer-toolbar cr-icon-button[aria-label="${label}"]`);
    out.phases.zoom = { name: 'zoom', before: await stateNow() };
    await armInputClock(page);
    if (spec.engine === 'reader') {
        await page.mouse.move(spec.pointer.x, spec.pointer.y);
        await sleep(300);
        out.phases.zoom.tAction = Date.now();
        await page.keyboard.press('Meta+Equal');
    } else {
        const btn = zoomButton('Zoom in');
        await btn.hover();
        await sleep(300);
        out.phases.zoom.tAction = Date.now();
        await btn.click();
    }
    out.phases.zoom.tLastInput = Date.now();
    // The reader's key: '=' (the Meta keydown before it is not the input).
    out.phases.zoom.tInput = (await inputsSince(page, out.phases.zoom.tAction,
        spec.engine === 'native' ? 'pointerdown' : 'keydown', spec.engine === 'native' ? null : '='))[0] || null;
    await settle(page, 'zoom', out.phases.zoom.tAction, spec.phaseMaxMs);
    out.phases.zoom.state = await stateNow();

    const burst = spec.zoomBurst || 4;
    out.phases.zoom_burst = { name: 'zoom_burst', steps: burst, intervalMs: spec.zoomBurstIntervalMs, before: await stateNow() };
    const btnOut = spec.engine === 'native' ? zoomButton('Zoom out') : null;
    if (btnOut) await btnOut.hover();
    await sleep(300);
    out.phases.zoom_burst.tAction = Date.now();
    for (let i = 0; i < burst; i++) {
        if (i) await sleep(Math.max(0, out.phases.zoom_burst.tAction + i * spec.zoomBurstIntervalMs - Date.now()));
        if (btnOut) await btnOut.click(); else await page.keyboard.press('Meta+Minus');
    }
    out.phases.zoom_burst.tLastInput = Date.now();
    const burstInputs = await inputsSince(page, out.phases.zoom_burst.tAction,
        spec.engine === 'native' ? 'pointerdown' : 'keydown', spec.engine === 'native' ? null : '-');
    out.phases.zoom_burst.inputs = burstInputs;
    out.phases.zoom_burst.tInput = burstInputs.length === burst ? burstInputs[burst - 1] : null;
    await settle(page, 'zoom_burst', out.phases.zoom_burst.tLastInput, spec.phaseMaxMs);
    out.phases.zoom_burst.state = await stateNow();
    await stopScreencast();
    await pump(page, false);
    await sleep(spec.idleMs);
    out.memory.afterZoom = measureTree(browserPid);

    await Promise.all(writes);
    out.frames = frames.map((f) => ({ t: Math.round(f.t * 10) / 10, arrived: f.arrived, file: path.basename(f.file) }));
}

main().catch((e) => { out.fatal = String(e && e.stack || e).slice(0, 600); }).finally(async () => {
    if (browserRef) await browserRef.close().catch(() => {});
    if (out.serverClose) out.serverClose();
    delete out.serverClose;
    fs.writeFileSync(path.join(spec.outDir, 'trial.json'), JSON.stringify(out));
    process.exit(0);
});

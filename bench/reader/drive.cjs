#!/usr/bin/env node
/*
 * Drive one document through the reader for bench/reader/run.py.
 *
 * Usage: drive.cjs <spec.json>   (prints one JSON object on stdout)
 *
 * spec: { readUrl, zoom, viewport: {width, height}, dpr, outDir, rasterWaitMs,
 *         pages: [{ page, words: ["..."] }] }
 *
 * The browser opens readUrl (the daemon's /read?path=..., which answers 307 to
 * /r/<hash>/) in a fresh context with the overlay's zoom preference set before
 * load, so pages render at a fixed CSS width. For each sampled page it jumps
 * with the palette (`:` <n> Enter), waits for the page raster at the exact
 * device width, screenshots the page frame with overlay chrome hidden and no
 * selection, then reads the page's text layer and runs window.find for each
 * sampled word, reporting the highlight rectangles in page px.
 *
 * The output carries document text (domText, selText) for the driver to
 * score; run.py never writes it to disk.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const HIDE_CHROME = 'body > :not(#page-container){display:none!important}'
    + ' .pf{box-shadow:none!important}';

async function main() {
    const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    const out = { pages: [], consoleErrors: [], pageErrors: [], failedRequests: [], abortedRequests: 0 };
    const origin = new URL(spec.readUrl).origin;
    const browser = await chromium.launch();
    try {
        const context = await browser.newContext({
            viewport: spec.viewport, deviceScaleFactor: spec.dpr, serviceWorkers: 'block',
        });
        await context.addInitScript((zoom) => {
            try { localStorage.setItem('pdf2html-zoom', String(zoom)); } catch (e) { /* ignore */ }
        }, spec.zoom);
        // Only the daemon is reachable: the reader must not need anything else.
        await context.route('**/*', (route) => {
            const u = new URL(route.request().url());
            if (u.origin === origin || u.protocol === 'data:' || u.protocol === 'blob:') return route.continue();
            out.failedRequests.push('blocked-external ' + u.origin);
            return route.abort();
        });
        const page = await context.newPage();
        page.on('console', (m) => {
            if (m.type() === 'error' && out.consoleErrors.length < 20) out.consoleErrors.push(m.text().slice(0, 300));
        });
        page.on('pageerror', (e) => {
            if (out.pageErrors.length < 20) out.pageErrors.push(String(e).slice(0, 300));
        });
        page.on('requestfailed', (r) => {
            const u = new URL(r.url());
            const why = (r.failure() || {}).errorText || '';
            if (u.origin === origin && why.includes('ERR_ABORTED')) { out.abortedRequests += 1; return; }
            if (u.origin === origin && out.failedRequests.length < 20) {
                out.failedRequests.push(`failed ${why} ${u.pathname}`);
            }
        });
        page.on('response', (r) => {
            const u = new URL(r.url());
            if (r.status() >= 400 && u.origin === origin && out.failedRequests.length < 20) {
                out.failedRequests.push(`${r.status()} ${u.pathname}`);
            }
        });

        const t0 = Date.now();
        let resp;
        try {
            resp = await page.goto(spec.readUrl, { waitUntil: 'commit', timeout: spec.openTimeoutMs });
        } catch (e) {
            out.openError = String(e).slice(0, 300);
            return out;
        }
        out.responseMs = Date.now() - t0;
        out.status = resp ? resp.status() : null;
        out.finalPath = new URL(page.url()).pathname;
        const hops = [];
        for (let r = resp && resp.request().redirectedFrom(); r; r = r.redirectedFrom()) {
            const rr = await r.response();
            hops.unshift(rr ? rr.status() : null);
        }
        out.redirects = hops;
        await page.waitForLoadState('domcontentloaded', { timeout: spec.openTimeoutMs }).catch(() => {});
        out.domMs = Date.now() - t0;
        out.firstRasterMs = spec.textOnly ? null : await page.waitForFunction(
            () => document.querySelector('#page-container > .pf[data-pdf2html-raster-state="ready"]'),
            null, { timeout: spec.rasterWaitMs, polling: 20 },
        ).then(() => Date.now() - t0).catch(() => null);
        if (out.firstRasterMs === null) {
            out.firstRasterState = await page.evaluate(() => {
                const pf = document.querySelector('#page-container > .pf');
                return pf ? (pf.dataset.pdf2htmlRasterState || 'none') : 'no-page';
            }).catch(() => 'eval-failed');
        }
        Object.assign(out, await page.evaluate(() => {
            const root = document.getElementById('page-container');
            return {
                pfCount: document.querySelectorAll('#page-container > .pf').length,
                representation: document.documentElement.getAttribute('data-pdf2html-representation'),
                zoomVar: root ? root.style.getPropertyValue('--pdf2html-zoom') : null,
            };
        }).catch((e) => ({ evalError: String(e).slice(0, 300) })));
        if (!out.pfCount) return out;
        await page.evaluate(() => document.fonts.ready);
        const hide = await page.addStyleTag({ content: HIDE_CHROME });
        const setHidden = (on) => hide.evaluate((el, v) => { el.disabled = !v; }, on);

        fs.mkdirSync(spec.outDir, { recursive: true });
        for (const job of spec.pages) {
            const entry = { page: job.page };
            out.pages.push(entry);
            const id = 'pf' + job.page.toString(16);
            if (spec.textOnly) continue;
            try {
                if (!(await page.$('#' + id))) { entry.missing = true; continue; }
                // Jump with the palette, as a reader would.
                await setHidden(false);
                await page.evaluate(() => { window.getSelection().removeAllRanges(); });
                const j0 = Date.now();
                await page.keyboard.press(':');
                const input = await page.waitForSelector('#pdf2html-palette-input', { timeout: 3000 })
                    .catch(() => null);
                if (input) {
                    await input.type(String(job.page));
                    await page.keyboard.press('Enter');
                } else {
                    entry.paletteMissing = true;
                }
                // Settled: scrollTop unchanged over 5 frames.
                await page.waitForFunction(() => new Promise((resolve) => {
                    const root = document.getElementById('page-container');
                    let last = root.scrollTop, same = 0;
                    const tick = () => {
                        if (root.scrollTop === last) same += 1; else { same = 0; last = root.scrollTop; }
                        if (same >= 5) resolve(true); else requestAnimationFrame(tick);
                    };
                    requestAnimationFrame(tick);
                }), null, { timeout: 5000 }).catch(() => { entry.scrollUnsettled = true; });
                entry.scrollMs = Date.now() - j0;
                entry.jumpLanded = await page.evaluate((pid) => {
                    const pf = document.getElementById(pid);
                    const root = document.getElementById('page-container').getBoundingClientRect();
                    const r = pf.getBoundingClientRect();
                    return r.bottom > root.top && r.top < root.bottom;
                }, id);
                await setHidden(true);
                // The screenshot needs the whole page inside the viewport.
                await page.evaluate((pid) => {
                    const pf = document.getElementById(pid);
                    const r = pf.getBoundingClientRect();
                    if (r.top < 0 || r.left < 0 || r.bottom > window.innerHeight || r.right > window.innerWidth) {
                        pf.scrollIntoView({ block: 'center', inline: 'center' });
                    }
                }, id);
                const wanted = ({ pid, dpr }) => {
                    const pf = document.getElementById(pid);
                    const img = pf.querySelector('img.bi');
                    if (!img) return 'no-img';
                    const st = pf.dataset.pdf2htmlRasterState;
                    if (st === 'error') return 'error';
                    const root = document.getElementById('page-container');
                    const zoom = parseFloat(root.style.getPropertyValue('--pdf2html-zoom')) || 1;
                    const want = Math.max(64, Math.round(parseFloat(pf.style.width) * zoom * dpr));
                    const src = img.getAttribute('src') || '';
                    if (st === 'ready' && src.endsWith('/' + want + '.png') && img.complete && img.naturalWidth) return 'ready';
                    return false;
                };
                entry.rasterState = await page.waitForFunction(wanted, { pid: id, dpr: spec.dpr },
                    { timeout: spec.rasterWaitMs, polling: 20 })
                    .then((h) => h.jsonValue()).catch(() => 'timeout');
                entry.jumpMs = Date.now() - j0;
                // 'ready' means the image loaded; Chromium may still be decoding a large
                // PNG and paints white until it has. Wait for decode, and record how long
                // that took after 'ready' (a white page the reader reports as ready).
                const d0 = Date.now();
                entry.decode = await page.evaluate((pid) => {
                    const img = document.querySelector('#' + pid + ' img.bi');
                    if (!img || !img.decode) return 'n/a';
                    return img.decode().then(() => 'ok', (e) => 'error: ' + String(e).slice(0, 100));
                }, id).catch((e) => 'eval-error');
                entry.decodeWaitMs = Date.now() - d0;
                await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
                await page.evaluate(() => {
                    window.getSelection().removeAllRanges();
                    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
                });
                const geo = await page.evaluate(({ pid, dpr }) => {
                    const pf = document.getElementById(pid);
                    const img = pf.querySelector('img.bi');
                    const r = pf.getBoundingClientRect();
                    return {
                        rect: { x: r.left, y: r.top, width: r.width, height: r.height },
                        cssWidth: parseFloat(pf.style.width), cssHeight: parseFloat(pf.style.height),
                        rasterSrc: img ? (img.getAttribute('src') || '').split('/').pop() : null,
                        naturalWidth: img ? img.naturalWidth : null,
                        naturalHeight: img ? img.naturalHeight : null,
                        deviceWidth: Math.round(r.width * dpr),
                        state: pf.dataset.pdf2htmlRasterState || null,
                        imgBox: !!img && img.getBoundingClientRect().width > 0,
                    };
                }, { pid: id, dpr: spec.dpr });
                Object.assign(entry, geo);
                const r = geo.rect;
                if (r.y < -0.5 || r.x < -0.5 || r.y + r.height > spec.viewport.height + 0.5
                        || r.x + r.width > spec.viewport.width + 0.5) {
                    entry.clipped = true;
                } else if (entry.rasterState === 'ready') {
                    const file = path.join(spec.outDir, `shot-${job.page}.png`);
                    await page.screenshot({ path: file, clip: r, animations: 'disabled', timeout: 60000 });
                    entry.shot = file;
                }
            } catch (e) {
                entry.error = String(e).slice(0, 300);
            }
        }

        // Text pass, after every screenshot. With find interleaved, a page jumped to
        // after window.find had run on an earlier page was observed (headless
        // Chromium, cause not isolated) to report its raster ready while the image
        // had no layout box, so it captured white. Keep find out of the visual pass.
        const inView = (pid) => page.evaluate((p) => {
            const pf = document.getElementById(p);
            pf.scrollIntoView({ block: 'center', inline: 'center' });
            return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        }, pid);
        for (const entry of out.pages) {
            if (entry.missing || entry.error) continue;
            const job = spec.pages.find((j) => j.page === entry.page);
            const id = 'pf' + job.page.toString(16);
            try {
                await inView(id);
                // A first open loads text by range after the shell
                // (overlay-readertext.js): wait for this page's text, and record how long.
                const w0 = Date.now();
                entry.textWait = await page.waitForFunction((pid) => !document.getElementById(pid).hasAttribute('data-reader-pending'),
                    id, { timeout: spec.rasterWaitMs, polling: 20 }).then(() => 'ok', () => 'timeout');
                entry.textWaitMs = Date.now() - w0;
                // Text layer: lines joined by newline, and what a select-all of the page copies.
                Object.assign(entry, await page.evaluate((pid) => {
                    const pc = document.querySelector('#' + pid + ' .pc');
                    if (!pc) return { domText: null };
                    const lines = Array.from(pc.querySelectorAll(':scope > .t'));
                    const sel = window.getSelection();
                    sel.removeAllRanges();
                    sel.selectAllChildren(pc);
                    const selText = sel.toString();
                    sel.removeAllRanges();
                    // Geometry-only inversions: earlier DOM lines below later
                    // lines in the same horizontal lane. Rotated/RTL text and
                    // table segments are excluded because their order is ambiguous.
                    const upright=lines.filter(l=>!l.style.transform && l.dir!=='rtl' && !l.querySelector('.g'));
                    const boxes=upright.map(l=>l.getBoundingClientRect());
                    let orderInversions=0, orderPairs=0;
                    for(let i=0;i<boxes.length;i++) for(let j=i+1;j<boxes.length;j++) {
                        const a=boxes[i], b=boxes[j];
                        const overlap=Math.min(a.right,b.right)-Math.max(a.left,b.left);
                        if(overlap < .5*Math.min(a.width,b.width)) continue;
                        if(Math.abs(a.top-b.top)<Math.max(a.height,b.height)) continue;
                        orderPairs++;
                        if(a.top>b.top) orderInversions++;
                    }
                    return { orderInversions, orderPairs, domText: lines.map((t) => t.textContent).join('\n'), selText, lineCount: lines.length };
                }, id));
                // Find and highlight geometry for each sampled word.
                entry.words = await page.evaluate(({ pid, words }) => {
                    const pf = document.getElementById(pid);
                    const pc = pf.querySelector('.pc');
                    const sel = window.getSelection();
                    const toPage = (range) => {
                        const pr = pf.getBoundingClientRect();
                        const scale = pr.width / parseFloat(pf.style.width);
                        return Array.from(range.getClientRects())
                            .filter((q) => q.width > 0 && q.height > 0)
                            .map((q) => [(q.left - pr.left) / scale, (q.top - pr.top) / scale,
                                (q.right - pr.left) / scale, (q.bottom - pr.top) / scale]);
                    };
                    const domRange = (word) => {
                        // DOM text search over the page's text nodes in document order.
                        const walker = document.createTreeWalker(pc, NodeFilter.SHOW_TEXT);
                        const nodes = [];
                        let text = '';
                        let line = null;
                        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
                            // A newline between .t lines, so a word never matches across two lines.
                            const t = n.parentElement && n.parentElement.closest('.t');
                            if (line && t !== line) text += '\n';
                            line = t;
                            nodes.push([n, text.length]);
                            text += n.nodeValue;
                        }
                        const at = text.indexOf(word);
                        if (at < 0) return null;
                        const locate = (off) => {
                            for (let i = nodes.length - 1; i >= 0; i--) {
                                if (nodes[i][1] <= off) return [nodes[i][0], off - nodes[i][1]];
                            }
                            return null;
                        };
                        const a = locate(at), b = locate(at + word.length - 1);
                        const range = document.createRange();
                        range.setStart(a[0], a[1]);
                        range.setEnd(b[0], b[1] + 1);
                        return range;
                    };
                    const res = [];
                    for (const word of words) {
                        const item = { found: false, rects: [] };
                        sel.removeAllRanges();
                        const start = document.createRange();
                        start.setStart(pc, 0);
                        start.collapse(true);
                        sel.addRange(start);
                        let ok = false;
                        try { ok = window.find(word, true, false, false, false, false, false); } catch (e) { item.findError = String(e); }
                        if (ok && sel.rangeCount) {
                            const range = sel.getRangeAt(0);
                            item.inPage = pf.contains(range.startContainer);
                            item.exact = sel.toString() === word;
                            if (item.inPage) {
                                item.found = true;
                                item.findRects = toPage(range);
                            }
                        }
                        sel.removeAllRanges();
                        // Highlight geometry from a DOM Range over the word's first occurrence
                        // in the page's text layer, independent of whether find hit it.
                        const range = domRange(word);
                        item.inDom = !!range;
                        if (range) item.rects = toPage(range);
                        res.push(item);
                    }
                    sel.removeAllRanges();
                    return res;
                }, { pid: id, words: job.words });
            } catch (e) {
                entry.error = String(e).slice(0, 300);
            }
        }
    } finally {
        await browser.close();
    }
    return out;
}

main().then((out) => {
    process.stdout.write(JSON.stringify(out) + '\n');
}).catch((err) => {
    process.stdout.write(JSON.stringify({ fatal: String(err && err.stack ? err.stack : err).slice(0, 2000) }) + '\n');
    process.exit(1);
});

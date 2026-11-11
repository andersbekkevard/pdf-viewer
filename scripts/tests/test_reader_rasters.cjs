'use strict';
// Reader raster scheduling (assets/overlay-document.js, mountReaderRasters)
// against a fake DOM: request order, the request cap, decode-before-swap,
// zoom debounce and cancellation, release far from the viewport, retries.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

async function main() {
    const src = fs.readFileSync(path.resolve(__dirname, '../../assets/overlay-document.js'), 'utf8');
    const { createDocumentModel } = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));

    let now = 1000;
    Date.now = () => now;
    const timers = [];
    const flush = () => new Promise((r) => setImmediate(r));
    async function advance(ms) {
        now += ms;
        for (const t of timers.splice(0).sort((a, b) => a.at - b.at)) {
            if (t.at <= now) t.fn(); else timers.push(t);
        }
        await flush();
    }

    const images = [];   // every off-screen Image the lifecycle made
    class FakeImage {
        constructor() { this.attrs = {}; images.push(this); }
        set src(v) { this.attrs.src = v; }
        get src() { return this.attrs.src; }
        removeAttribute(k) { delete this.attrs[k]; if (this.reject) this.reject(new Error('aborted')); }
        decode() { return new Promise((res, rej) => { this.resolve = res; this.reject = rej; }); }
        get pending() { return 'src' in this.attrs && !!this.resolve && !this.settled; }
        finish(ok = true) { this.settled = true; this.complete = ok; this.naturalWidth = ok ? 1 : 0; ok ? this.resolve() : this.reject(new Error('bad')); }
    }
    const pending = () => images.filter((i) => i.pending);
    const urls = () => pending().map((i) => i.src);

    function el(attrs) {
        return {
            attrs, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
            hasAttribute(k) { return k in this.attrs; }, setAttribute(k, v) { this.attrs[k] = String(v); },
            removeAttribute(k) { delete this.attrs[k]; },
        };
    }
    const frames = Array.from({ length: 40 }, (_, i) => {
        const img = el({ 'data-reader-raster': `/r/h/p/${i + 1}/`, 'data-pdf2html-src': `/r/h/p/${i + 1}/1200.png` });
        return {
            id: 'pf' + (i + 1).toString(16), img, dataset: {}, style: { width: '600px' },
            querySelector: (sel) => (sel.startsWith('img.bi') ? img : null),
        };
    });
    let zoom = '1';
    const root = { style: { getPropertyValue: () => zoom }, querySelectorAll: () => frames };
    const html = el({ 'data-pdf2html-representation': 'raster-v1' });
    const listeners = {};
    const document = {
        documentElement: html, getElementById: () => root,
        addEventListener: (t, fn) => { listeners[t] = fn; },
    };
    const observers = [];
    const window = {
        devicePixelRatio: 2, Image: FakeImage,
        setTimeout: (fn, ms) => { timers.push({ fn, at: now + ms }); return timers.length; },
        addEventListener: () => {},
        IntersectionObserver: class {
            constructor(cb, opts) { this.cb = cb; this.margin = opts.rootMargin; this.seen = new Set(); observers.push(this); }
            observe() {}
        },
    };
    const model = createDocumentModel({ document, window, requestAnimationFrame() {} });
    model.mountRasterLifecycle();
    assert.equal(observers.length, 3, 'visible, near and keep observers');
    const [visibleObs, nearObs, keepObs] = observers;
    // Put pages [a, b) on screen, [a-n, b+n) near, [a-k, b+k) kept.
    async function view(a, b, n = 1, k = 3) {
        for (const [obs, lo, hi] of [[keepObs, a - k, b + k], [nearObs, a - n, b + n], [visibleObs, a, b]]) {
            const changes = [];
            frames.forEach((f, i) => {
                const on = i >= lo && i < hi;
                if (on !== obs.seen.has(f)) { changes.push({ target: f, isIntersecting: on }); on ? obs.seen.add(f) : obs.seen.delete(f); }
            });
            if (changes.length) obs.cb(changes);
        }
        await flush();
    }
    const state = (i) => frames[i].dataset.pdf2htmlRasterState;

    // Open on pages 10-11 (indices 9, 10); near adds 8 and 11.
    await view(9, 11);
    assert.deepEqual(urls().slice(0, 2).sort(), ['/r/h/p/10/1200.jpg', '/r/h/p/11/1200.jpg'], 'pages on screen go first');
    assert.equal(pending().length, 3, 'at most three requests at once');
    assert.equal(state(9), 'loading');
    assert(!frames[9].img.hasAttribute('src'), 'nothing is shown before it has decoded');
    pending().forEach((i) => i.finish());
    await flush();
    assert.equal(frames[9].img.getAttribute('src'), '/r/h/p/10/1200.jpg');
    assert.equal(state(9), 'ready');
    assert.equal(urls().length, 1, 'the fourth near page follows when a slot frees');
    pending().forEach((i) => i.finish());
    await flush();

    // Zoom burst: the shown raster stays, no request until the zoom has settled,
    // and only the final width is ever requested.
    const before = images.length;
    for (const z of ['1.1', '1.2', '1.3']) {
        zoom = z;
        listeners['pdf2html-viewport-change']();
        await advance(60);
    }
    assert.equal(images.length, before, 'no request during the burst');
    assert.equal(frames[9].img.getAttribute('src'), '/r/h/p/10/1200.jpg', 'old raster kept, scaled');
    assert.equal(state(9), 'loading');
    await advance(130);
    assert.deepEqual(urls().slice(0, 2).sort(), ['/r/h/p/10/1560.jpg', '/r/h/p/11/1560.jpg']);
    // Another zoom step cancels the requests for the width just left.
    const stale = pending();
    zoom = '1.4';
    listeners['pdf2html-viewport-change']();
    await flush();
    assert(stale.every((i) => !('src' in i.attrs)), 'stale-width requests are aborted at once');
    await advance(130);
    assert(urls().every((u) => u.endsWith('/1680.jpg')));
    pending().forEach((i) => i.finish());
    await flush();
    pending().forEach((i) => i.finish());
    await flush();
    assert.equal(frames[9].img.getAttribute('src'), '/r/h/p/10/1680.jpg');

    // Far jump: everything near the old place is released, the target goes first.
    await view(29, 30);
    assert.equal(urls()[0], '/r/h/p/30/1680.jpg');
    assert(!frames[9].img.hasAttribute('src'), 'rasters far from the viewport are released');
    assert.equal(state(9), 'unloaded');
    // A late completion of a cancelled request cannot revive a released page.
    stale.forEach((i) => { try { i.finish(); } catch (_) { /* already rejected */ } });
    await flush();
    assert(!frames[9].img.hasAttribute('src'));

    // A failed raster shows as an error and is retried when the page comes back.
    pending().find((i) => i.src === '/r/h/p/30/1680.jpg').finish(false);
    await flush();
    assert.equal(state(29), 'error');
    assert(!urls().includes('/r/h/p/30/1680.jpg'), 'no retry loop');
    await view(2, 3);
    await view(29, 30);
    assert(urls().includes('/r/h/p/30/1680.jpg'), 're-entry retries');

    console.log('PASS: on-screen first, request cap, decode before swap, zoom debounce and cancellation, release, retry');
}
main().catch((e) => { console.error(e); process.exitCode = 1; });

// Late text for reader shells (daemon/reader.py).
//
// The first open of a reader document gets every page frame but text for
// only a few pages; the root then carries `data-reader-text="loading"`, the
// range URL (`data-reader-text-src`) and its size in pages
// (`data-reader-text-range`), and each frame still without text carries
// `data-reader-pending`. This module fetches the missing ranges,
// `<src><k>.json` → {first, pages: [markup…]}, and appends each page's
// markup to its `.pc`, after the raster, as the complete shell has it.
//
// Order: ranges holding a visible page, then ranges someone waits for
// (`whenLoaded`), then outward from the current page, forward first. A
// visible range that is not yet loading starts even when the regular slots
// are busy, so a jump or a resumed position gets its text first.
//
// Inserting into a frame never moves the scroll position: frames have their
// size inline and text lines are absolutely positioned inside them. After an
// insert, `pdf2html-text-ready` names the pages, so text fitting can run;
// when every range has arrived (or failed) the root becomes
// `data-reader-text="complete"`.
export function createReaderText(core) {
    var document = core.document;
    var window = core.window;
    var fetch = core.fetch;
    var documentModel = core.documentModel;
    var navigation = core.navigation;

    // Regular requests in flight. Each spreads over several daemon workers;
    // enough of them keep every worker busy.
    var SLOTS = 4;
    var RETRIES = 3;

    var src = null;
    var size = 0;
    var ranges = new Map();   // range index → { pages, state, tries }
    var inFlight = 0;
    var waiters = [];
    var finished = false;
    var started = false;

    function root() { return document.documentElement; }
    function rangeOf(pageNum) { return Math.floor((pageNum - 1) / size); }

    // Resolves when pages [from, to) all have text or have failed, with the
    // page numbers whose text could not be loaded.
    function whenLoaded(from, to) {
        if (finished || !ranges.size) return Promise.resolve({ missing: failedPages(from, to) });
        return new Promise(function (resolve) {
            var wanted = [];
            for (var k = rangeOf(Math.max(1, from)); k <= rangeOf(Math.max(1, to - 1)); k++) {
                if (ranges.has(k)) wanted.push(k);
            }
            waiters.push({ from: from, to: to, ranges: wanted, resolve: resolve });
            settleWaiters();
            pump();
        });
    }
    function failedPages(from, to) {
        var out = [];
        ranges.forEach(function (range) {
            if (range.state !== 'failed') return;
            range.pages.forEach(function (n) { if (n >= from && n < to) out.push(n); });
        });
        return out.sort(function (a, b) { return a - b; });
    }
    function settled(k) {
        var range = ranges.get(k);
        return !range || range.state === 'done' || range.state === 'failed';
    }
    function settleWaiters() {
        waiters = waiters.filter(function (waiter) {
            if (!waiter.ranges.every(settled)) return true;
            waiter.resolve({ missing: failedPages(waiter.from, waiter.to) });
            return false;
        });
    }

    function idle(k) { var range = ranges.get(k); return !!range && range.state === 'pending'; }
    function visibleRanges() {
        var out = [];
        documentModel.visiblePages().forEach(function (pf) {
            if (!documentModel.isTextPending(pf)) return;
            var k = rangeOf(documentModel.pageNumber(pf));
            if (out.indexOf(k) < 0) out.push(k);
        });
        return out;
    }
    function nextRange(visible) {
        for (var i = 0; i < visible.length; i++) if (idle(visible[i])) return visible[i];
        for (var w = 0; w < waiters.length; w++) {
            var mine = waiters[w].ranges;
            for (var j = 0; j < mine.length; j++) if (idle(mine[j])) return mine[j];
        }
        var here = rangeOf(navigation.page() || 1);
        var best = null, bestCost = Infinity;
        ranges.forEach(function (range, k) {
            if (range.state !== 'pending') return;
            // Forward is where reading goes; behind costs twice as much.
            var cost = k >= here ? k - here : 2 * (here - k);
            if (cost < bestCost) { bestCost = cost; best = k; }
        });
        return best;
    }

    function pump() {
        if (!started || finished) return;
        var visible = visibleRanges();
        var k;
        while (inFlight < SLOTS && (k = nextRange(visible)) != null) load(k);
        // One extra slot for what is on screen now.
        if (inFlight > SLOTS) return;
        for (var i = 0; i < visible.length; i++) {
            if (idle(visible[i])) { load(visible[i]); break; }
        }
    }

    function load(k) {
        var range = ranges.get(k);
        range.state = 'loading';
        inFlight++;
        fetch(src + k + '.json', { cache: 'no-store' }).then(function (response) {
            if (!response.ok) throw new Error('HTTP ' + response.status);
            return response.json();
        }).then(function (data) {
            insert(range, data);
            range.state = 'done';
        }).catch(function (error) {
            range.tries++;
            if (range.tries < RETRIES) {
                range.state = 'retry';
                window.setTimeout(function () { range.state = 'pending'; pump(); }, 300 * range.tries);
            } else {
                range.state = 'failed';
                window.console.warn('reader: no text for pages ' + range.pages[0] + '–'
                    + range.pages[range.pages.length - 1] + ': ' + error);
            }
        }).then(function () {
            inFlight--;
            settleWaiters();
            checkFinished();
            pump();
        });
    }

    function insert(range, data) {
        var first = data && data.first;
        var markup = data && data.pages;
        if (!(first > 0) || !Array.isArray(markup)) throw new Error('malformed text range');
        var done = [];
        for (var i = 0; i < markup.length; i++) {
            var n = first + i;
            if (range.pages.indexOf(n) < 0) continue;
            var pf = documentModel.page(n);
            var pc = documentModel.pageContent(pf);
            if (!pf || !pc || !documentModel.isTextPending(pf)) continue;
            if (markup[i]) pc.insertAdjacentHTML('beforeend', markup[i]);
            if ((data.ocr || []).indexOf(n) >= 0) pf.setAttribute('data-reader-ocr', 'pending');
            pf.removeAttribute('data-reader-pending');
            done.push(n);
        }
        if (done.length) {
            document.dispatchEvent(new CustomEvent('pdf2html-text-ready', { detail: { pages: done } }));
        }
    }

    function checkFinished() {
        if (finished) return;
        var open = false;
        ranges.forEach(function (range) { if (range.state !== 'done' && range.state !== 'failed') open = true; });
        if (open) return;
        finished = true;
        root().setAttribute('data-reader-text', 'complete');
        settleWaiters();
    }

    function start() {
        if (started) return;
        started = true;
        pump();
    }

    function mount() {
        var html = root();
        if (!documentModel.isReader() || !html || html.getAttribute('data-reader-text') !== 'loading') {
            finished = true;
            return;
        }
        src = html.getAttribute('data-reader-text-src');
        size = parseInt(html.getAttribute('data-reader-text-range'), 10);
        if (!src || !(size > 0)) { finished = true; return; }
        documentModel.pages().forEach(function (pf) {
            if (!documentModel.isTextPending(pf)) return;
            var n = documentModel.pageNumber(pf);
            var k = rangeOf(n);
            if (!ranges.has(k)) ranges.set(k, { pages: [], state: 'pending', tries: 0 });
            ranges.get(k).pages.push(n);
        });
        if (!ranges.size) { checkFinished(); return; }
        document.addEventListener('pdf2html-page-change', pump);
        // The daemon runs page renders before text ranges, so text loading
        // can start at once without delaying the first rasters.
        start();
    }

    return { mount: mount, whenLoaded: whenLoaded };
}

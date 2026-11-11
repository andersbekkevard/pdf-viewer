// Recognized text for scanned pages in reader shells (daemon/ocr.py).
//
// A reader page whose PDF has no usable text layer is marked
// `data-reader-ocr="pending"` on its `.pf`. This module asks the daemon's
// `/r/<hash>/ocr` route for those pages, nearest to the viewport first,
// inserts the returned `.t.ocr` lines before the page's links, has the text
// fit size them, and marks the page `done`. The daemon recognizes the rest of
// the document in the background meanwhile; native find sees a page's text
// once it is inserted.
//
// It also owns a small status pill: shown while a visible page is being
// recognized or the document is still incomplete, and when a visible page is
// a scan that cannot be recognized here.
//
// Temporary delivery path: when the reader delivers page text after the
// first response in general, this module's fetching and insertion should
// become that mechanism's; the marker, the `.t ocr` markup and the status
// are what stay.
export function createOcr(core) {
    var document = core.document;
    var window = core.window;
    var fetch = core.fetch;
    var documentModel = core.documentModel;
    var textFit = core.textFit;
    var entryHash = core.entryHash;

    var WAIT_SECONDS = 20;       // daemon-side wait for the pages asked for
    var VISIBLE_BATCH = 3;       // visible pages asked for together
    var NEAR_BATCH = 6;          // pages near the viewport asked for together
    var PEEK_CHUNK = 200;        // pages per no-wait request for finished text
    var PEEK_AFTER = 8;          // background pages done before a new peek

    var pending = new Map();     // page number → .pf still waiting for text
    var total = 0;               // pages marked for recognition
    var done = 0;                // pages the daemon reports finished
    var inserted = 0;
    var available = true;
    var stopped = false;         // the daemon could not be reached
    var status = null;
    var base = '';

    function pageParam(numbers) {
        // "1-4,7": consecutive pages collapse into ranges.
        numbers = numbers.slice().sort(function (a, b) { return a - b; });
        var out = [];
        for (var i = 0; i < numbers.length; i++) {
            var start = numbers[i];
            while (i + 1 < numbers.length && numbers[i + 1] === numbers[i] + 1) i++;
            out.push(start === numbers[i] ? String(start) : start + '-' + numbers[i]);
        }
        return out.join(',');
    }

    function request(numbers, wait) {
        var url = base + '?pages=' + pageParam(numbers) + '&wait=' + wait;
        return fetch(url, { cache: 'no-store' }).then(function (response) {
            if (!response.ok) throw new Error('ocr ' + response.status);
            return response.json();
        });
    }

    function insert(pf, html) {
        var pc = documentModel.pageContent(pf);
        if (!pc) return;
        var template = document.createElement('template');
        template.innerHTML = html;
        // Lines go before the links, as in a shell built with text.
        pc.insertBefore(template.content, pc.querySelector(':scope > a.l'));
        if (textFit) textFit.refit(pf);
    }

    function apply(data) {
        if (!data || !data.pages) return;
        if (typeof data.total === 'number') total = data.total;
        if (typeof data.done === 'number') done = data.done;
        if (data.available === false) available = false;
        Object.keys(data.pages).forEach(function (key) {
            var number = parseInt(key, 10);
            var pf = pending.get(number);
            if (!pf) return;
            var page = data.pages[key];
            if (page.state === 'done') {
                if (page.html) insert(pf, page.html);
                pf.setAttribute('data-reader-ocr', 'done');
                pending.delete(number);
                inserted++;
                document.dispatchEvent(new CustomEvent('pdf2html-text-added', { detail: { page: number } }));
            } else if (page.state === 'none' || page.state === 'failed' || page.state === 'unavailable') {
                pf.setAttribute('data-reader-ocr', page.state);
                pending.delete(number);
            }
        });
        updateStatus();
    }

    // Pending pages ordered by distance from the viewport; visible ones first.
    function nearest() {
        var visible = documentModel.visiblePages().map(documentModel.pageNumber)
            .filter(function (n) { return pending.has(n); });
        if (visible.length) return visible.slice(0, VISIBLE_BATCH);
        var centre = documentModel.mostVisiblePage() || 1;
        return Array.from(pending.keys()).sort(function (a, b) {
            return Math.abs(a - centre) - Math.abs(b - centre) || a - b;
        }).slice(0, NEAR_BATCH);
    }

    // Everything already recognized, without waiting (a reopened document).
    function peek() {
        var numbers = Array.from(pending.keys());
        var chunks = [];
        for (var i = 0; i < numbers.length; i += PEEK_CHUNK) chunks.push(numbers.slice(i, i + PEEK_CHUNK));
        return chunks.reduce(function (chain, chunk) {
            return chain.then(function () { return request(chunk, 0).then(apply); });
        }, Promise.resolve());
    }

    function sleep(ms) { return new Promise(function (resolve) { window.setTimeout(resolve, ms); }); }

    // Recognition competes with rendering for the daemon's workers and the
    // CPU, so it starts once the visible pages' rasters are in (or after
    // FIRST_PAINT_GRACE_MS), never ahead of first paint.
    var FIRST_PAINT_GRACE_MS = 2500;
    function afterFirstPaint() {
        var started = Date.now();
        return new Promise(function (resolve) {
            (function check() {
                var waiting = documentModel.visiblePages().some(function (pf) {
                    var state = pf.dataset.pdf2htmlRasterState;
                    return state === 'loading' || state === 'unloaded';
                });
                if (!waiting || Date.now() - started > FIRST_PAINT_GRACE_MS) resolve();
                else window.setTimeout(check, 50);
            })();
        });
    }

    function run() {
        var failures = 0;
        var peekedAt = 0;
        function step() {
            if (!pending.size || !available) { updateStatus(); return; }
            var batch = nearest();
            return request(batch, WAIT_SECONDS).then(function (data) {
                failures = 0;
                apply(data);
                if (done - inserted >= PEEK_AFTER && done !== peekedAt) {
                    peekedAt = done;
                    return peek();
                }
            }, function () {
                failures++;
                if (failures >= 3) { stopped = true; updateStatus(); return Promise.reject(); }
                return sleep(2000 * failures);
            }).then(step);
        }
        return afterFirstPaint().then(peek).then(step, function () { stopped = true; updateStatus(); });
    }

    // ------------------------------------------------------------- status
    function updateStatus() {
        if (!status) return;
        var visible = documentModel.visiblePages();
        var waiting = false, unavailable = false, failed = false;
        visible.forEach(function (pf) {
            var state = pf.getAttribute('data-reader-ocr');
            if (state === 'pending') waiting = true;
            else if (state === 'unavailable') unavailable = true;
            else if (state === 'failed') failed = true;
        });
        var text = '';
        if (stopped && pending.size) text = 'Text recognition stopped';
        else if (unavailable || (!available && waiting)) text = 'Scanned page: no text layer (on-device OCR unavailable)';
        else if (waiting) text = 'Recognizing text…' + (total > 1 ? ' ' + done + ' of ' + total + ' pages' : '');
        else if (failed) text = 'Text recognition failed on this page';
        else if (available && pending.size) text = 'Text recognized on ' + done + ' of ' + total + ' pages';
        status.textContent = text;
        status.hidden = !text;
        status.classList.toggle('busy', waiting && available && !stopped);
    }

    function mount() {
        if (!documentModel.isReader()) return;
        var marked = document.querySelectorAll('.pf[data-reader-ocr="pending"]');
        if (!marked.length) return;
        var hash = entryHash();
        if (!hash) return;
        base = '/r/' + hash + '/ocr';
        for (var i = 0; i < marked.length; i++) pending.set(documentModel.pageNumber(marked[i]), marked[i]);
        total = marked.length;

        status = document.createElement('div');
        status.id = 'pdf2html-ocr-status';
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        status.hidden = true;
        document.body.appendChild(status);

        var root = documentModel.container();
        var queued = false;
        function schedule() {
            if (queued) return;
            queued = true;
            window.requestAnimationFrame(function () { queued = false; updateStatus(); });
        }
        if (root) root.addEventListener('scroll', schedule, { passive: true });
        document.addEventListener('pdf2html-page-change', schedule);
        updateStatus();
        run();
    }

    return { mount: mount };
}

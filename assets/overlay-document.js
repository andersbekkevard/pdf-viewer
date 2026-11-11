// Document structure, text shape, scroll geometry, and light-raster lifecycle.
//
// pdf2htmlEX's page IDs are hexadecimal (`#pf1`, `#pfa`, …), while feature
// code deals in one-based page numbers. Keep that DOM translation — plus the
// canonical/light representation differences — in one place.
export function createDocumentModel(core) {
    var document = core.document;
    var window = core.window;
    var requestAnimationFrame = core.requestAnimationFrame;

    function html() { return document.documentElement; }
    function container() { return document.getElementById('page-container'); }
    // Converted page frames are static. Keep the node list, never geometry:
    // offsets and dimensions still come from fresh rects after zoom/resize.
    var pagesCache = null;
    function pages() {
        if (pagesCache) return pagesCache;
        var root = container();
        if (!root) return [];
        pagesCache = Array.prototype.slice.call(root.querySelectorAll('.pf'));
        return pagesCache;
    }
    function totalPages() { return pages().length; }
    function page(pageNum) {
        if (!pageNum || pageNum < 1) return null;
        return document.getElementById('pf' + pageNum.toString(16));
    }
    function pageNumber(pf) {
        if (!pf || !pf.id) return null;
        var match = pf.id.match(/^pf([0-9a-f]+)$/i);
        return match ? parseInt(match[1], 16) : null;
    }
    function pageFromNode(node) {
        if (!node) return null;
        var element = node.nodeType === 1 ? node : node.parentElement;
        return element && element.closest ? element.closest('.pf') : null;
    }
    function pageNumberFromNode(node) { return pageNumber(pageFromNode(node)); }
    // `#pf1f` (outline and page links, location.hash) → 31, else null.
    // `#page=12` (the standard PDF fragment, decimal) → 12.
    function pageNumberFromHash(hash) {
        var h = String(hash || '');
        var match = h.match(/#pf([0-9a-f]+)$/i);
        if (match) return parseInt(match[1], 16);
        match = h.match(/[#&]page=(\d+)/i);
        return match ? parseInt(match[1], 10) : null;
    }

    // pdf2htmlEX's #outline, flattened in document order: one entry per
    // `a[href="#pfN"]`, carrying its target page and the pdf2htmlEX
    // destination (`data-dest-detail`) when the PDF supplied one. The outline
    // never changes after load, so this is computed once.
    var outlineCache = null;
    function outline() {
        if (outlineCache) return outlineCache;
        var root = document.getElementById('outline');
        var links = root ? root.querySelectorAll('a[href^="#pf"]') : [];
        outlineCache = [];
        for (var i = 0; i < links.length; i++) {
            var page = pageNumberFromHash(links[i].getAttribute('href'));
            if (!page) continue;
            outlineCache.push({
                index: outlineCache.length,
                link: links[i],
                page: page,
                label: (links[i].textContent || '').replace(/\s+/g, ' ').trim(),
                dest: links[i].getAttribute('data-dest-detail'),
                point: readerPoint(links[i]),
            });
        }
        return outlineCache;
    }
    // Reader shells (daemon/reader.py) carry a destination as page px from
    // the page's top-left corner: `data-reader-dest='[page,"XYZ",x,y,null]'`.
    function readerPoint(link) {
        var raw = link.getAttribute('data-reader-dest');
        if (!raw) return null;
        try {
            var dest = JSON.parse(raw);
            return typeof dest[3] === 'number' ? { x: dest[2] || 0, y: dest[3] } : null;
        } catch (_) { return null; }
    }
    function pageContent(pageOrNumber) {
        var pf = typeof pageOrNumber === 'number' ? page(pageOrNumber) : pageOrNumber;
        return pf ? pf.querySelector('.pc') : null;
    }
    function pageText(pageNum) {
        var pc = pageContent(pageNum);
        if (!pc) return '';
        var lines = pc.querySelectorAll('.t');
        if (!lines.length) return (pc.textContent || '').trim();
        var out = [];
        for (var i = 0; i < lines.length; i++) {
            var text = (lines[i].textContent || '').trim();
            if (text) out.push(text);
        }
        return out.join('\n');
    }
    function pageTextBoundaryPosition(pageNum, towardsStart) {
        var pc = pageContent(pageNum);
        if (!pc) return null;
        var walker = document.createTreeWalker(pc, window.NodeFilter.SHOW_TEXT);
        var node, pick = null;
        while ((node = walker.nextNode())) {
            if (!node.nodeValue || node.nodeValue.length === 0) continue;
            pick = node;
            if (towardsStart) break;
        }
        if (!pick) return null;
        return { node: pick, offset: towardsStart ? 0 : pick.nodeValue.length };
    }
    function visiblePages() {
        var root = container();
        if (!root) return [];
        var rootRect = root.getBoundingClientRect();
        return pages().filter(function (pf) {
            var rect = pf.getBoundingClientRect();
            return rect.bottom >= rootRect.top && rect.top <= rootRect.bottom;
        });
    }

    // Scroll geometry. Zoom lives on the `.pf` pages, never on the scroller,
    // so #page-container's scrollTop/clientHeight are screen pixels — the
    // same unit as getBoundingClientRect. A zoomed page's own offsetTop /
    // offsetHeight are in page-local units instead, so page positions are
    // always derived from rects here; feature code must not read `offset*`
    // on a `.pf`. See docs/pdf2htmlex-dom.md, "Zoom and scroll geometry".
    function pageExtent(pf) {
        var root = container();
        if (!root || !pf) return null;
        var rootRect = root.getBoundingClientRect();
        var rect = pf.getBoundingClientRect();
        var top = rect.top - rootRect.top - root.clientTop + root.scrollTop;
        var left = rect.left - rootRect.left - root.clientLeft + root.scrollLeft;
        return { top: top, bottom: top + rect.height, left: left, width: rect.width, height: rect.height };
    }
    // Put the page's top `lead` px below the viewport top. Scrolling to an
    // offset bypasses scroll-padding, unlike scrollIntoView, which would park
    // the page inside the scrolloff band (mid-screen when pinned).
    function scrollToPage(pf, lead, smooth) {
        var root = container();
        var extent = pageExtent(pf);
        if (!root || !extent) return false;
        var top = Math.max(0, extent.top - (lead || 0));
        // A smooth scroll across many pages mounts and renders every page it
        // passes; past a few screens, jump.
        var near = Math.abs(top - root.scrollTop) <= 3 * root.clientHeight;
        root.scrollTo({ top: top, behavior: smooth && near ? 'smooth' : 'instant' });
        if (!near && readerJumped) readerJumped(pf);
        return true;
    }
    // Put a point `y` page px down the page `lead` px below the viewport top.
    // Page px are the frame's own CSS px, so the page's rendered height over
    // its declared height converts them to scroller px at any zoom.
    function scrollToPagePoint(pf, y, lead) {
        var root = container();
        var extent = pageExtent(pf);
        var declared = pf ? parseFloat(pf.style.height) : 0;
        if (!root || !extent || !declared) return false;
        var offset = Math.max(0, Math.min(declared, y)) * extent.height / declared;
        var far = Math.abs(extent.top + offset - root.scrollTop) > root.clientHeight;
        root.scrollTo({ top: Math.max(0, extent.top + offset - (lead || 0)), behavior: 'instant' });
        if (far && readerJumped) readerJumped(pf);
        return true;
    }
    // The page covering most of the viewport (one-based), or null.
    function mostVisiblePage(candidates) {
        var root = container();
        if (!root) return null;
        var box = root.getBoundingClientRect();
        var list = candidates || pages();
        var best = null, bestOverlap = 0;
        for (var i = 0; i < list.length; i++) {
            var rect = list[i].getBoundingClientRect();
            var overlap = Math.min(rect.bottom, box.bottom) - Math.max(rect.top, box.top);
            if (overlap > bestOverlap) { bestOverlap = overlap; best = list[i]; }
        }
        return best ? pageNumber(best) : null;
    }
    // Reading position as the page under the viewport's top-left corner and
    // how far into it, in fractions of the page. Fractions survive anything
    // that rescales pages (our zoom, pdf2htmlEX's own rescale).
    function viewAnchor() {
        var root = container();
        if (!root) return null;
        var all = pages();
        for (var i = 0; i < all.length; i++) {
            var extent = pageExtent(all[i]);
            if (extent.bottom <= root.scrollTop) continue;
            return {
                page: all[i],
                y: (root.scrollTop - extent.top) / extent.height,
                x: extent.width ? (root.scrollLeft - extent.left) / extent.width : 0,
            };
        }
        return null;
    }
    function restoreViewAnchor(anchor) {
        var root = container();
        if (!root || !anchor) return;
        var extent = pageExtent(anchor.page);
        if (!extent) return;
        root.scrollTop = extent.top + anchor.y * extent.height;
        root.scrollLeft = extent.left + anchor.x * extent.width;
    }

    // The explicit marker is the forward contract. Existing generated cache
    // entries still use body/attribute markers, so retain those as fallbacks.
    function representation() {
        if (html() && html().getAttribute('data-pdf2html-representation') === 'light-v1') return 'light-v1';
        if (document.body && document.body.classList.contains('pdf2html-light')) return 'light-legacy';
        return document.querySelector('img.bi[data-pdf2html-src]') ? 'light-legacy' : 'canonical';
    }
    function isLight() { return representation().indexOf('light') === 0; }
    // Reader shells: PDFium rasters under a transparent text layer.
    function isReader() {
        return !!html() && html().getAttribute('data-pdf2html-representation') === 'raster-v1';
    }
    // A reader page whose text has not arrived yet (overlay-readertext.js).
    function isTextPending(pf) { return !!pf && pf.hasAttribute('data-reader-pending'); }
    function textMode() {
        var root = html();
        if (!root) return 'canonical';
        return root.getAttribute('data-pdf2html-text-mode')
            || root.getAttribute('data-pdf2html-text-flattened')
            || 'canonical';
    }
    function isTextFlattened() { return textMode() !== 'canonical'; }

    // Only light documents externalize their raster sources. Page state lives
    // on the frame so other features can observe lifecycle without inspecting
    // individual image attributes: unloaded -> loading -> ready | error.
    function mountRasterLifecycle() {
        var root = container();
        if (!root) return;
        if (isReader()) { mountReaderRasters(root); return; }
        var entries = new Map();

        function setState(entry, state) {
            if (entry.page.dataset.pdf2htmlRasterState !== state) {
                entry.page.dataset.pdf2htmlRasterState = state;
            }
        }
        function sourceFor(img) { return img.getAttribute('data-pdf2html-src'); }
        function updateState(entry) {
            // Completion of an old request must not revive an exited page.
            if (!entry.mounted) return;
            var ready = true, failed = false;
            entry.images.forEach(function (img) {
                if (img.getAttribute('src') !== sourceFor(img) || !img.complete) ready = false;
                else if (!img.naturalWidth) { ready = false; failed = true; }
            });
            setState(entry, failed ? 'error' : ready ? 'ready' : 'loading');
        }
        function load(entry) {
            if (entry.mounted) return;
            entry.mounted = true;
            setState(entry, 'loading');
            entry.images.forEach(function (img) {
                var source = sourceFor(img);
                if (img.getAttribute('src') !== source) img.setAttribute('src', source);
            });
            updateState(entry);
        }
        function unload(entry) {
            if (!entry.mounted) return;
            entry.mounted = false;
            entry.images.forEach(function (img) {
                if (img.hasAttribute('src')) img.removeAttribute('src');
            });
            setState(entry, 'unloaded');
        }

        pages().forEach(function (pf) {
            var images = Array.prototype.slice.call(pf.querySelectorAll('img.bi[data-pdf2html-src]'));
            if (!images.length) return;
            var entry = { page: pf, images: images, mounted: false };
            entries.set(pf, entry);
            images.forEach(function (img) {
                img.addEventListener('load', function () { updateState(entry); });
                img.addEventListener('error', function () { updateState(entry); });
                // Converter-eager sources are handled by the same lifecycle.
                if (img.hasAttribute('src')) img.removeAttribute('src');
            });
            setState(entry, 'unloaded');
        });
        if (!entries.size) return;

        // Observe page frames, whose geometry is available even while their
        // content-visibility subtree is skipped. Scrolling, resize, zoom and
        // far native-find jumps update intersections without an O(book) scan.
        var observer = new window.IntersectionObserver(function (changes) {
            // Drop the old window before mounting the new one on distant jumps.
            changes.forEach(function (change) {
                if (!change.isIntersecting) unload(entries.get(change.target));
            });
            changes.forEach(function (change) {
                if (change.isIntersecting) load(entries.get(change.target));
            });
        }, { root: root, rootMargin: '3500px 0px', threshold: 0 });
        entries.forEach(function (entry) { observer.observe(entry.page); });

    }

    // Reader rasters (daemon/reader.py, docs/reader.md "Rasters"). One JPEG per
    // page, rendered at the page's exact device width. What a page holds:
    //
    //   near (within NEAR_MARGIN of the viewport)  the raster at the current
    //       width; fetched in order, pages on screen first, at most
    //       MAX_REQUESTS at a time.
    //   kept (within KEEP_MARGIN)  whatever it has; nothing new is fetched.
    //   beyond                      nothing: the image is released, so the
    //       browser's decoded rasters stay bounded however far one reads.
    //
    // A new raster is fetched and decoded off-screen and only then swapped in,
    // so the page never goes blank or shows a half-decoded image; until then
    // the old raster stays, scaled by the browser (zoom, resize). After a zoom
    // the sharp request waits until the zoom has been still for ZOOM_SETTLE_MS,
    // and requests for a width or page no longer wanted are cancelled at once:
    // the daemon drops a queued render whose request went away.
    var NEAR_MARGIN = '100% 0px', KEEP_MARGIN = '300% 0px';
    // A page without a raster shows this transparent pixel, never no source.
    // Chromium gives an image that gets its source while its page is still
    // content-visibility-skipped no layout box when the page is un-skipped a
    // frame later: the raster is loaded and decoded but the page stays white
    // until something reattaches the image (seen after a far jump back to a
    // released page; scripts/verify-overlay.cjs "on-screen pages paint").
    // Going from one image to another never takes that path.
    var PLACEHOLDER = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    var MAX_REQUESTS = 3, ZOOM_SETTLE_MS = 120;
    // A page on screen with nothing to show (a far jump, a scrollbar drag)
    // first gets a raster at 1/PREVIEW_DIVISOR of its width, which renders and
    // decodes several times faster; the sharp one replaces it. 0 disables.
    var PREVIEW_DIVISOR = 2;
    function mountReaderRasters(root) {
        var entries = new Map();
        var order = [];
        var inflight = 0;
        var holdUntil = 0, holdTimer = null, pumpQueued = false;
        var scale = currentScale();

        function currentScale() {
            var zoom = parseFloat(root.style.getPropertyValue('--pdf2html-zoom')) || 1;
            return zoom * (window.devicePixelRatio || 1);
        }
        function want(entry, divisor) {
            return entry.base + Math.max(64, Math.round(entry.cssWidth * scale / (divisor || 1))) + '.jpg';
        }
        function setState(entry, state) {
            if (entry.page.dataset.pdf2htmlRasterState !== state) entry.page.dataset.pdf2htmlRasterState = state;
        }
        function updateState(entry) {
            if (!entry.kept && !entry.near) setState(entry, 'unloaded');
            else if (entry.shown === want(entry)) setState(entry, 'ready');
            else if (entry.failed === want(entry)) setState(entry, 'error');
            else setState(entry, entry.near ? 'loading' : entry.shown ? 'ready' : 'unloaded');
        }
        function cancel(entry) {
            cancelPreview(entry);
            var job = entry.job;
            if (!job) return;
            entry.job = null;
            inflight -= 1;
            // Dropping the source aborts the request; its decode() rejects.
            job.image.removeAttribute('src');
        }
        function cancelPreview(entry) {
            var job = entry.preview;
            if (!job) return;
            entry.preview = null;
            job.image.removeAttribute('src');
        }
        function release(entry) {
            cancel(entry);
            entry.failed = null;
            if (entry.img.getAttribute('src') !== PLACEHOLDER) entry.img.setAttribute('src', PLACEHOLDER);
            entry.shown = null;
            updateState(entry);
        }
        function start(entry, url, preview) {
            var image = new window.Image();
            var job = { url: url, image: image };
            if (preview) entry.preview = job;
            else { entry.job = job; inflight += 1; }
            image.src = url;
            function finish(ok) {
                if (preview) {
                    if (entry.preview !== job) return;
                    entry.preview = null;
                    // Only into an empty page: never over a sharp or scaled raster.
                    if (ok && !entry.shown) {
                        entry.img.setAttribute('src', url);
                        entry.shown = url;
                    }
                    return;
                }
                if (entry.job !== job) return;   // cancelled or superseded
                entry.job = null;
                inflight -= 1;
                cancelPreview(entry);
                if (ok) {
                    entry.img.setAttribute('src', url);
                    entry.shown = url;
                } else {
                    entry.failed = url;
                }
                updateState(entry);
                schedule();
            }
            (image.decode ? image.decode() : new Promise(function (ok, fail) {
                image.onload = ok; image.onerror = fail;
            })).then(function () { finish(true); }, function () { finish(!!(image.complete && image.naturalWidth)); });
        }
        function visible(entry) { return entry.visible; }
        // Requests in the order they should go out: pages on screen first, then
        // outward from them.
        function pump() {
            pumpQueued = false;
            var now = Date.now();
            if (now < holdUntil) {
                if (!holdTimer) holdTimer = window.setTimeout(function () { holdTimer = null; pump(); }, holdUntil - now);
                return;
            }
            var anchor = -1;
            for (var i = 0; i < order.length; i++) if (order[i].visible) { anchor = i; break; }
            var wanted = [];
            for (var k = 0; k < order.length; k++) {
                var entry = order[k];
                if (!entry.near) continue;
                var url = want(entry);
                if (entry.shown === url || entry.failed === url) continue;
                if (entry.job && entry.job.url === url) continue;
                wanted.push({ entry: entry, url: url, rank: entry.visible ? -1 : Math.abs(k - anchor) });
            }
            wanted.sort(function (a, b) { return a.rank - b.rank; });
            if (PREVIEW_DIVISOR) {
                for (var v = 0; v < wanted.length && wanted[v].rank < 0; v++) {
                    var e = wanted[v].entry;
                    if (!e.shown && !e.preview && !(e.job && e.job.url === wanted[v].url)) {
                        start(e, want(e, PREVIEW_DIVISOR), true);
                    }
                }
            }
            for (var w = 0; w < wanted.length; w++) {
                var item = wanted[w];
                if (item.entry.job) cancel(item.entry);   // a stale width
                if (inflight >= MAX_REQUESTS) {
                    if (item.rank >= 0) break;
                    // A page on screen does not wait behind prefetches.
                    var victim = null;
                    entries.forEach(function (e) { if (e.job && !e.visible && !victim) victim = e; });
                    if (!victim) break;
                    cancel(victim);
                }
                start(item.entry, item.url);
            }
        }
        function schedule() {
            if (pumpQueued) return;
            pumpQueued = true;
            Promise.resolve().then(pump);
        }
        // The page's width on screen changed (zoom, window, display): the shown
        // rasters stay, scaled, and requests for the old width are dropped now;
        // new ones go out once the change has settled.
        function rescale() {
            var next = currentScale();
            if (next === scale) { schedule(); return; }
            scale = next;
            holdUntil = Date.now() + ZOOM_SETTLE_MS;
            entries.forEach(function (entry) {
                if (entry.job && entry.job.url !== want(entry)) cancel(entry);
                updateState(entry);
            });
            schedule();
        }

        pages().forEach(function (pf) {
            var img = pf.querySelector('img.bi[data-reader-raster]');
            if (!img) return;
            var entry = {
                page: pf, img: img, base: img.getAttribute('data-reader-raster'),
                cssWidth: parseFloat(pf.style.width) || 0,
                near: false, kept: false, visible: false, shown: null, failed: null, job: null, preview: null,
            };
            if (!entry.cssWidth) return;
            img.setAttribute('src', PLACEHOLDER);
            entries.set(pf, entry);
            order.push(entry);
            setState(entry, 'unloaded');
        });
        if (!entries.size) return;

        function observe(margin, apply) {
            var observer = new window.IntersectionObserver(function (changes) {
                changes.forEach(function (change) {
                    var entry = entries.get(change.target);
                    if (entry) apply(entry, change.isIntersecting);
                });
                schedule();
            }, { root: root, rootMargin: margin, threshold: 0 });
            entries.forEach(function (entry) { observer.observe(entry.page); });
        }
        observe('0px', function (entry, on) { entry.visible = on; });
        observe(NEAR_MARGIN, function (entry, on) {
            entry.near = on;
            if (!on) { cancel(entry); entry.failed = null; }
            updateState(entry);
        });
        observe(KEEP_MARGIN, function (entry, on) {
            entry.kept = on;
            if (!on) release(entry);
        });
        // The first observer reports come a frame after mounting; the pages on
        // screen now (found by bisection, frames are in document order) are
        // asked for at once, which is the first page of a fresh open.
        (function kick() {
            var box = root.getBoundingClientRect();
            var lo = 0, hi = order.length - 1;
            while (lo < hi) {
                var mid = (lo + hi) >> 1;
                if (order[mid].page.getBoundingClientRect().bottom < box.top) lo = mid + 1; else hi = mid;
            }
            for (var i = lo; i < order.length && i < lo + 4; i++) {
                if (order[i].page.getBoundingClientRect().top > box.bottom) break;
                order[i].near = order[i].kept = order[i].visible = true;
            }
            pump();
        })();
        // A jump lands before the observers report: ask for the target first.
        readerJumped = function (pf) {
            var entry = entries.get(pf);
            if (!entry || entry.near) return;
            entry.near = entry.kept = entry.visible = true;
            pump();
        };
        document.addEventListener('pdf2html-viewport-change', rescale);
        window.addEventListener('resize', rescale);
    }
    var readerJumped = null;

    return {
        container: container,
        pages: pages,
        totalPages: totalPages,
        page: page,
        pageNumber: pageNumber,
        pageFromNode: pageFromNode,
        pageNumberFromNode: pageNumberFromNode,
        pageNumberFromHash: pageNumberFromHash,
        outline: outline,
        pageContent: pageContent,
        pageText: pageText,
        pageTextBoundaryPosition: pageTextBoundaryPosition,
        visiblePages: visiblePages,
        pageExtent: pageExtent,
        scrollToPage: scrollToPage,
        scrollToPagePoint: scrollToPagePoint,
        mostVisiblePage: mostVisiblePage,
        viewAnchor: viewAnchor,
        restoreViewAnchor: restoreViewAnchor,
        representation: representation,
        isLight: isLight,
        isReader: isReader,
        isTextPending: isTextPending,
        textMode: textMode,
        isTextFlattened: isTextFlattened,
        mountRasterLifecycle: mountRasterLifecycle,
    };
}

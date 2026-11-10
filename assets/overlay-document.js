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
        root.scrollTo({ top: Math.max(0, extent.top + offset - (lead || 0)), behavior: 'instant' });
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
        var entries = new Map();

        function setState(entry, state) {
            if (entry.page.dataset.pdf2htmlRasterState !== state) {
                entry.page.dataset.pdf2htmlRasterState = state;
            }
        }
        // A reader raster is rendered at the width asked for, so ask for the
        // page's exact device width: declared CSS width × zoom × pixel ratio.
        // Anything else has one fixed source.
        function sourceFor(img) {
            var base = img.getAttribute('data-reader-raster');
            if (!base) return img.getAttribute('data-pdf2html-src');
            var pf = img.closest('.pf');
            var cssWidth = pf ? parseFloat(pf.style.width) : 0;
            var zoom = parseFloat(root.style.getPropertyValue('--pdf2html-zoom')) || 1;
            if (!cssWidth) return img.getAttribute('data-pdf2html-src');
            return base + Math.max(64, Math.round(cssWidth * zoom * (window.devicePixelRatio || 1))) + '.png';
        }
        // After a zoom or resize: keep showing the old raster, scaled, until
        // the one at the new width has loaded, then swap.
        function retarget(entry) {
            if (!entry.mounted) return;
            entry.images.forEach(function (img) {
                var want = sourceFor(img);
                if (img.getAttribute('src') === want) return;
                if (!img.complete || !img.naturalWidth) { img.setAttribute('src', want); return; }
                var next = new window.Image();
                next.onload = function () {
                    if (entry.mounted && sourceFor(img) === want) img.setAttribute('src', want);
                };
                next.src = want;
            });
        }
        function updateState(entry) {
            // Completion of an old request must not revive an exited page.
            if (!entry.mounted) return;
            var ready = true, failed = false;
            entry.images.forEach(function (img) {
                var fixed = !img.getAttribute('data-reader-raster');
                if ((fixed ? img.getAttribute('src') !== sourceFor(img) : !img.hasAttribute('src')) || !img.complete) ready = false;
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

        if (!isReader()) return;
        var timer = null;
        function retargetAll() {
            timer = null;
            entries.forEach(retarget);
        }
        // Debounced: a zoom slider drag or window resize fires many changes.
        function schedule() {
            if (timer) window.clearTimeout(timer);
            timer = window.setTimeout(retargetAll, 120);
        }
        document.addEventListener('pdf2html-viewport-change', schedule);
        window.addEventListener('resize', schedule);
    }

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
        textMode: textMode,
        isTextFlattened: isTextFlattened,
        mountRasterLifecycle: mountRasterLifecycle,
    };
}

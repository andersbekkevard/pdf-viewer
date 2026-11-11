// Reading position: current-page tracking, chapters, jumps, marks and resume.
//
// Events (on document):
//   pdf2html-page-change     {page}   the page covering most of the viewport
//   pdf2html-chapter-change  {entry}  the outline entry the reader is in, or null
// Listen for `pdf2html-viewport-change` to re-measure after zoom or restore.
//
// Two jump kinds, so every entry point lands the same way:
//   - page jumps put the page top PAGE_LEAD px below the viewport top;
//   - chapter jumps go to the outline entry's point on its page (its
//     heading at the viewport top), falling back to a page jump.
export function createNavigation(core) {
    var document = core.document;
    var window = core.window;
    var location = core.location;
    var history = core.history;
    var documentState = core.documentState;
    var entryHash = core.entryHash;
    var documentModel = core.documentModel;
    var requestAnimationFrame = core.requestAnimationFrame;

    // A sliver of the inter-page gap stays visible: a clear "top of a page"
    // cue without showing the previous page's content.
    var PAGE_LEAD = 8;
    // `C` mid-chapter goes back to the chapter start first, unless the reader
    // is within this many pages of it.
    var CHAPTER_NEAR_THRESHOLD = 2;

    var currentPage = 1;
    var currentChapter = null;
    // The entry the reader last jumped to. Several entries can share a page;
    // the explicit pick wins over the "deepest entry on this page" rule until
    // the reader leaves that page.
    var pickedEntry = null;

    // ---------------------------------------------------------------- chapters
    function entries() { return documentModel.outline(); }

    // Deepest entry at or before `page` in document order, or null.
    function chapterAt(page) {
        if (pickedEntry && pickedEntry.page === page) return pickedEntry;
        var list = entries(), found = null;
        for (var i = 0; i < list.length; i++) if (list[i].page <= page) found = list[i];
        return found;
    }
    // One entry per page, in page order: the chapter boundaries for c/C,
    // page ranges and yank.
    function chapterStarts() {
        var seen = {};
        return entries().slice().sort(function (a, b) { return a.page - b.page; })
            .filter(function (e) { if (seen[e.page]) return false; seen[e.page] = true; return true; });
    }
    // [start, end) pages of the chapter containing `page`; end is the next
    // entry on a later page, or the document end.
    function chapterRange(page) {
        if (!page || page < 1) return null;
        var starts = chapterStarts();
        if (!starts.length) return null;
        var idx = 0;
        for (var i = 0; i < starts.length; i++) { if (starts[i].page <= page) idx = i; else break; }
        var start = starts[idx].page;
        var next = starts[idx + 1];
        return {
            start: start,
            end: next ? next.page : documentModel.totalPages() + 1,
            label: (chapterAt(page) || starts[idx]).label,
        };
    }
    function chapterLabel() {
        var entry = chapterAt(currentPage);
        return entry ? entry.label : '';
    }

    // ------------------------------------------------------------------ history
    // Where the reader was before each jump, so a jump can be undone (⌘Z)
    // and redone (⌘⇧Z). A position is a page and how far into it, which
    // survives a zoom change. Jumps made through this module are recorded
    // by `remember`; jumps made elsewhere (Vimium gg/G, the browser's find,
    // Home/End) are recognised in the tracker as a scroll of several screens
    // in one event.
    var HISTORY_MAX = 50;
    var backStack = [];
    var forwardStack = [];
    var quietUntil = 0;

    function here() {
        var anchor = documentModel.viewAnchor();
        var page = anchor && documentModel.pageNumber(anchor.page);
        return page ? { page: page, y: anchor.y, x: anchor.x } : null;
    }
    function samePlace(a, b) {
        return !!a && !!b && a.page === b.page && Math.abs(a.y - b.y) < 0.05;
    }
    // The scroll that follows is ours (or not a navigation): do not let the
    // tracker record it a second time.
    function quiet() { quietUntil = Date.now() + 250; }
    function remember(position) {
        position = position || here();
        quiet();
        if (!position || samePlace(backStack[backStack.length - 1], position)) return;
        backStack.push(position);
        if (backStack.length > HISTORY_MAX) backStack.shift();
        forwardStack.length = 0;
    }
    function travel(from, to) {
        var position = from.pop();
        if (!position) return null;
        var target = documentModel.page(position.page);
        if (!target) return null;
        var current = here();
        if (current) to.push(current);
        quiet();
        documentModel.restoreViewAnchor({ page: target, y: position.y, x: position.x });
        return position;
    }
    // Each returns the position it went to ({page, y, x}), or null.
    function back() { return travel(backStack, forwardStack); }
    function forward() { return travel(forwardStack, backStack); }

    // -------------------------------------------------------------------- jumps
    // landPage is the bare scroll; the public jumps record where they left.
    function landPage(n, smooth) {
        var target = documentModel.page(n);
        if (!target) return false;
        documentModel.scrollToPage(target, PAGE_LEAD, smooth);
        return true;
    }
    function gotoPage(n, smooth) {
        if (!documentModel.page(n)) return false;
        remember();
        return landPage(n, smooth);
    }
    function stepPage(delta) {
        var total = documentModel.totalPages();
        if (!total) return;
        // A single page turn is reading, not a jump to come back from.
        if (Math.abs(delta) > 1) remember();
        landPage(Math.min(total, Math.max(1, currentPage + delta)), false);
    }
    // A reader outline entry names a point on its page; land the heading at
    // the viewport top, as a PDF XYZ destination does.
    function gotoPoint(entry) {
        var target = entry.point && documentModel.page(entry.page);
        return !!target && documentModel.scrollToPagePoint(target, entry.point.y, 0);
    }
    // A reader link destination: `point` is {x, y} in the target page's px,
    // or null for the page top. Lands exactly as an outline jump does.
    function gotoDestination(page, point) {
        remember();
        return gotoPoint({ page: page, point: point }) || landPage(page, false);
    }
    function gotoEntry(entry) {
        if (!entry) return;
        remember();
        pickedEntry = entry;
        if (!gotoPoint(entry)) landPage(entry.page, false);
        updateChapter();
    }
    function gotoChapter(needle) {
        if (!needle) return;
        var n = String(needle).toLowerCase().trim(), exact = null, sub = null;
        var list = entries();
        for (var i = 0; i < list.length; i++) {
            var label = list[i].label.toLowerCase();
            if (label === n) { exact = list[i]; break; }
            if (!sub && label.indexOf(n) !== -1) sub = list[i];
        }
        gotoEntry(exact || sub);
    }
    function gotoChapterBy(delta) {
        var starts = chapterStarts();
        if (!starts.length || !delta) return;
        var idx = -1;
        for (var i = 0; i < starts.length; i++) { if (starts[i].page <= currentPage) idx = i; else break; }
        var target;
        if (delta > 0) target = idx === -1 ? 0 : idx + delta;
        else if (delta === -1) {
            if (idx === -1) return;
            target = currentPage - starts[idx].page >= CHAPTER_NEAR_THRESHOLD ? idx : idx - 1;
        } else {
            if (idx === -1) return;
            target = idx + delta;
        }
        gotoEntry(starts[Math.min(starts.length - 1, Math.max(0, target))]);
    }

    // -------------------------------------------------------------------- marks
    // Stored through the document state (overlay-state.js) with per-letter
    // ts; a cleared mark stays as a {deleted, ts} tombstone so another
    // browser's stale copy cannot bring it back. marks() hides tombstones.
    function storedMarks() {
        var all = documentState.get('marks');
        return all && typeof all === 'object' ? Object.assign({}, all) : {};
    }
    function marks() {
        var all = storedMarks(), live = {};
        for (var l in all) if (all[l] && !all[l].deleted && all[l].page) live[l] = all[l];
        return live;
    }
    function saveMarks(value) { if (entryHash()) documentState.set('marks', value); }
    function markLetter(value) {
        if (!value) return null;
        var match = String(value).trim().match(/^([a-zA-Z])/);
        return match ? match[1].toLowerCase() : null;
    }
    // Each returns {letter, page} for what it acted on, or null.
    function setMark(value) {
        var letter = markLetter(value); if (!letter) return null;
        var all = storedMarks(); all[letter] = { page: currentPage, label: chapterLabel(), ts: Date.now() }; saveMarks(all);
        return { letter: letter, page: currentPage };
    }
    function gotoMark(value) {
        var letter = markLetter(value), mark = letter && marks()[letter];
        if (!mark || !mark.page || !gotoPage(mark.page, true)) return null;
        return { letter: letter, page: mark.page };
    }
    function clearMark(value) {
        var letter = markLetter(value); if (!letter) return null;
        var mark = marks()[letter];
        if (!mark) return null;
        var all = storedMarks(); all[letter] = { deleted: true, ts: Date.now() }; saveMarks(all);
        return { letter: letter, page: mark.page };
    }

    // ----------------------------------------------------------------- tracking
    // The one current-page tracker. An IntersectionObserver keeps the overlap
    // scan to the few pages near the viewport; it falls back to every page if
    // that set is stale.
    function updateChapter() {
        var entry = chapterAt(currentPage);
        if (entry === currentChapter) return;
        currentChapter = entry;
        document.dispatchEvent(new CustomEvent('pdf2html-chapter-change', { detail: { entry: entry } }));
    }
    function mountTracking() {
        var container = documentModel.container();
        var pages = documentModel.pages();
        if (!container || !pages.length) return;
        var visible = new Set();
        var lastPage = -1;
        var raf = null;

        function update() {
            raf = null;
            var candidates = visible.size ? Array.from(visible) : pages;
            var n = documentModel.mostVisiblePage(candidates)
                || (candidates === pages ? null : documentModel.mostVisiblePage(pages));
            if (!n || n === lastPage) return;
            lastPage = currentPage = n;
            if (pickedEntry && pickedEntry.page !== n) pickedEntry = null;
            document.dispatchEvent(new CustomEvent('pdf2html-page-change', { detail: { page: n } }));
            updateChapter();
        }
        function sched() { if (!raf) raf = requestAnimationFrame(update); }

        var observer = new window.IntersectionObserver(function (changes) {
            for (var i = 0; i < changes.length; i++) {
                if (changes[i].isIntersecting) visible.add(changes[i].target);
                else visible.delete(changes[i].target);
            }
            sched();
        }, { root: container, rootMargin: '-20px 0px', threshold: 0 });
        pages.forEach(function (p) { observer.observe(p); });
        // A scroll of several screens in one event is a jump made outside
        // this module; record where it left from. `currentPage` is still the
        // page before the jump here, because the tracker runs a frame later.
        var lastTop = container.scrollTop;
        container.addEventListener('scroll', function () {
            var top = container.scrollTop;
            if (Math.abs(top - lastTop) > 2.5 * container.clientHeight && Date.now() > quietUntil) {
                var extent = documentModel.pageExtent(documentModel.page(currentPage));
                if (extent && extent.height) {
                    remember({ page: currentPage, y: (lastTop - extent.top) / extent.height, x: 0 });
                    quietUntil = 0;
                }
            }
            lastTop = top;
            sched();
        }, { passive: true });
        // Zoom and restores move content without a reliable scroll event.
        document.addEventListener('pdf2html-viewport-change', function () {
            quiet();
            sched();
            setTimeout(sched, 80);
            setTimeout(sched, 250);
        });
        sched();
    }

    // ------------------------------------------------------------------- resume
    // Jump back to the last-visited page on reopen.
    //
    // Stored through the document state as `position` → {page}: the local
    // copy (`pdf2html-position:<hash>`) is read at init, the daemon copy may
    // arrive a moment later. Written on every page change (debounced 400ms),
    // but only once the daemon read has merged, so a fresh browser's page-1
    // start cannot outrank the position another browser saved.
    //
    // A daemon position that arrives after load moves the reader only while
    // the page is still where it opened: not after a `#pf` deep link, and
    // not once the reader has scrolled.
    //
    // The URL hash and the saved position must not fight each other:
    //   - A `#pfXX` deep link (outline/bookmark) wins on load, but native
    //     anchoring is unreliable here — pages under content-visibility
    //     land at the top before late layout, so we actively scroll to the
    //     target ourselves.
    //   - Once the reader scrolls away from that target the writer strips the
    //     now-stale `#pfXX`, so the next reload takes the saved-position path
    //     instead of re-anchoring to a page they already left.
    //   - Any other hash (`#foo`) is treated as no
    //     hash: strip it (else the browser's own anchor scroll fights the
    //     restore) and resume normally.
    // Saved page 1 is treated as "nothing to resume."
    function mountResume() {
        var hash = entryHash();
        if (!hash) return;

        function stripHash() {
            try { history.replaceState(null, '', location.pathname + location.search); } catch (_) {}
        }
        // Wait a frame so the zoom and layout have settled, then land the page.
        // A restore in flight can be retargeted; `landedPage` is where the
        // document opened (1 when nothing was restored).
        var restoreTarget = null;
        var landedPage = 1;
        function restore(page) {
            var running = restoreTarget != null;
            restoreTarget = page;
            if (running) return;
            var tries = 0;
            requestAnimationFrame(function go() {
                var pf = documentModel.page(restoreTarget);
                if (pf && pf.getBoundingClientRect().height > 0) {
                    landedPage = restoreTarget;
                    restoreTarget = null;
                    quiet();
                    landPage(landedPage, false);
                    document.dispatchEvent(new CustomEvent('pdf2html-viewport-change'));
                    return;
                }
                if (tries++ < 60) requestAnimationFrame(go);
                else restoreTarget = null;
            });
        }
        function savedPage() {
            var saved = documentState.get('position');
            return saved && saved.page > 1 ? saved.page : null;
        }

        var hashPage = documentModel.pageNumberFromHash(location.hash);
        if (hashPage) {
            restore(hashPage);
        } else {
            if (location.hash) stripHash();
            if (savedPage()) restore(savedPage());
        }
        documentState.onChange('position', function () {
            if (hashPage) return;
            var page = savedPage();
            if (!page) return;
            if (restoreTarget != null) { restoreTarget = page; return; }
            var now = documentModel.mostVisiblePage(documentModel.pages());
            if (now && now !== landedPage) return;
            if (page !== now) restore(page);
        });

        var writeTimer = null;
        var lastWritten = null;
        var pendingPage = null;
        function flush(force) {
            if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
            if (pendingPage == null) return;
            // Mid-restore pages are transit, not reading; the landing fires
            // its own page change.
            if (!force && restoreTarget != null) return;
            var p = pendingPage;
            pendingPage = null;
            documentState.set('position', { page: p });
            lastWritten = p;
            // Keep the URL hash honest: a stale `#pfXX` would re-anchor on the
            // next reload and skip the saved-position restore.
            var hp = documentModel.pageNumberFromHash(location.hash);
            if (hp != null && hp !== p) stripHash();
        }
        document.addEventListener('pdf2html-page-change', function (e) {
            var p = e.detail && e.detail.page;
            if (!p || p < 1) return;
            pendingPage = p;
            if (writeTimer) clearTimeout(writeTimer);
            writeTimer = setTimeout(function () {
                writeTimer = null;
                documentState.ready.then(function () { flush(false); });
            }, 400);
        });
        // A reload/close inside the debounce window would lose the last
        // movement; flush synchronously on pagehide.
        window.addEventListener('pagehide', function () {
            if (pendingPage != null && pendingPage !== lastWritten) flush(true);
        });
    }

    function init() {
        mountTracking();
        mountResume();
    }

    return {
        init: init,
        page: function () { return currentPage; },
        chapter: function () { return currentChapter; },
        entries: entries,
        chapterAt: chapterAt,
        chapterStarts: chapterStarts,
        chapterRange: chapterRange,
        chapterLabel: chapterLabel,
        gotoPage: gotoPage,
        stepPage: stepPage,
        gotoEntry: gotoEntry,
        gotoDestination: gotoDestination,
        back: back,
        forward: forward,
        remember: function () { remember(); },
        // The next scroll is not a jump to record (quick open's previews).
        quiet: quiet,
        gotoChapter: gotoChapter,
        gotoChapterBy: gotoChapterBy,
        marks: marks,
        markLetter: markLetter,
        setMark: setMark,
        gotoMark: gotoMark,
        clearMark: clearMark,
    };
}

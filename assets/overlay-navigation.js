// Reading position: current-page tracking, chapters, jumps, marks and resume.
//
// Events (on document):
//   pdf2html-page-change     {page}   the page covering most of the viewport
//   pdf2html-chapter-change  {entry}  the outline entry the reader is in, or null
// Listen for `pdf2html-viewport-change` to re-measure after zoom or restore.
//
// Two jump kinds, so every entry point lands the same way:
//   - page jumps put the page top PAGE_LEAD px below the viewport top;
//   - chapter jumps go to the outline entry's pdf2htmlEX destination (its
//     heading at the viewport top), falling back to a page jump.
export function createNavigation(core) {
    var document = core.document;
    var window = core.window;
    var location = core.location;
    var history = core.history;
    var storage = core.storage;
    var entryHash = core.entryHash;
    var documentModel = core.documentModel;
    var followDestination = core.followDestination;
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

    // -------------------------------------------------------------------- jumps
    function gotoPage(n, smooth) {
        var target = documentModel.page(n);
        if (!target) return false;
        documentModel.scrollToPage(target, PAGE_LEAD, smooth);
        return true;
    }
    function stepPage(delta) {
        var total = documentModel.totalPages();
        if (!total) return;
        gotoPage(Math.min(total, Math.max(1, currentPage + delta)), false);
    }
    // A reader outline entry names a point on its page; land the heading at
    // the same lead as a page top.
    function gotoPoint(entry) {
        var target = entry.point && documentModel.page(entry.page);
        return !!target && documentModel.scrollToPagePoint(target, entry.point.y, PAGE_LEAD);
    }
    function gotoEntry(entry) {
        if (!entry) return;
        pickedEntry = entry;
        if (!followDestination(entry.link) && !gotoPoint(entry)) gotoPage(entry.page, false);
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
    function marksKey() { var hash = entryHash(); return hash ? 'pdf2html-marks:' + hash : null; }
    function marks() {
        var key = marksKey(); if (!key) return {};
        try { return JSON.parse(storage.getItem(key) || '{}') || {}; } catch (_) { return {}; }
    }
    function saveMarks(value) { var key = marksKey(); if (key) try { storage.setItem(key, JSON.stringify(value)); } catch (_) {} }
    function markLetter(value) {
        if (!value) return null;
        var match = String(value).trim().match(/^([a-zA-Z])/);
        return match ? match[1].toLowerCase() : null;
    }
    function setMark(value) {
        var letter = markLetter(value); if (!letter) return;
        var all = marks(); all[letter] = { page: currentPage, label: chapterLabel(), ts: Date.now() }; saveMarks(all);
    }
    function gotoMark(value) {
        var letter = markLetter(value), mark = letter && marks()[letter];
        if (mark && mark.page) gotoPage(mark.page, true);
    }
    function clearMark(value) {
        var letter = markLetter(value); if (!letter) return;
        var all = marks(); if (!all[letter]) return; delete all[letter]; saveMarks(all);
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
        container.addEventListener('scroll', sched, { passive: true });
        // Zoom and restores move content without a reliable scroll event.
        document.addEventListener('pdf2html-viewport-change', function () {
            sched();
            setTimeout(sched, 80);
            setTimeout(sched, 250);
        });
        sched();
    }

    // ------------------------------------------------------------------- resume
    // Jump back to the last-visited page on reopen.
    //
    // Key: `pdf2html-position:<hash>` → JSON {page, ts}. Written on every
    // page change (debounced 400ms); read once at init.
    //
    // The URL hash and the saved position must not fight each other:
    //   - A `#pfXX` deep link (outline/bookmark) wins on load, but native
    //     anchoring is unreliable here — pdf2htmlEX pages + content-visibility
    //     land at the top before late layout, so we actively scroll to the
    //     target ourselves.
    //   - Once the reader scrolls away from that target the writer strips the
    //     now-stale `#pfXX`, so the next reload takes the saved-position path
    //     instead of re-anchoring to a page they already left.
    //   - Any other hash (`#foo`, a pdf2htmlEX view hash) is treated as no
    //     hash: strip it (else the browser's own anchor scroll fights the
    //     restore) and resume normally.
    // Saved page 1 is treated as "nothing to resume."
    function mountResume() {
        var hash = entryHash();
        if (!hash) return;
        var key = 'pdf2html-position:' + hash;

        function stripHash() {
            try { history.replaceState(null, '', location.pathname + location.search); } catch (_) {}
        }
        // Wait a frame so the zoom and layout have settled, then land the page.
        function restore(page) {
            var tries = 0;
            (function go() {
                var pf = documentModel.page(page);
                if (pf && pf.getBoundingClientRect().height > 0) {
                    gotoPage(page, false);
                    document.dispatchEvent(new CustomEvent('pdf2html-viewport-change'));
                    return;
                }
                if (tries++ < 60) requestAnimationFrame(go);
            })();
        }

        var hashPage = documentModel.pageNumberFromHash(location.hash);
        if (hashPage) {
            requestAnimationFrame(function () { restore(hashPage); });
        } else {
            if (location.hash) stripHash();
            var saved = null;
            try { saved = JSON.parse(storage.getItem(key) || 'null'); } catch (_) {}
            if (saved && saved.page > 1) requestAnimationFrame(function () { restore(saved.page); });
        }

        var writeTimer = null;
        var lastWritten = null;
        var pendingPage = null;
        function flush() {
            if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
            if (pendingPage == null) return;
            var p = pendingPage;
            pendingPage = null;
            try { storage.setItem(key, JSON.stringify({ page: p, ts: Date.now() })); } catch (_) {}
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
            writeTimer = setTimeout(flush, 400);
        });
        // A reload/close inside the debounce window would lose the last
        // movement; flush synchronously on pagehide.
        window.addEventListener('pagehide', function () {
            if (pendingPage != null && pendingPage !== lastWritten) flush();
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
        gotoChapter: gotoChapter,
        gotoChapterBy: gotoChapterBy,
        marks: marks,
        markLetter: markLetter,
        setMark: setMark,
        gotoMark: gotoMark,
        clearMark: clearMark,
    };
}

// `/` search — find in the visible pages.
//
// Distinct from Vimium's / and from ⌘F: scope is the pages currently
// intersecting the viewport at the moment of typing, and the viewport never
// moves while typing. The reader refines the query without the page jumping
// around; Enter is the explicit "take me there" action.
//
//   / or s   open the bar (stolen from Vimium via a capture-phase handler)
//   typing   live highlight across visible .pf frames — no scroll
//   Enter    activate the hit needing the least scroll, scroll it into the
//            scrolloff band, promote it to a browser Selection, then hide
//            the bar (highlights persist — nvim hlsearch)
//   n / N    next / prev hit while highlights live
//   Esc      clear highlights; if the bar is still open, close that too
//
// Highlights use the CSS Custom Highlight API so we don't wrap nodes inside
// the positioned .t spans (whose fitted widths DOM surgery would visibly
// break).
import { removeOverlay } from './overlay-dom.js';

export function createSearch(core) {
    var document = core.document;
    var window = core.window;
    var Range = core.Range;
    var NodeFilter = core.NodeFilter;
    var Highlight = core.Highlight;
    var CSS = core.CSS;
    var el = core.el;
    var isInputTarget = core.isInputTarget;
    var prefs = core.prefs;
    var documentModel = core.documentModel;
    var scrollOff = core.scrollOff;
    var isFingerActive = core.isFingerActive;

    var searchState = { hits: [], activeIdx: -1, entered: false };

    // Single capture-phase handler owns every key that matters to search.
    // Listen on WINDOW at capture so we fire before any document- or
    // input-level listener (Vimium and friends hook those and can otherwise
    // swallow Enter / Esc before we see them).
    function mount() {
        prefs.onChange('searchCaseSensitive', function () {
            var input = document.getElementById('pdf2html-search-input');
            if (input) refresh(input.value);
        });
        window.addEventListener('keydown', function (e) {
            // Finger mode owns its alphabet while active. Search is also a
            // window-capture listener registered earlier, so it must yield
            // explicitly for overlapping keys like `s`.
            if (isFingerActive()) return;

            var bar = document.getElementById('pdf2html-search');
            var inSearchInput = e.target && e.target.id === 'pdf2html-search-input';

            // --- Bar open ------------------------------------------------
            // Esc closes the bar regardless of where focus has drifted to;
            // other keys only respond when the caret is actually in the
            // search input so we don't eat the reader's j/k/etc.
            if (bar) {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    closeSearch();
                    return;
                }
                if (!inSearchInput) return;
                if (e.key === 'Enter') {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    if (!searchState.hits.length) return;
                    searchState.entered = true;
                    searchState.activeIdx = indexOfClosestHitToViewport();
                    focusActiveHit();
                    dismissSearchBar();
                    return;
                }
                // Typing, arrows, backspace fall through to the input.
                return;
            }

            // --- Bar closed, no persistent hits: `/` or `s` opens search --
            if (!searchState.entered) {
                var opener = e.key === '/' || (e.key === 's' && !e.metaKey && !e.ctrlKey && !e.altKey);
                if (!opener) return;
                if (isInputTarget(e.target)) return;
                e.preventDefault();
                e.stopImmediatePropagation();
                openSearch();
                return;
            }

            // --- Bar closed, highlights persist (nvim hlsearch) ----------
            if (isInputTarget(e.target)) return;
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopImmediatePropagation();
                closeSearch();
                return;
            }
            if (e.key === 'n' || e.key === 'N') {
                e.preventDefault();
                e.stopImmediatePropagation();
                var n = searchState.hits.length;
                if (!n) return;
                var dir = e.key === 'n' ? 1 : -1;
                searchState.activeIdx = (searchState.activeIdx + dir + n) % n;
                focusActiveHit();
                return;
            }
            // `/` or `s` reopens for a fresh query — drops the existing state.
            if (e.key === '/' || (e.key === 's' && !e.metaKey && !e.ctrlKey && !e.altKey)) {
                e.preventDefault();
                e.stopImmediatePropagation();
                closeSearch();
                openSearch();
                return;
            }
            // Any other key: fall through. We keep nvim-style hlsearch —
            // highlights + n/N persist until explicit Esc. The
            // ::selection-hiding body class is dropped separately by the
            // selectionchange listener below, the moment the Selection
            // diverges from the active hit (Vimium V extending, mouse
            // drag, anything).
        }, true);

        // ::selection is transparent while body.pdf2html-search-entered is
        // set so the orange active-hit paint shows through. As soon as the
        // Selection is modified by anything that isn't our own n/N (Vimium
        // V extending via Selection.modify, click, mouse drag, …), flip
        // ::selection back to the default blue so the user can actually see
        // what's being selected. Range identity, not event source, is the
        // cleanest signal.
        document.addEventListener('selectionchange', function () {
            if (!document.body.classList.contains('pdf2html-search-entered')) return;
            var sel = window.getSelection();
            if (!sel || !sel.rangeCount) {
                document.body.classList.remove('pdf2html-search-entered');
                return;
            }
            var activeR = searchState.hits[searchState.activeIdx];
            if (!activeR) {
                document.body.classList.remove('pdf2html-search-entered');
                return;
            }
            var selR = sel.getRangeAt(0);
            try {
                if (selR.compareBoundaryPoints(Range.START_TO_START, activeR) !== 0
                 || selR.compareBoundaryPoints(Range.END_TO_END, activeR) !== 0) {
                    document.body.classList.remove('pdf2html-search-entered');
                }
            } catch (e) {
                // Detached / cross-document range — drop the class to be safe.
                document.body.classList.remove('pdf2html-search-entered');
            }
        });
    }

    function openSearch() {
        var ex = document.getElementById('pdf2html-search');
        // Re-pressing `/` while the bar is open toggles it closed, matching
        // how other overlay keys here behave.
        if (ex) { closeSearch(); return; }

        searchState = { hits: [], activeIdx: -1, entered: false };

        var input = el('input', {
            type: 'text',
            id: 'pdf2html-search-input',
            autocomplete: 'off',
            spellcheck: 'false',
            autocapitalize: 'off',
            placeholder: 'find in visible pages · Enter to jump · n/N next/prev',
        });
        var countEl = el('span', {
            class: 'pdf2html-search-count',
            id: 'pdf2html-search-count',
        });
        var wrap = el('div', { id: 'pdf2html-search' }, [
            el('div', { id: 'pdf2html-search-line' }, [
                el('span', { id: 'pdf2html-search-prompt' }, '/'),
                input,
                countEl,
                el('span', {
                    class: 'pdf2html-search-hint',
                    html:
                        '<span class="pdf2html-kbd sm">Enter</span> jump · ' +
                        '<span class="pdf2html-kbd sm">n</span>/' +
                        '<span class="pdf2html-kbd sm">N</span> nav · ' +
                        '<span class="pdf2html-kbd sm">Esc</span> close',
                }),
            ]),
        ]);
        document.body.appendChild(wrap);
        input.focus();
        // Under Vimium, Escape in the field only blurs it (see the palette's
        // closeWhenFocusLeaves). Before Enter that means "close"; after
        // Enter the bar is already gone and the hits stay.
        input.addEventListener('blur', function () {
            window.setTimeout(function () {
                if (!wrap.isConnected || !document.hasFocus()) return;
                if (document.activeElement === input || searchState.entered) return;
                closeSearch();
            }, 0);
        });

        // Live-update on typing. Enter / Esc / n / N are all handled by the
        // document capture-phase listener in mountSearch so they fire even
        // if something else (Vimium, extensions) has hooked this input.
        input.addEventListener('input', function () {
            searchState.entered = false;
            searchState.activeIdx = -1;
            updateSearchHits(input.value);
            updateSearchCount();
        });
    }

    function dismissSearchBar() {
        var ex = document.getElementById('pdf2html-search');
        removeOverlay(ex);
    }

    function closeSearch() {
        // Selection was already promoted on Enter by focusActiveHit, so Vimium
        // V / ⌘C already work. Esc just tears down the visual affordances and
        // leaves whatever Selection is current alone. Drop the body class so
        // the ::selection color reverts from orange back to the default blue.
        var ex = document.getElementById('pdf2html-search');
        removeOverlay(ex);
        clearSearchHighlights();
        document.body.classList.remove('pdf2html-search-entered');
        searchState = { hits: [], activeIdx: -1, entered: false };
    }

    function clearSearchHighlights() {
        try {
            if (window.CSS && CSS.highlights) {
                CSS.highlights.delete('pdf2html-search-hit');
                CSS.highlights.delete('pdf2html-search-active');
            }
        } catch (e) { /* Highlight API unsupported — nothing to clear */ }
    }

    function updateSearchHits(raw) {
        clearSearchHighlights();
        searchState.hits = [];

        var q = (raw || '').trim();
        if (!q) return;
        if (!window.CSS || !CSS.highlights || typeof Highlight === 'undefined') {
            // No Highlight API support → bar still works but nothing paints.
            // Acceptable degradation; Chromium has the API, so this shouldn't fire.
            return;
        }

        var cs = prefs.get('searchCaseSensitive');
        var needle = cs ? q : q.toLowerCase();
        // Scope rule: only pages currently intersecting the viewport. Under
        // content-visibility: auto, off-viewport pages still have their text
        // in the DOM (so native Cmd-F sees them), but `/` deliberately scopes
        // to what the reader is looking at.
        var pages = documentModel.visiblePages();
        var inactive = new Highlight();

        // Per-line flat-text search. A line's text can be spread across
        // several sibling text nodes. A naive per-text-node `indexOf` would miss any
        // query that crosses a span (multi-word, or even one word like
        // "shows" cut by a kerning gap). We flatten each `.t` into one string
        // with an offset map back to (textNode, localOffset), search the flat
        // string, and rebuild Ranges that may span several text nodes per hit.
        // Scope is still per `.t` (visual line) — Cmd-F's built-in find has
        // the same line-scoped contract, and crossing line breaks would match
        // nothing the user can see.
        pages.forEach(function (pf) {
            var pc = documentModel.pageContent(pf);
            if (!pc) return;
            var lines = pc.querySelectorAll('.t');
            for (var li = 0; li < lines.length; li++) {
                collectHitsInLine(lines[li], needle, cs, inactive);
            }
        });

        if (searchState.hits.length) {
            CSS.highlights.set('pdf2html-search-hit', inactive);
        }
    }

    // Flatten one `.t` into a single string + (node, start, end) map and
    // push a Range for each occurrence of `needle`. Splits the matched
    // [start, end) across the contributing text nodes — the resulting Range
    // is multi-node when a hit crosses a kerning/spacer span, single-node
    // when it doesn't.
    function collectHitsInLine(line, needle, cs, highlight) {
        var walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        var flat = '';
        var map = [];
        var node;
        while ((node = walker.nextNode())) {
            var t = node.nodeValue || '';
            if (!t.length) continue;
            map.push({ node: node, start: flat.length, end: flat.length + t.length });
            flat += t;
        }
        if (!flat) return;
        var hay = cs ? flat : flat.toLowerCase();
        var cursor = 0, idx;
        while ((idx = hay.indexOf(needle, cursor)) !== -1) {
            var r = rangeFromFlatOffsets(map, idx, idx + needle.length);
            if (r) {
                searchState.hits.push(r);
                highlight.add(r);
            }
            cursor = idx + needle.length;
        }
    }

    // Translate [flatStart, flatEnd) back into a DOM Range over the original
    // text nodes. Linear over `map`; fine for one line.
    function rangeFromFlatOffsets(map, flatStart, flatEnd) {
        var startEntry = null, endEntry = null;
        for (var i = 0; i < map.length; i++) {
            var m = map[i];
            if (!startEntry && flatStart >= m.start && flatStart < m.end) startEntry = m;
            if (flatEnd > m.start && flatEnd <= m.end) { endEntry = m; break; }
        }
        if (!startEntry || !endEntry) return null;
        var r = document.createRange();
        try {
            r.setStart(startEntry.node, flatStart - startEntry.start);
            r.setEnd(endEntry.node, flatEnd - endEntry.start);
            return r;
        } catch (e) {
            return null;
        }
    }

    // Enter's first pick: the match that needs the smallest scroll under the
    // scrolloff rule. If any matches are already inside the safe band their
    // delta is 0, so the first-in-DOM such match wins — "select what's already
    // on screen" rather than "teleport to the nearest one above center".
    function indexOfClosestHitToViewport() {
        var bestIdx = 0, bestDist = Infinity;
        for (var i = 0; i < searchState.hits.length; i++) {
            var d = Math.abs(scrollOff.deltaForRect(searchState.hits[i].getBoundingClientRect()));
            if (d < bestDist) { bestDist = d; bestIdx = i; }
        }
        return bestIdx;
    }

    function focusActiveHit() {
        var range = searchState.hits[searchState.activeIdx];
        if (!range) { updateSearchCount(); return; }

        // Rebuild the two highlight groups so the active range moves between
        // them. The CSS Highlight API has no per-range style — we partition.
        // active.priority > 0 keeps the orange paint on top of the browser's
        // built-in ::selection paint that we set below (custom-highlight
        // priority can outrank ::selection in Chromium).
        try {
            if (window.CSS && CSS.highlights) {
                var inactive = new Highlight();
                for (var i = 0; i < searchState.hits.length; i++) {
                    if (i !== searchState.activeIdx) inactive.add(searchState.hits[i]);
                }
                var active = new Highlight();
                active.add(range);
                active.priority = 10;
                CSS.highlights.set('pdf2html-search-hit', inactive);
                CSS.highlights.set('pdf2html-search-active', active);
            }
        } catch (e) { /* no highlight API → skip re-paint */ }

        var root = documentModel.container();
        var delta = scrollOff.deltaForRect(range.getBoundingClientRect());
        if (root && Math.abs(delta) >= 1) root.scrollBy({ top: delta, behavior: 'smooth' });

        // Promote the active range to a real browser Selection so Vimium's V
        // and ⌘C work immediately after Enter — no Esc-to-promote detour.
        // Suppress caret follow briefly so its scroll doesn't fight our own
        // smooth-scroll above. The body class makes ::selection transparent
        // so the native selection paint doesn't cover our orange active
        // highlight (Chromium paints built-in pseudos on top of custom
        // highlights regardless of Highlight.priority).
        scrollOff.suppressFollow(500);
        try {
            var sel = window.getSelection();
            if (sel) {
                sel.removeAllRanges();
                sel.addRange(range);
            }
            document.body.classList.add('pdf2html-search-entered');
        } catch (e) { /* detached / cross-origin range — ignore */ }

        updateSearchCount();
    }

    function updateSearchCount() {
        var cEl = document.getElementById('pdf2html-search-count');
        if (!cEl) return;
        var n = searchState.hits.length;
        if (!n) { cEl.textContent = ''; return; }
        // "· / N" while still typing; "K / N" once Enter has activated a hit.
        var cur = searchState.activeIdx >= 0
            ? String(searchState.activeIdx + 1)
            : '·';
        cEl.textContent = cur + ' / ' + n;
    }

    function refresh(raw) {
        updateSearchHits(raw);
        updateSearchCount();
    }

    // Open the bar holding `text`, with its hits on the visible pages marked;
    // returns how many there are. Quick open's "Find" row starts here.
    function find(text) {
        if (!document.getElementById('pdf2html-search')) openSearch();
        var input = document.getElementById('pdf2html-search-input');
        if (!input) return 0;
        input.value = text;
        searchState.entered = false;
        searchState.activeIdx = -1;
        refresh(text);
        return searchState.hits.length;
    }

    return { mount: mount, close: closeSearch, refresh: refresh, find: find };
}

// ============================================================================
// pdf_viewer overlay — runtime layer on top of pdf2htmlEX's output.
//
// Served as /_assets/overlay.js, loaded via <script type="module"> injected
// into each converted HTML. Module scripts defer by default, so everything
// runs after HTML parse, before DOMContentLoaded handlers registered later.
//
// This is the composition root: it builds the concept modules in
// assets/overlay-*.js, hands each one its capabilities explicitly, mounts
// them in order, and owns the few key bindings that span modules (Escape
// priority, the Tab guard, count-prefixed page and chapter motions).
// ============================================================================

import { el, isInputTarget } from './overlay-dom.js';
import { createPreferences } from './overlay-prefs.js';
import { createDocumentState } from './overlay-state.js';
import { createDocumentModel } from './overlay-document.js';
import { createZoom } from './overlay-zoom.js';
import { createPdf2htmlEx, preparePdf2htmlEx } from './overlay-pdf2htmlex.js';
import { createNavigation } from './overlay-navigation.js';
import { createScrollOff } from './overlay-scrolloff.js';
import { createTextInteraction } from './overlay-text.js';
import { createTextFit } from './overlay-textfit.js';
import { createLinks } from './overlay-links.js';
import { createSearch } from './overlay-search.js';
import { createFinger } from './overlay-finger.js';
import { createLibrary } from './overlay-library.js';
import { createSettings } from './overlay-settings.js';
import { createFocusRouting } from './overlay-focus.js';
import { createSidebar } from './overlay-sidebar.js';
import { createPageCounter } from './overlay-pageno.js';
import { createCommandSurface } from './overlay-commands.js';

preparePdf2htmlEx({ document: document, window: window });

(function () {
    'use strict';

    document.addEventListener('DOMContentLoaded', init);

    // Resolve the cache-entry hash. Prefer the inject-time <meta> tag —
    // location.pathname lies when the page is served via /view?path=…
    // (the daemon serves the file on /view rather than redirecting to
    // /<hash>/<stem>.html). Fall back to pathname for older entries that
    // predate the meta injection.
    function entryHash() {
        var meta = document.querySelector('meta[name="pdf2html-hash"]');
        if (meta && meta.content) return meta.content;
        var m = location.pathname.match(/^\/([a-f0-9]{6,32})\//);
        return m ? m[1] : null;
    }

    function init() {
        var base = { document: document, window: window, requestAnimationFrame: requestAnimationFrame };
        function withBase(extra) { return Object.assign({}, base, extra); }

        var prefs = createPreferences(localStorage);
        var documentState = createDocumentState({ fetch: fetch.bind(window), storage: localStorage,
            entryHash: entryHash, window: window });
        var documentModel = createDocumentModel(base);
        var zoom = createZoom(withBase({ storage: localStorage, documentState: documentState, entryHash: entryHash,
            documentModel: documentModel }));
        var pdf2htmlex = createPdf2htmlEx(withBase({ documentModel: documentModel, zoom: zoom }));
        var navigation = createNavigation(withBase({
            location: location, history: history, documentState: documentState, entryHash: entryHash,
            documentModel: documentModel, followDestination: pdf2htmlex.followDestination,
        }));
        var scrollOff = createScrollOff(withBase({ performance: performance, prefs: prefs, documentModel: documentModel }));
        var text = createTextInteraction(withBase({
            navigator: navigator, navigation: navigation, documentModel: documentModel, scrollOff: scrollOff,
        }));
        // Finger and search each yield to the other; the late binding keeps
        // construction order simple.
        var finger = null;
        var search = createSearch(withBase({
            Range: Range, NodeFilter: NodeFilter, Highlight: window.Highlight, CSS: window.CSS,
            el: el, isInputTarget: isInputTarget, prefs: prefs, documentModel: documentModel, scrollOff: scrollOff,
            isFingerActive: function () { return !!finger && finger.isActive(); },
        }));
        finger = createFinger({
            closeSearch: search.close,
            visiblePages: documentModel.visiblePages,
            writeClip: text.writeClip,
        });
        var library = createLibrary({ document: document, location: location, history: history,
            fetch: fetch.bind(window), entryHash: entryHash });
        var settings = createSettings({ document: document, prefs: prefs, zoom: zoom });
        var focus = createFocusRouting(base);
        var commands = null;
        var sidebar = createSidebar(withBase({
            fetch: fetch.bind(window), prefs: prefs, focus: focus, navigation: navigation,
            documentModel: documentModel, entryHash: entryHash, openSettings: settings.toggle,
            toggleCheatsheet: function () { commands.toggleCheatsheet(); },
        }));
        var pageCounter = createPageCounter({ document: document, prefs: prefs, navigation: navigation,
            documentModel: documentModel, isInputTarget: isInputTarget });
        commands = createCommandSurface({ document: document, window: window, location: location,
            prefs: prefs, zoom: zoom, navigation: navigation, text: text, library: library,
            finger: finger, settings: settings, isInputTarget: isInputTarget });

        // Order matters where one mount measures what another builds: the
        // document adaptation runs before first paint, zoom before anything
        // measures pages, and the sidebar before focus routing hooks into it.
        pdf2htmlex.adaptDocument();
        zoom.mount();
        pdf2htmlex.adaptRuntime();
        createTextFit(withBase({ documentModel: documentModel })).mount();
        createLinks(withBase({ documentModel: documentModel, navigation: navigation })).mount();
        documentModel.mountRasterLifecycle();
        scrollOff.mount();
        search.mount();
        sidebar.mount();
        pageCounter.mount();
        navigation.init();
        focus.mount();
        commands.init();
        registerEscapeHandler(commands, finger, settings, sidebar, prefs);
        registerDocumentTabGuard();
        registerCountedMotions(navigation, text);
        registerArrowKeys(navigation, text, documentModel, sidebar, focus, finger);
        library.load();
    }

    // ------------------------------------------------------------------------
    // Escape: priority chain — finder/palette → finger → settings → help →
    // sidebar → clear selection. Capture phase, since Vimium also listens for
    // Escape. `/` search handles its own Escape on window capture first.
    // ------------------------------------------------------------------------
    function registerEscapeHandler(commands, finger, settings, sidebar, prefs) {
        document.addEventListener('keydown', function (e) {
            if (e.key !== 'Escape') return;
            if (commands.closeFinderOrPalette()) { e.preventDefault(); e.stopPropagation(); return; }
            if (finger.isActive()) { e.preventDefault(); e.stopPropagation(); finger.closeFingerMode(); return; }
            if (isInputTarget(e.target)) return;
            if (settings.close()) return;
            if (commands.closeHelp()) return;
            if (sidebar.isShown()) { sidebar.close(); return; }
            if (!prefs.get('escClearsSelection')) return;
            var sel = window.getSelection();
            if (sel && !sel.isCollapsed) sel.removeAllRanges();
        }, true);
    }

    // Bare Tab in pdf2htmlEX content walks the browser's focus order through
    // page links/anchors and can scroll to a different page. Keep Tab local to
    // overlay chrome and inputs; on the PDF surface, it is intentionally inert.
    function registerDocumentTabGuard() {
        document.addEventListener('keydown', function (e) {
            if (e.key !== 'Tab') return;
            if (e.metaKey || e.ctrlKey || e.altKey) return;
            if (isInputTarget(e.target)) return;
            var t = e.target instanceof Element ? e.target : document.activeElement;
            if (t && t.closest && t.closest(
                '#pdf2html-palette, #pdf2html-finder, #pdf2html-settings, '
                + '#pdf2html-cheatsheet, #sidebar, #pdf2html-toggle'
            )) return;
            if (t === document.body
                || t === document.documentElement
                || (t && t.closest && t.closest('#page-container'))) {
                e.preventDefault();
                e.stopPropagation();
            }
        }, true);
    }

    // ------------------------------------------------------------------------
    // Arrow keys on the document, as in any PDF viewer: ←/→ turn pages (the
    // same motion as q/e, so an active selection extends pagewise), ↑/↓
    // scroll. The scroller rarely has focus, so the browser's own arrow
    // scrolling cannot be relied on. Left alone: arrows with a modifier
    // (Shift extends a selection, ⌘ jumps to the ends), text fields, any open
    // overlay, and the sidebar, which uses ←/→ for its tabs and ↑/↓ for its
    // selector.
    // ------------------------------------------------------------------------
    var ARROW_SCROLL_STEP = 60;
    function registerArrowKeys(navigation, text, documentModel, sidebar, focus, finger) {
        document.addEventListener('keydown', function (e) {
            var k = e.key;
            if (k !== 'ArrowLeft' && k !== 'ArrowRight' && k !== 'ArrowUp' && k !== 'ArrowDown') return;
            if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
            if (isInputTarget(e.target) || finger.isActive()) return;
            if (document.querySelector('#pdf2html-palette, #pdf2html-finder, #pdf2html-settings, '
                + '#pdf2html-cheatsheet, #pdf2html-search')) return;
            var horizontal = k === 'ArrowLeft' || k === 'ArrowRight';
            if (horizontal ? sidebar.isShown() : (sidebar.isShown() && focus.isSidebarScope())) return;
            var root = documentModel.container();
            if (!root) return;
            e.preventDefault(); e.stopPropagation();
            if (horizontal) {
                var delta = k === 'ArrowRight' ? 1 : -1;
                if (!text.extendSelectionByPage(delta)) navigation.stepPage(delta);
            } else {
                root.scrollBy({ top: k === 'ArrowDown' ? ARROW_SCROLL_STEP : -ARROW_SCROLL_STEP, behavior: 'instant' });
            }
        }, true);
    }

    // ------------------------------------------------------------------------
    // Count-prefixed motions — the overlay's only count-prefix binding.
    //   e / q / E : +1 / -1 / -1 page (10e = +10 pages, 10q = -10 pages)
    //   c / C     : ±1 chapter (3c = +3 chapters, 3C = -3 chapters)
    // Bare keys = ±1. Digits buffer until a motion fires, 1.5 s elapses, or
    // any other key cancels. Requires Vimium passthrough for `e q E c C 0-9`
    // on localhost:7435, else Vimium swallows the digits or letters. With an
    // active browser selection, e/q/E extend its focus end pagewise instead
    // of moving the viewport, and bare `c` selects the whole chapter.
    // ------------------------------------------------------------------------
    function registerCountedMotions(navigation, text) {
        var buf = '';
        var timer = null;
        function clearBuf() {
            buf = '';
            if (timer) { clearTimeout(timer); timer = null; }
        }
        document.addEventListener('keydown', function (e) {
            if (isInputTarget(e.target)) { clearBuf(); return; }
            if (e.metaKey || e.ctrlKey || e.altKey) { clearBuf(); return; }
            if (e.key >= '0' && e.key <= '9') {
                buf = (buf + e.key).slice(-6);
                e.preventDefault(); e.stopPropagation();
                if (timer) clearTimeout(timer);
                timer = setTimeout(clearBuf, 1500);
                return;
            }
            var k = e.key;
            if (k !== 'e' && k !== 'q' && k !== 'E' && k !== 'c' && k !== 'C') {
                clearBuf();
                return;
            }
            var count = parseInt(buf, 10) || 1;
            clearBuf();
            e.preventDefault(); e.stopPropagation();
            if (k === 'e' || k === 'q' || k === 'E') {
                var delta = k === 'e' ? count : -count;
                if (!text.extendSelectionByPage(delta)) navigation.stepPage(delta);
            } else {
                if (k === 'c' && text.selectCurrentChapterFromSelection()) return;
                navigation.gotoChapterBy(k === 'c' ? count : -count);
            }
        }, true);
    }
})();

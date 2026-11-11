// Scrolloff and cursor pin (ADR 0006).
//
// CSS scroll-padding on #page-container is the single source of truth for
// the band. --pdf2html-scrolloff (a percentage) reserves a band at the top
// and bottom of the viewport; every native scroll-into-view path (caret on
// keyboard input, shift+arrow selection extend, click to place caret, hash
// navigation) honors it without JS.
//
//   pinned=false → padding = scrollOff × 100%  (0% = off, 25% = keep the
//                  caret in the middle half, etc.)
//   pinned=true  → padding = 50% both sides. The "safe" region collapses to
//                  the centre line, so any caret movement recenters (Vim
//                  `scrolloff=999`).
//
// Vimium's caret/visual mode moves the selection via Selection.modify(),
// which Chrome does NOT auto-scroll for, so a selectionchange handler applies
// the same band in JS (caret follow). Search uses deltaForRect() so its
// "take me there" scroll obeys the same rule.
export function createScrollOff(core) {
    var document = core.document;
    var window = core.window;
    var performance = core.performance;
    var requestAnimationFrame = core.requestAnimationFrame;
    var prefs = core.prefs;
    var documentModel = core.documentModel;

    // Smooth scroll animates ~300ms. A second scroll inside that window
    // cancels the in-flight animation and restarts — so held `j` in Vimium,
    // which fires selection updates every ~30ms, never lets the animation
    // finish and the caret outruns the viewport (worst at page boundaries,
    // where the delta includes the inter-page margin). Fall back to instant
    // for rapid-fire; keep smooth for isolated moves.
    var RAPID_WINDOW_MS = 180;
    var suppressedUntil = 0;

    function bandFraction() { return prefs.get('pinned') ? 0.5 : prefs.get('scrollOff'); }

    function applyStyle() {
        var root = documentModel.container();
        if (root) root.style.setProperty('--pdf2html-scrolloff', (bandFraction() * 100) + '%');
    }

    // Scroll delta that brings a client rect's top into the band: to the
    // centre line when pinned, else the minimum move to the nearest band
    // edge. 0 when it is already inside.
    function deltaForRect(rect) {
        var root = documentModel.container();
        if (!root) return 0;
        var h = root.clientHeight;
        var y = rect.top - root.getBoundingClientRect().top;
        if (prefs.get('pinned')) return y - h * 0.5;
        var margin = h * prefs.get('scrollOff');
        if (y < margin) return y - margin;
        if (y > h - margin) return y - (h - margin);
        return 0;
    }

    // A caller that is about to scroll for its own selection change (search
    // Enter, chapter selection) suppresses caret follow so the two scrolls
    // don't fight.
    function suppressFollow(ms) { suppressedUntil = performance.now() + ms; }

    // Suppressed during a mouse drag so Chrome's native drag-past-edge
    // auto-scroll is left alone. The body class also drops scroll-padding
    // while dragging (see overlay.css).
    //
    // Only caret *moves* are followed: the selection's focus must have been
    // inside a page before the change and still be inside one. A selection
    // that arrives from an overlay input or from nothing is a teleport —
    // Chromium relocates the selection to the end of the document when a
    // focused palette input is removed, for example — and following it
    // would throw the reader to an arbitrary place.
    function mountCaretFollow() {
        var raf = null;
        var dragging = false;
        var lastScrollTs = 0;
        var focusWasInPage = false;
        var previousFocus = null;
        function focusInPage(sel) {
            return !!(sel && sel.rangeCount && sel.focusNode && documentModel.pageFromNode(sel.focusNode));
        }

        function beginPointerSelection() {
            dragging = true;
            document.body.classList.add('pdf2html-pointer-selecting');
        }
        function endPointerSelection() {
            dragging = false;
            document.body.classList.remove('pdf2html-pointer-selecting');
        }
        document.addEventListener('mousedown', beginPointerSelection);
        document.addEventListener('mouseup', endPointerSelection);
        window.addEventListener('blur', endPointerSelection);

        document.addEventListener('selectionchange', function () {
            var selection = document.getSelection();
            var inPage = focusInPage(selection);
            // Native find can re-announce its old selection after scrolling
            // or Enter. Follow a changed focus endpoint, never the mere event.
            // Vimium Selection.modify and deliberate overlay moves change it.
            var changed = !previousFocus || !selection ||
                previousFocus.node !== selection.focusNode || previousFocus.offset !== selection.focusOffset;
            previousFocus = selection ? {node: selection.focusNode, offset: selection.focusOffset} : null;
            var moved = changed && inPage && focusWasInPage;
            focusWasInPage = inPage;
            if (!moved || dragging || raf) return;
            if (performance.now() < suppressedUntil) return;
            raf = requestAnimationFrame(function () {
                raf = null;
                var sel = document.getSelection();
                var root = documentModel.container();
                if (!root || !focusInPage(sel)) return;
                // The focus end's *visual* rect reflects the
                // transformed text; Element.scrollIntoView uses layout rects
                // and lands in the wrong place here.
                var r = document.createRange();
                try { r.setStart(sel.focusNode, sel.focusOffset); r.collapse(true); }
                catch (e) { return; }
                var rect = r.getBoundingClientRect();
                // Collapsed ranges sometimes return (0,0,0,0) at DOM edges —
                // no reliable caret position, bail.
                if (rect.top === 0 && rect.bottom === 0 && rect.left === 0) return;
                var delta = deltaForRect(rect);
                if (Math.abs(delta) < 1) return;
                var now = performance.now();
                root.scrollBy({ top: delta, behavior: now - lastScrollTs < RAPID_WINDOW_MS ? 'instant' : 'smooth' });
                lastScrollTs = now;
            });
        });
    }

    function mount() {
        applyStyle();
        prefs.onChange('pinned', applyStyle);
        prefs.onChange('scrollOff', applyStyle);
        mountCaretFollow();
    }

    return { mount: mount, deltaForRect: deltaForRect, suppressFollow: suppressFollow };
}

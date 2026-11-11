// Focus routing — scope Vimium's j/k to whichever surface is open (ADR 0005).
//
// Vimium tracks a separate `activatedElement` (its own notion of "what j/k
// scrolls"), NOT document.activeElement. It updates activatedElement only on
// DOMActivate (Chromium) or click (Firefox) — see Vimium's scroller.js
// Scroller.init. So calling .focus() on a scroller has zero effect on
// Vimium's scrolling behavior.
//
// To scope j/k to a container we dispatch a DOMActivate (+ click, for
// Firefox parity) on it. activate() does all three: focus for native
// keyboard nav (Tab/arrow-scroll), DOMActivate + click for Vimium.
//
// Declarative routing via MutationObserver avoids wrapping every open/close
// call site (the sidebar toggles from several places; modals close via Esc,
// backdrop click and toggle keys). The observer reacts to the canonical
// state change — body.sidebar-shown toggling, modal nodes added/removed — so
// new call sites automatically participate.
//
// Modals stash the previously-activated element on open and restore it on
// close, so closing settings-opened-over-sidebar hands j/k back to the
// sidebar. Closing the sidebar re-activates the PDF scroller.
//
// Safety re: synthetic click — backdrop "click outside to close" checks
// e.target === backdrop, and the scroll containers are either descendants of
// their backdrop (modals) or on a sibling tree (sidebar), so bubbling won't
// trigger a close.
var MODALS = {
    'pdf2html-settings': '.pdf2html-settings-body',
    'pdf2html-cheatsheet': '.pdf2html-cheatsheet-body',
};

export function createFocusRouting(core) {
    var document = core.document;
    var window = core.window;
    var body = document.body;
    var stashed = {};

    function setScrollFocus(kind) { body.setAttribute('data-scroll-focus', kind); }
    function isSidebarShown() { return body.classList.contains('sidebar-shown'); }
    function dispatchActivation(el) {
        try { el.dispatchEvent(new Event('DOMActivate', { bubbles: true, cancelable: true })); } catch (e) {}
        try { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); } catch (e) {}
    }
    function activate(el, kind) {
        if (!el) return;
        if (kind) setScrollFocus(kind);
        try { el.focus({ preventScroll: true }); } catch (e) { try { el.focus(); } catch (e2) {} }
        dispatchActivation(el);
    }
    // Handing j/k back to the PDF. The synthetic click can make the
    // text layer materialize a tiny selection range; clear it immediately.
    function activateMain() {
        setScrollFocus('main');
        dispatchActivation(document.getElementById('page-container') || document.body);
        try {
            var sel = window.getSelection();
            if (sel && sel.rangeCount > 0) sel.removeAllRanges();
        } catch (e) {}
    }
    function activateSidebar() {
        activate(document.getElementById('pdf2html-sidebar-body'), 'sidebar');
    }
    // A sidebar tab switch changes what the sidebar body scrolls.
    function refreshSidebar() {
        if (isSidebarShown()) activateSidebar();
    }
    function isSidebarScope() {
        return document.activeElement === document.getElementById('pdf2html-sidebar-body')
            || body.getAttribute('data-scroll-focus') === 'sidebar';
    }
    function restore(id) {
        var target = stashed[id];
        stashed[id] = null;
        if (target && document.contains(target)) {
            var role = target.id === 'pdf2html-sidebar-body' ? 'sidebar'
                : (target.id === 'page-container' ? 'main' : null);
            activate(target, role);
        } else {
            activateMain();
        }
    }

    function mount() {
        var pc = document.getElementById('page-container');
        if (pc) pc.addEventListener('mousedown', function () { if (isSidebarShown()) activateMain(); });
        var sidebarBody = document.getElementById('pdf2html-sidebar-body');
        if (sidebarBody) sidebarBody.addEventListener('mousedown', function () { if (isSidebarShown()) activateSidebar(); });

        var wasShown = isSidebarShown();
        new MutationObserver(function () {
            var shown = isSidebarShown();
            if (shown === wasShown) return;
            wasShown = shown;
            if (shown) activateSidebar(); else activateMain();
        }).observe(body, { attributes: true, attributeFilter: ['class'] });

        new MutationObserver(function (mutations) {
            mutations.forEach(function (m) {
                for (var i = 0; i < m.addedNodes.length; i++) {
                    var n = m.addedNodes[i];
                    if (!(n instanceof HTMLElement) || !MODALS[n.id]) continue;
                    var ae = document.activeElement;
                    stashed[n.id] = ae && ae !== document.body ? ae : null;
                    activate(n.querySelector(MODALS[n.id]));
                }
                for (var j = 0; j < m.removedNodes.length; j++) {
                    var r = m.removedNodes[j];
                    if (r instanceof HTMLElement && MODALS[r.id]) restore(r.id);
                }
            });
        }).observe(body, { childList: true });

        setScrollFocus(isSidebarShown() ? 'sidebar' : 'main');
    }

    return { mount: mount, refreshSidebar: refreshSidebar, isSidebarScope: isSidebarScope };
}

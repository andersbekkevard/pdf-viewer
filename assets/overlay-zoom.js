// Page zoom: auto-fit, per-document preference, and where the zoom lives.
//
// pdf2htmlEX emits pages at the PDF's native CSS-pixel size (1 PDF pt ≈ 1 px),
// which varies wildly: A4 ≈ 595px, US Letter 612px, 16:9 slide deck 1920px,
// posters even more. A fixed multiplier is wrong across that range, so the
// default is auto-fit: the first page occupies ~85% of #page-container's
// width. Stored values are either the sentinel 'auto' (default) or a raw
// numeric multiplier set via `:zoom N` / the settings slider.
//
// The zoom is the CSS variable --pdf2html-zoom on #page-container, applied by
// overlay.css as `zoom` on each `.pf`. It must never be `zoom` on the scroller
// itself: a zoomed scroller measures scrollTop/scrollBy/clientHeight in its
// own unzoomed units, which multiplies every Vimium j/d step by the zoom.
//
// Persistence is per-document, through the document state (overlay-state.js,
// localStorage `pdf2html-zoom:<hash>` plus the daemon copy):
//   zoom (per document)   — this doc's setting (preferred)
//   pdf2html-zoom         — global fallback / no-hash docs (localStorage only)
// A daemon copy that arrives after load and differs is applied.
export function createZoom(core) {
    var document = core.document;
    var window = core.window;
    var storage = core.storage;
    var documentState = core.documentState;
    var entryHash = core.entryHash;
    var documentModel = core.documentModel;
    var requestAnimationFrame = core.requestAnimationFrame;

    var GLOBAL_KEY = 'pdf2html-zoom';
    // Auto opens a document as Chrome's own viewer does: fit to width, but
    // never above the PDF's 100 % (96 CSS px per inch = 4/3 px per point).
    // daemon/main.py (_first_raster) repeats this arithmetic.
    var MIN_AUTO = 0.5, MAX_AUTO = 4 / 3;
    var MIN_MANUAL = 0.25, MAX_MANUAL = 10;
    var mode = 'auto';
    var zoom = 1.0;
    var pageWidth = 0;

    function readPref() {
        var v = entryHash() ? documentState.get('zoom') : null;
        if (v !== null && v !== undefined) return String(v);
        try { return storage.getItem(GLOBAL_KEY); } catch (e) { return null; }
    }
    function writePref(value) {
        if (entryHash()) { documentState.set('zoom', value); return; }
        try { storage.setItem(GLOBAL_KEY, value); } catch (e) {}
    }

    function autoFit() {
        var root = documentModel.container();
        var vw = root ? root.clientWidth : 0;
        if (!pageWidth || !vw) return 1.0;
        return Math.min(MAX_AUTO, Math.max(MIN_AUTO, 0.85 * vw / pageWidth));
    }

    // Rescaling pages moves every scroll offset, so carry the reading
    // position across the change explicitly.
    function apply(value) {
        var root = documentModel.container();
        if (!root) return;
        var anchor = documentModel.viewAnchor();
        zoom = value;
        root.style.setProperty('--pdf2html-zoom', String(value));
        documentModel.restoreViewAnchor(anchor);
        document.dispatchEvent(new CustomEvent('pdf2html-viewport-change'));
    }

    function set(value) {
        if (value === 'auto') {
            mode = 'auto';
            writePref('auto');
            apply(autoFit());
            return;
        }
        var num = typeof value === 'number' ? value : parseFloat(value);
        if (!isFinite(num) || num < MIN_MANUAL || num > MAX_MANUAL) return;
        mode = 'manual';
        writePref(String(num));
        apply(num);
    }

    // Relative step (Ctrl/Cmd +/-), clamped to the manual range.
    function scaleBy(factor) {
        if (!isFinite(factor) || factor <= 0) return;
        set(Math.min(MAX_MANUAL, Math.max(MIN_MANUAL, Math.round(zoom * factor * 1000) / 1000)));
    }

    // Apply a stored preference without writing it back.
    function applyPref(raw) {
        var initial = raw === null || raw === 'auto' ? NaN : parseFloat(raw);
        if (isFinite(initial) && initial >= MIN_MANUAL && initial <= MAX_MANUAL) mode = 'manual';
        else { mode = 'auto'; initial = autoFit(); }
        apply(initial);
    }

    function current() { return zoom; }
    function isAuto() { return mode === 'auto'; }

    function mount() {
        // Read the native page width before the first zoom is applied.
        var first = documentModel.page(1);
        pageWidth = first ? first.getBoundingClientRect().width : 0;

        applyPref(readPref());
        // Another origin or browser saved a different zoom for this document.
        documentState.onChange('zoom', function () { applyPref(readPref()); });

        // Re-fit on viewport resize in auto mode, rAF-throttled so a drag
        // resize doesn't trigger a storm of zoom writes.
        var pending = false;
        window.addEventListener('resize', function () {
            if (mode !== 'auto' || pending) return;
            pending = true;
            requestAnimationFrame(function () {
                pending = false;
                if (mode === 'auto') apply(autoFit());
            });
        });
    }

    return { mount: mount, set: set, scaleBy: scaleBy, current: current, isAuto: isAuto };
}

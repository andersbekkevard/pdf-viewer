// Text fit for reader shells (daemon/reader.py).
//
// A reader page paints its text in the raster; the `.t` lines above it are
// transparent and exist for selection, find, copy and Vimium. The browser
// lays them out in a fallback font, whose glyphs are not as wide as the
// document's. Each segment carries the width it occupies on the page
// (`data-w`, page px), and this module sets a letter-spacing that makes the
// fallback text exactly that wide, so a highlight covers the inked glyphs.
//
// Letter-spacing rather than a transform: segments are inline, so a line
// stays one find run. Widths come from a canvas, so fitting never forces
// layout, and offscreen pages are fitted while the browser is idle.
export function createTextFit(core) {
    var document = core.document;
    var window = core.window;
    var documentModel = core.documentModel;

    var context = null;
    var fitted = new WeakSet();

    function fitPage(pf) {
        if (fitted.has(pf)) return;
        fitted.add(pf);
        var nodes = pf.querySelectorAll('[data-w]');
        var font = null;
        for (var i = 0; i < nodes.length; i++) {
            var node = nodes[i];
            var text = node.textContent;
            var count = Array.from(text).length;
            var width = parseFloat(node.getAttribute('data-w'));
            if (!count || !(width > 0)) continue;
            var line = node.classList.contains('t') ? node : node.closest('.t');
            var size = line ? parseFloat(line.style.fontSize) : 0;
            if (!(size > 0)) continue;
            // The line's fallback family and style, as its classes set them
            // in the page (fs serif, fm monospace, fb bold, fi italic).
            var cls = line.classList;
            var wanted = (cls.contains('fi') ? 'italic ' : '') + (cls.contains('fb') ? 'bold ' : '') + size + 'px '
                + (cls.contains('fm') ? 'monospace' : cls.contains('fs') ? 'serif' : 'sans-serif');
            if (wanted !== font) { font = wanted; context.font = font; }
            // Measured with 1px of spacing, as laid out: non-zero spacing
            // turns ligatures off in both the canvas and the page.
            var natural = context.measureText(text).width - count;
            node.style.letterSpacing = ((width - natural) / count).toFixed(3) + 'px';
        }
    }

    function mount() {
        if (!documentModel.isReader()) return;
        context = document.createElement('canvas').getContext('2d');
        if (!context) return;
        context.fontKerning = 'none';
        context.letterSpacing = '1px';

        documentModel.visiblePages().forEach(fitPage);
        var pages = documentModel.pages();
        var next = 0;
        var idle = window.requestIdleCallback || function (fn) {
            return window.setTimeout(function () { fn({ timeRemaining: function () { return 8; } }); }, 16);
        };
        function work(deadline) {
            while (next < pages.length && deadline.timeRemaining() > 2) fitPage(pages[next++]);
            if (next < pages.length) idle(work);
        }
        idle(work);
        // A jump can land on a page the idle pass has not reached.
        document.addEventListener('pdf2html-page-change', function () {
            documentModel.visiblePages().forEach(fitPage);
        });
    }

    // Lines added to a page after load (overlay-ocr.js): fit the page again.
    // Segments already fitted get the same spacing.
    function refit(pf) {
        if (!context) return;
        fitted.delete(pf);
        fitPage(pf);
    }

    return { mount: mount, refit: refit };
}

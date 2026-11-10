// PDF link annotations in reader shells (daemon/reader.py).
//
// Each link is an empty `a.l` positioned over the raster, above the
// transparent `.t` text. It stays on top and hit-testable at rest, because
// Vimium only hints an element that `elementFromPoint` reaches; external
// links are ordinary anchors, internal ones carry
// `data-reader-dest='[page,"XYZ",x,y,null]'` and land like outline jumps.
//
// Text selection still works across links:
//   - a press that starts on text adds `pdf2html-link-pass` to the page
//     container until release, so the links let the drag's hit tests reach
//     the text under them (reader BASE_CSS sets pointer-events:none);
//   - a press that starts on a link suppresses the native link drag and
//     selection; if it moves, it becomes a text selection from the press
//     point, and if it does not, it is the link's click.
export function createLinks(core) {
    var document = core.document;
    var window = core.window;
    var documentModel = core.documentModel;
    var navigation = core.navigation;

    var PASS = 'pdf2html-link-pass';
    // Pointer travel (px) that turns a press on a link into a selection.
    var DRAG_THRESHOLD = 4;

    var root = null;
    var press = null;

    function closestLink(node, selector) {
        var el = node && node.nodeType === 1 ? node : node && node.parentElement;
        var link = el && el.closest ? el.closest(selector) : null;
        return link && root.contains(link) ? link : null;
    }
    function destination(link) {
        try {
            var dest = JSON.parse(link.getAttribute('data-reader-dest'));
            var page = parseInt(dest[0], 10);
            if (!(page > 0)) return null;
            var point = typeof dest[3] === 'number' ? { x: dest[2] || 0, y: dest[3] } : null;
            return { page: page, point: point };
        } catch (_) { return null; }
    }

    // Click, Enter on a focused link and Vimium's synthetic click all arrive here.
    function onClick(e) {
        var link = closestLink(e.target, 'a.l[data-reader-dest]');
        if (!link) return;
        var dest = destination(link);
        if (!dest || !documentModel.page(dest.page)) return;
        e.preventDefault();
        navigation.gotoDestination(dest.page, dest.point);
    }

    // A caret inside a text line at a viewport point, or null.
    function caretAt(x, y) {
        var node = null, offset = 0;
        if (document.caretRangeFromPoint) {
            var range = document.caretRangeFromPoint(x, y);
            if (range) { node = range.startContainer; offset = range.startOffset; }
        } else if (document.caretPositionFromPoint) {
            var pos = document.caretPositionFromPoint(x, y);
            if (pos) { node = pos.offsetNode; offset = pos.offset; }
        }
        return closestLink(node, '.t') ? { node: node, offset: offset } : null;
    }

    function onMouseDown(e) {
        if (e.button !== 0) return;
        if (!closestLink(e.target, 'a.l')) {
            if (closestLink(e.target, '.pc')) root.classList.add(PASS);
            return;
        }
        e.preventDefault();
        press = { x: e.clientX, y: e.clientY, anchor: null };
    }
    function onMouseMove(e) {
        if (!press) return;
        if (!(e.buttons & 1)) { end(); return; }
        if (!press.anchor) {
            if (Math.abs(e.clientX - press.x) + Math.abs(e.clientY - press.y) < DRAG_THRESHOLD) return;
            root.classList.add(PASS);
            press.anchor = caretAt(press.x, press.y);
            if (!press.anchor) { press = null; return; }
        }
        var focus = caretAt(e.clientX, e.clientY);
        var selection = window.getSelection();
        if (!focus || !selection) return;
        selection.setBaseAndExtent(press.anchor.node, press.anchor.offset, focus.node, focus.offset);
    }
    // The class is dropped after the release's hit test, so a drag that
    // ends over a link never becomes that link's click.
    function end() {
        press = null;
        root.classList.remove(PASS);
    }

    function mount() {
        if (!documentModel.isReader()) return;
        root = documentModel.container();
        if (!root) return;
        root.addEventListener('click', onClick, true);
        root.addEventListener('mousedown', onMouseDown, true);
        root.addEventListener('dragstart', function (e) {
            if (closestLink(e.target, 'a.l')) e.preventDefault();
        }, true);
        window.addEventListener('mousemove', onMouseMove, true);
        window.addEventListener('mouseup', end, true);
        window.addEventListener('blur', end);
    }

    return { mount: mount };
}

// Persistent return points. Geometry is always the document model's normalized
// viewport anchor; no page offsets or independent scroll arithmetic.
import { el, isInputTarget } from './overlay-dom.js';
export function createPins(core) {
    var doc = core.document, model = core.documentModel, state = core.documentState;
    var listeners = [], markers = [];
    function list() {
        var value = state.get('pins');
        return (Array.isArray(value) ? value : []).filter(function (p) { return p && p.number >= 1 && p.number <= 9; })
            .map(function (p) { return Object.assign({}, p, { page: Math.max(1, Math.min(model.totalPages(), p.page)) }); });
    }
    function changed() { renderMarkers(); listeners.forEach(function (fn) { fn(list()); }); }
    function save(value) { state.set('pins', value); changed(); }
    function line(value) { return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 160); }
    function drop() {
        var pins = list(), number = 1;
        while (pins.some(function (p) { return p.number === number; })) number++;
        if (number > 9) { core.notify('Nine pins already set. Remove one with :unpin N.', { error: true }); return null; }
        var anchor = model.viewAnchor();
        if (!anchor) return null;
        var section = core.navigation.chapter(), quote = line(core.window.getSelection());
        var root = model.container().getBoundingClientRect();
        var text = Array.from(anchor.page.querySelectorAll('.t')).find(function (t) {
            var r = t.getBoundingClientRect(); return r.bottom > root.top && r.top < root.bottom;
        });
        var title = quote || line((section ? section.label + ' · ' : '') + (text ? line(text.textContent).split(' ').slice(0, 12).join(' ') : 'Page ' + model.pageNumber(anchor.page)));
        var pin = { number: number, page: model.pageNumber(anchor.page), y: anchor.y, x: anchor.x,
            title: title, section: section ? section.label : '', ts: Date.now() };
        pins.push(pin); save(pins);
        core.notify('Pin ' + number + ' · ' + title);
        return pin;
    }
    function jump(n) {
        var pins = list(), pin = n == null ? pins[pins.length - 1] : pins.find(function (p) { return p.number === Number(n); });
        if (!pin) { core.notify('No pin' + (n ? ' ' + n : ' yet'), { error: true }); return null; }
        core.navigation.remember();
        model.restoreViewAnchor({ page: model.page(pin.page), y: pin.y, x: pin.x });
        return pin;
    }
    function remove(n) { save(list().filter(function (p) { return p.number !== Number(n); })); }
    function renderMarkers() {
        markers.forEach(function (m) { m.remove(); }); markers = [];
        list().forEach(function (p) {
            var page = model.page(p.page); if (!page) return;
            var marker = el('button', { class: 'pdf2html-pin-marker', title: 'Pin ' + p.number + ' · ' + p.title,
                onClick: function () { jump(p.number); } }, String(p.number));
            marker.dataset.page = p.page; marker.dataset.y = p.y;
            doc.body.appendChild(marker); markers.push(marker);
        });
        positionMarkers();
    }
    function positionMarkers() {
        var box = model.container().getBoundingClientRect();
        var lastBottom = {};
        markers.slice().sort(function (a,b) { return Number(a.dataset.page)-Number(b.dataset.page) || Number(a.dataset.y)-Number(b.dataset.y); }).forEach(function (m) {
            var r = model.page(Number(m.dataset.page)).getBoundingClientRect();
            var y = r.top + Math.max(0, Math.min(0.98, Number(m.dataset.y))) * r.height;
            y = Math.max(y, lastBottom[m.dataset.page] || -Infinity);
            lastBottom[m.dataset.page] = y + 25;
            m.hidden = y < box.top || y > box.bottom;
            var sidebar = doc.body.classList.contains('sidebar-shown') && doc.getElementById('sidebar');
            var edge = sidebar ? sidebar.getBoundingClientRect().right : box.left;
            m.hidden = m.hidden || r.left < edge + 16;
            var width = Math.max(12, Math.min(21, r.left - edge - 4));
            m.style.width = width + 'px';
            m.style.top = y + 'px'; m.style.left = Math.max(edge + 1, r.left - width - 3) + 'px';
        });
    }
    function mount() {
        model.container().addEventListener('scroll', positionMarkers, { passive: true });
        core.window.addEventListener('resize', positionMarkers);
        new MutationObserver(positionMarkers).observe(doc.documentElement, { attributes: true, attributeFilter: ['style'] });
        doc.addEventListener('pdf2html-viewport-change', positionMarkers);
        state.onChange('pins', changed); state.ready.then(changed); renderMarkers();
        core.window.addEventListener('keydown', function (e) {
            if (!e.ctrlKey || !e.shiftKey || e.metaKey || e.altKey || isInputTarget(e.target)) return;
            if (e.code !== 'KeyP' && e.code !== 'KeyO') return;
            e.preventDefault(); e.stopImmediatePropagation();
            if (e.code === 'KeyP') drop(); else jump();
        }, true);
    }
    return { list: list, drop: drop, jump: jump, remove: remove,
        onChange: function (fn) { listeners.push(fn); }, mount: mount };
}

// Settings modal — `:set`, the sidebar footer button, or ⌘,. Every control
// reads and writes the same preferences and zoom that the palette commands
// use, so the two surfaces cannot disagree.
import { el } from './overlay-dom.js';

export function createSettings(core) {
    var document = core.document;
    var prefs = core.prefs;
    var zoom = core.zoom;

    function isOpen() { return !!document.getElementById('pdf2html-settings'); }
    function close() {
        var ex = document.getElementById('pdf2html-settings');
        if (!ex) return false;
        ex.remove();
        return true;
    }

    function toggle() {
        if (close()) return;
        var bd = el('div', {
            id: 'pdf2html-settings',
            class: 'pdf2html-modal-backdrop',
            onClick: function (e) { if (e.target === bd) bd.remove(); },
        });
        var card = el('div', { class: 'pdf2html-settings-card' });
        card.appendChild(el('div', { class: 'pdf2html-settings-head' }, [
            el('div', {}, [el('h2', {}, 'Settings'), el('div', { class: 'sub' }, ':set  ·  persisted locally')]),
            el('span', { class: 'close', html: '<span class="pdf2html-kbd sm">Esc</span> to close' }),
        ]));

        var body = el('div', { class: 'pdf2html-settings-body', tabindex: '-1' });

        // The slider shows the effective zoom, including an auto-fit result.
        // Moving it switches this document to a manual zoom.
        body.appendChild(group('Appearance', [
            row('Zoom', 'Page scale (:zoom N | auto)',
                slider(0.6, 2.5, 0.1, zoom.current(), formatZoom, function (v) { zoom.set(v); }).wrap),
            row('Dark pages', ':dark · inverts the pages for reading at night', prefSwitch('darkPages')),
        ]));

        // Pin locks the scrolloff slider at 50%; unpinning restores the
        // stored band.
        var scrollOffSlider = slider(0, 50, 1, Math.round(prefs.get('scrollOff') * 100), formatPercent,
            function (v) { prefs.set('scrollOff', v / 100); });
        function syncScrollOff() {
            var pinned = prefs.get('pinned');
            scrollOffSlider.setValue(pinned ? 50 : Math.round(prefs.get('scrollOff') * 100));
            scrollOffSlider.input.disabled = pinned;
        }
        syncScrollOff();

        body.appendChild(group('Behavior', [
            row('Page counter visible', 'Top pill; toggles with ⌘⇧. or :counter', prefSwitch('pageCounterVisible')),
            row('Page counter on page change', ':counter brief · shows it for a moment while hidden', prefSwitch('pageCounterBrief')),
            row('Scrolloff', 'Auto-scroll when cursor enters ±N% band (:so N)', scrollOffSlider.wrap),
            row('Pin cursor to center', ':pin · locks scrolloff to 50%', prefSwitch('pinned', syncScrollOff)),
            row('Case-sensitive search', ':case · / matches exact casing', prefSwitch('searchCaseSensitive')),
            row('Escape clears selection', 'Esc with no overlay open clears the text selection', prefSwitch('escClearsSelection')),
        ]));

        card.appendChild(body);
        bd.appendChild(card);
        document.body.appendChild(bd);
    }

    function group(title, rows) {
        return el('div', { class: 'pdf2html-settings-group' }, [el('h4', {}, title)].concat(rows));
    }
    function row(label, hint, control) {
        return el('div', { class: 'pdf2html-settings-row' }, [
            el('div', {}, [el('div', { class: 'label' }, label), hint ? el('div', { class: 'hint' }, hint) : null]),
            control,
        ]);
    }
    function prefSwitch(name, after) {
        var sw = el('button', { type: 'button', class: 'pdf2html-switch', role: 'switch' });
        function render(on) {
            sw.classList.toggle('on', on);
            sw.setAttribute('aria-checked', on ? 'true' : 'false');
        }
        render(prefs.get(name));
        sw.addEventListener('click', function () {
            render(prefs.toggle(name));
            if (after) after();
        });
        return sw;
    }
    function slider(min, max, step, value, format, onChange) {
        var readout = el('span', { class: 'pdf2html-slider-readout' }, format(value));
        var input = el('input', {
            type: 'range', class: 'pdf2html-slider-input',
            min: String(min), max: String(max), step: String(step), value: String(value),
        });
        input.addEventListener('input', function () {
            var v = parseFloat(input.value);
            readout.textContent = format(v);
            onChange(v);
        });
        return {
            wrap: el('div', { class: 'pdf2html-slider-wrap' }, [input, readout]),
            input: input,
            setValue: function (v) { input.value = String(v); readout.textContent = format(v); },
        };
    }
    function formatZoom(v) { return (Math.round(v * 10) / 10).toFixed(1) + '×'; }
    function formatPercent(v) { return Math.round(v) + '%'; }

    return { toggle: toggle, close: close, isOpen: isOpen };
}

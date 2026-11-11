// Viewer preferences: the one owner of global setting keys, defaults and
// parsing. The palette, the settings modal and the features read and write
// through here, and features follow changes with onChange() instead of being
// poked through globals or hidden form inputs.
//
// Per-document state (zoom, reading position, marks) is not a preference and
// stays with its module.
export function createPreferences(storage) {
    function flag(key, defaultOn) {
        return {
            key: key,
            parse: function (raw) { return raw === null ? defaultOn : raw === '1'; },
            format: function (on) { return on ? '1' : '0'; },
        };
    }
    var SPECS = {
        // Keep the caret on the centre line (Vim `scrolloff=999`).
        liveReload: flag('pdf2html-live-reload', true),
        pinned: flag('pdf2html-pinned', true),
        // Scrolloff band as a fraction of the viewport, 0–0.5.
        scrollOff: {
            key: 'pdf2html-scrolloff',
            parse: function (raw) { return clampScrollOff(raw === null ? 0.25 : parseFloat(raw)); },
            format: function (f) { return String(clampScrollOff(f)); },
        },
        searchCaseSensitive: flag('pdf2html-search-case', false),
        escClearsSelection: flag('pdf2html-esc-clears', true),
        // Stored inverted for compatibility with existing localStorage.
        pageCounterVisible: {
            key: 'pdf2html-pageno-hidden',
            parse: function (raw) { return raw === '0'; },
            format: function (on) { return on ? '0' : '1'; },
        },
        // Show the page counter for a moment on each page change while it is
        // otherwise hidden.
        pageCounterBrief: flag('pdf2html-pageno-brief', false),
        // Invert the pages for reading in the dark.
        darkPages: flag('pdf2html-dark-pages', false),
        sidebarTab: {
            key: 'pdf2html-sidebar-tab',
            parse: function (raw) { return raw === 'thumbs' || raw === 'pins' ? raw : 'outline'; },
            format: String,
        },
    };
    var listeners = {};

    function clampScrollOff(f) {
        if (!isFinite(f) || f < 0) return 0;
        return Math.min(0.5, f);
    }
    function spec(name) {
        var s = SPECS[name];
        if (!s) throw new Error('unknown preference: ' + name);
        return s;
    }
    function read(key) {
        try { return storage.getItem(key); } catch (e) { return null; }
    }

    function get(name) {
        var s = spec(name);
        return s.parse(read(s.key));
    }
    function set(name, value) {
        var s = spec(name);
        var before = get(name);
        try { storage.setItem(s.key, s.format(value)); } catch (e) {}
        var after = get(name);
        if (after !== before) (listeners[name] || []).forEach(function (fn) { fn(after); });
        return after;
    }
    function toggle(name) { return set(name, !get(name)); }
    function onChange(name, fn) {
        spec(name);
        (listeners[name] = listeners[name] || []).push(fn);
    }

    return { get: get, set: set, toggle: toggle, onChange: onChange };
}

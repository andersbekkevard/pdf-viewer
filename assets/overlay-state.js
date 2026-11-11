// Per-document state: position, marks and zoom, shared through the daemon.
//
// localStorage is per origin and per browser, so on its own a document's
// state differs between localhost and 127.0.0.1, and between browser
// profiles. The daemon keeps the shared copy (daemon/state.py); localStorage
// stays the synchronous copy that first paint and resume read.
//
//   get(key)          synchronous read of the in-memory copy
//   set(key, value)   memory + localStorage now, daemon PUT debounced
//   onChange(key, fn) fn(value) when the daemon copy replaces the local one
//   ready             resolves once the first daemon read merged (or failed)
//
// Merge rule: last writer wins by ts (ms); marks merge per letter by each
// mark's own ts, with `{deleted: true, ts}` tombstones for cleared marks.
// On load, anything the browser holds that is newer than the daemon copy is
// pushed — that is how existing localStorage state on either origin
// migrates. A daemon without the state routes (detected via /openapi.json,
// so no 404 reaches the console) or no daemon at all leaves localStorage as
// the only store, as before.
//
// localStorage layout (unchanged formats, so a rollback still reads them):
//   pdf2html-position:<hash>  {page, ts}
//   pdf2html-marks:<hash>     {letter: {page, label, ts} | {deleted, ts}}
//   pdf2html-zoom:<hash>      'auto' | '<number>'  (ts in pdf2html-zoom-ts:<hash>)
export function createDocumentState(core) {
    var fetch = core.fetch;
    var storage = core.storage;
    var window = core.window;
    var hash = core.entryHash();

    var PUT_DELAY = 800;
    var READY_TIMEOUT = 2000;
    var ROUTE_RE = /^\/entry\/\{[^}]+\}\/state$/;

    var memory = {};          // key -> {value, ts}
    var listeners = {};       // key -> [fn]
    var dirty = {};           // key -> true while a PUT is owed
    var available = null;     // null unknown, true routes present, false local only
    var putTimer = null;

    // ------------------------------------------------------------ local copy
    function readJSON(k) {
        try { return JSON.parse(storage.getItem(k) || 'null'); } catch (_) { return null; }
    }
    function stamp(v) { return typeof v === 'number' && isFinite(v) && v >= 0 ? v : 0; }
    function marksTs(marks) {
        var ts = 0;
        for (var l in marks) if (marks[l]) ts = Math.max(ts, stamp(marks[l].ts));
        return ts;
    }
    var codecs = {
        pins: jsonCodec('pins'),
        outline: jsonCodec('outline'),
        position: {
            load: function () {
                var v = readJSON('pdf2html-position:' + hash);
                return v && v.page ? { value: { page: v.page }, ts: stamp(v.ts) } : null;
            },
            save: function (row) {
                storage.setItem('pdf2html-position:' + hash, JSON.stringify({ page: row.value.page, ts: row.ts }));
            },
        },
        marks: {
            load: function () {
                var v = readJSON('pdf2html-marks:' + hash);
                return v && typeof v === 'object' ? { value: v, ts: marksTs(v) } : null;
            },
            save: function (row) { storage.setItem('pdf2html-marks:' + hash, JSON.stringify(row.value)); },
        },
        zoom: {
            load: function () {
                var v = storage.getItem('pdf2html-zoom:' + hash);
                if (v === null) return null;
                return { value: v, ts: stamp(parseFloat(storage.getItem('pdf2html-zoom-ts:' + hash))) };
            },
            save: function (row) {
                storage.setItem('pdf2html-zoom:' + hash, String(row.value));
                storage.setItem('pdf2html-zoom-ts:' + hash, String(row.ts));
            },
        },
    };
    function jsonCodec(key) {
        return {
            load: function () { return readJSON('pdf2html-' + key + ':' + hash); },
            save: function (row) { storage.setItem('pdf2html-' + key + ':' + hash, JSON.stringify(row)); },
        };
    }
    function save(key, row) { try { codecs[key].save(row); } catch (_) {} }
    if (hash) {
        Object.keys(codecs).forEach(function (key) {
            var row = null;
            try { row = codecs[key].load(); } catch (_) {}
            if (row) memory[key] = row;
        });
    }

    // ----------------------------------------------------------------- merge
    function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
    // Per-letter last writer wins; a tie keeps `a`.
    function mergeMarks(a, b) {
        var out = {}, l;
        for (l in a) out[l] = a[l];
        for (l in b) if (b[l] && (!out[l] || stamp(b[l].ts) > stamp(out[l].ts))) out[l] = b[l];
        return out;
    }
    function emit(key) {
        var value = memory[key] ? memory[key].value : null;
        (listeners[key] || []).forEach(function (fn) { try { fn(value); } catch (_) {} });
    }
    // Fold a daemon row into the local copy. Returns whether the daemon is
    // missing something the browser has (so a PUT is owed).
    function absorb(key, remote) {
        var local = memory[key];
        if (!remote) return !!local;
        if (key === 'marks') {
            var merged = mergeMarks(remote.value || {}, local ? local.value : {});
            var row = { value: merged, ts: Math.max(remote.ts, marksTs(merged)) };
            var changed = !local || !same(local.value, merged);
            memory[key] = row;
            if (changed) { save(key, row); emit(key); }
            return !same(remote.value, merged);
        }
        if (local && local.ts > remote.ts) return true;
        // On a tie (e.g. two origins' legacy zoom, both ts 0) the daemon wins.
        var differs = !local || !same(local.value, remote.value);
        memory[key] = { value: remote.value, ts: remote.ts };
        save(key, memory[key]);
        if (differs) emit(key);
        return false;
    }

    // ------------------------------------------------------------------ sync
    function stateUrl(key) { return '/entry/' + hash + '/state' + (key ? '/' + key : ''); }
    function put(key, keepalive) {
        var row = memory[key];
        if (!row) return;
        delete dirty[key];
        var req = fetch(stateUrl(key), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ value: row.value, ts: row.ts }),
            keepalive: !!keepalive,
        });
        if (keepalive) { req.catch(function () {}); return; }
        req.then(function (r) { return r.ok ? r.json() : null; })
            .then(function (stored) {
                // The daemon may hold a newer or merged copy; adopt it unless a
                // newer local write is already queued.
                if (stored && !dirty[key]) absorb(key, stored);
            })
            .catch(function () { dirty[key] = true; });
    }
    function flush(keepalive) {
        if (putTimer) { clearTimeout(putTimer); putTimer = null; }
        if (available !== true) return;
        Object.keys(dirty).forEach(function (key) { put(key, keepalive); });
    }
    function schedule() {
        if (available !== true) return;
        if (putTimer) clearTimeout(putTimer);
        putTimer = setTimeout(function () { putTimer = null; flush(false); }, PUT_DELAY);
    }

    function hasRoutes() {
        return fetch('/openapi.json', { cache: 'no-store' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (spec) {
                var paths = spec && spec.paths ? Object.keys(spec.paths) : [];
                return paths.some(function (p) { return ROUTE_RE.test(p); });
            });
    }
    function load() {
        if (!hash) return Promise.resolve();
        return hasRoutes().then(function (ok) {
            if (!ok) return null;
            return fetch(stateUrl(), { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; });
        }).then(function (remote) {
            if (!remote || typeof remote !== 'object') { available = false; dirty = {}; return; }
            available = true;
            Object.keys(codecs).forEach(function (key) {
                if (absorb(key, remote[key] || null)) dirty[key] = true;
            });
            flush(false);
        }).catch(function () { available = false; dirty = {}; });
    }

    var ready = new Promise(function (resolve) {
        // A hung daemon must not hold up writers that wait on `ready`; a late
        // answer still merges, and listeners decide whether to apply it.
        setTimeout(resolve, READY_TIMEOUT);
        load().then(resolve);
    });

    // While the page is hiding, writes go out at once with keepalive, so a
    // final write from another pagehide listener is not lost whichever
    // listener runs first.
    var hiding = false;
    if (hash) {
        window.addEventListener('pagehide', function () { hiding = true; flush(true); });
        window.addEventListener('pageshow', function () { hiding = false; });
        window.document.addEventListener('visibilitychange', function () {
            hiding = window.document.visibilityState === 'hidden';
            if (hiding) flush(true);
        });
    }

    // ------------------------------------------------------------------- API
    function get(key) { return memory[key] ? memory[key].value : null; }
    function set(key, value) {
        if (!hash || !codecs[key]) return;
        var now = Date.now();
        var row = { value: value, ts: key === 'marks' ? Math.max(now, marksTs(value)) : now };
        memory[key] = row;
        save(key, row);
        if (available === false) return;
        dirty[key] = true;
        if (hiding) flush(true); else schedule();
    }
    function onChange(key, fn) { (listeners[key] = listeners[key] || []).push(fn); }

    return { get: get, set: set, onChange: onChange, ready: ready, hasHash: function () { return !!hash; } };
}

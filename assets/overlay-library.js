// Cached-document catalog and current-entry lifecycle.
export function createLibrary(core) {
    var document = core.document;
    var location = core.location;
    var fetch = core.fetch;
    var history = core.history;
    var entryHash = core.entryHash;
    var notify = core.notify || function () {};
    var completionLimit = 30;
    var currentHash = entryHash();
    var entries = null;

    // Rows of /library?view=finder (catalog.finder_entries): frecency order,
    // each document's saved page, and the previous document relative to this
    // one. Loaded at startup and refreshed whenever quick open opens, so the
    // previous document and positions follow reading in other tabs.
    var inflight = null;
    var listeners = [];
    function fetchRows() {
        if (inflight) return inflight;
        var url = '/library?view=finder' + (currentHash ? '&current=' + encodeURIComponent(currentHash) : '');
        inflight = fetch(url, { cache: 'no-store' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .catch(function () { return null; })
            .then(function (d) {
                inflight = null;
                if (!Array.isArray(d)) { if (entries === null) entries = []; }
                else if (entries === null || JSON.stringify(d) !== JSON.stringify(entries)) entries = d;
                else return entries;
                listeners.forEach(function (fn) { try { fn(entries); } catch (_) {} });
                return entries;
            });
        return inflight;
    }
    function load() { if (entries === null) fetchRows(); }
    function refresh() { return fetchRows(); }
    function loaded() { return entries !== null; }
    function onChange(fn) { listeners.push(fn); }

    function recencyLabel(entry) {
        var n = entry && entry.rank != null ? entry.rank : (entry && entry.count);
        var last = entry && (entry.last_read || entry.last_seen);
        if (!last) return n ? n + 'x' : '';
        var ageSec = (Date.now() / 1000) - last;
        var ago;
        if (ageSec < 60) ago = 'now';
        else if (ageSec < 3600) ago = Math.round(ageSec / 60) + 'm';
        else if (ageSec < 86400) ago = Math.round(ageSec / 3600) + 'h';
        else ago = Math.round(ageSec / 86400) + 'd';
        return n + 'x · ' + ago;
    }

    function normalize(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
    function searchText(entry) {
        if (!entry) return '';
        if (entry.search_text) return normalize(entry.search_text);
        return normalize([entry.title, entry.name, entry.author, entry.file, entry.host, entry.source_ref]
            .filter(Boolean).join(' '));
    }
    function matches(entry, query) {
        var q = normalize(query);
        if (!q) return true;
        var text = searchText(entry);
        return q.split(' ').every(function (token) { return text.indexOf(token) !== -1; });
    }
    function isCurrent(entry) { return !!(currentHash && entry && entry.hash === currentHash); }
    function complete(tail) {
        if (!entries) return [];
        var out = [];
        for (var i = 0; i < entries.length; i++) {
            if (isCurrent(entries[i]) || !matches(entries[i], tail)) continue;
            out.push(entries[i]);
            if (out.length >= completionLimit) break;
        }
        return out.reverse();
    }
    function open(needle) {
        if (!needle || !entries || !entries.length) return;
        var n = needle.toLowerCase().trim(), exact = null, sub = null;
        for (var i = 0; i < entries.length; i++) {
            if (isCurrent(entries[i])) continue;
            var name = (entries[i].name || '').toLowerCase();
            if (name === n) { exact = entries[i]; break; }
            if (!sub && name.indexOf(n) !== -1) sub = entries[i];
        }
        var pick = exact || sub || complete(needle).slice(-1)[0];
        if (pick && pick.href) location.href = pick.href;
    }
    function currentName() {
        var hash = entryHash();
        if (hash && entries) for (var i = 0; i < entries.length; i++) {
            if (entries[i].hash === hash) return String(entries[i].name || '');
        }
        return '';
    }
    function currentSourceRef() {
        var hash = entryHash();
        if (!hash || !entries) return '';
        for (var i = 0; i < entries.length; i++) if (entries[i].hash === hash) {
            return String(entries[i].source_ref || '');
        }
        return '';
    }
    // PUT a JSON body to a daemon entry route. Resolves with the parsed
    // response body, or null after logging the daemon's error detail.
    function putEntry(route, payload, label) {
        var hash = entryHash();
        if (!hash) return Promise.resolve(null);
        return fetch('/entry/' + encodeURIComponent(hash) + route, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        }).then(function (r) {
            return r.json().catch(function () { return null; }).then(function (body) {
                if (r.ok) return body || {};
                var detail = body && body.detail ? String(body.detail) : 'HTTP ' + r.status;
                console.warn('[' + label + ']', detail);
                notify('Could not ' + label + ': ' + detail, { error: true });
                return null;
            });
        }).catch(function (e) {
            console.warn('[' + label + '] failed:', e);
            notify('Could not ' + label + ': the daemon did not answer', { error: true });
            return null;
        });
    }
    function disableCurrent() {
        putEntry('/disabled', { disabled: true, current_url: location.href }, 'disable').then(function (info) {
            var target = info && (info.target_url || info.native_browser_url || info.native_url);
            if (!target) return;
            // The extension may navigate the tab itself; fall back if it hasn't.
            if (info.extension_navigation_queued) {
                setTimeout(function () { if (location.href !== target) location.replace(target); }, 3000);
                return;
            }
            location.replace(target);
        });
    }
    function renameCurrent(newName) {
        var name = String(newName || '').trim();
        if (!name) return;
        putEntry('/name', { name: name }, 'rename').then(function (info) {
            if (!info) return;
            notify(info.renamed === false ? 'Name unchanged' : 'Renamed to ' + (info.new_name || name));
            document.title = info.new_name || name;
            refresh();
            if (info.href) try { history.replaceState(null, '', info.href); } catch (_) {}
        });
    }
    function deleteCurrent() {
        var hash = entryHash(); if (!hash) return;
        fetch('/mapping/' + encodeURIComponent(hash), { method: 'DELETE' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (info) {
                var src = info && info.source_ref;
                if (!src) { location.replace('about:blank'); return; }
                if (src.charAt(0) === '/') src = 'file://' + encodeURI(src);
                location.replace(src);
            }).catch(function (e) {
                console.warn('[delete] failed:', e);
                notify('Could not delete: the daemon did not answer', { error: true });
            });
    }
    function all() { return entries || []; }

    return { load: load, refresh: refresh, loaded: loaded, onChange: onChange, all: all,
        recencyLabel: recencyLabel, searchText: searchText,
        isCurrent: isCurrent, complete: complete, open: open,
        currentName: currentName, currentSourceRef: currentSourceRef, disableCurrent: disableCurrent,
        renameCurrent: renameCurrent, deleteCurrent: deleteCurrent };
}

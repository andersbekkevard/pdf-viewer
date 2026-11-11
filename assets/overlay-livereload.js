// Local-file polling belongs to the tab: no server watcher survives pagehide.
export function createLiveReload(core) {
    var window = core.window, prefs = core.prefs;
    var query = new URLSearchParams(window.location.search);
    var path = query.get('local'), stamp = query.get('stamp');
    var timer = null, controller = null, stopped = false, candidate = null, epoch = 0;
    function stop() {
        stopped = true; epoch++;
        clearTimeout(timer);
        if (controller) controller.abort();
    }
    async function poll() {
        if (stopped || !prefs.get('liveReload') || !path) return;
        var run = epoch;
        controller = new AbortController();
        try {
            var response = await core.fetch('/local-file/check?' + new URLSearchParams({ path: path, stamp: stamp }),
                { cache: 'no-store', signal: controller.signal });
            var result = response.ok ? await response.json() : {};
            if (run !== epoch || stopped || !prefs.get('liveReload')) return;
            if (result.status === 'changed' && candidate === result.stamp) {
                // Flush the latest position/marks/zoom before /read copies state.
                await core.documentState.ready;
                if (run !== epoch) return;
                await Promise.all(['position', 'marks', 'zoom'].map(function (key) {
                    var value = core.documentState.get(key);
                    if (value === null) return Promise.resolve();
                    return core.fetch('/entry/' + core.entryHash() + '/state/' + key, {
                        method: 'PUT', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ value: value, ts: Date.now() }), signal: controller.signal,
                    }).then(function (r) { if (!r.ok) throw new Error('state save failed'); });
                }));
                // Fetch first: a truncated/invalid PDF returns 409 and leaves this tab intact.
                if (run !== epoch) return;
                var opened = await core.fetch('/read?' + new URLSearchParams({ path: path }),
                    { cache: 'no-store', redirect: 'follow', signal: controller.signal });
                if (run === epoch && opened.ok && !stopped && prefs.get('liveReload')) {
                    window.location.replace(opened.url);
                    return;
                }
            }
            candidate = result.status === 'changed' ? result.stamp : null;
        } catch (_) { /* save in progress, deleted file, or daemon unavailable: retry */ }
        if (run === epoch && !stopped && prefs.get('liveReload')) timer = setTimeout(poll, 500);
    }
    function start() {
        stop(); stopped = false; candidate = null;
        if (path && prefs.get('liveReload')) timer = setTimeout(poll, 500);
    }
    prefs.onChange('liveReload', start);
    window.addEventListener('pagehide', stop);
    window.addEventListener('pageshow', start);
    if (!path && core.entryHash()) {
        core.fetch('/local-file/current?hash=' + core.entryHash(), { cache: 'no-store' })
            .then(function (r) { return r.ok ? r.json() : {}; })
            .then(function (info) { path = info.path; stamp = info.stamp; if (!stopped) start(); })
            .catch(function () {});
    }
    start();
    return { stop: stop };
}

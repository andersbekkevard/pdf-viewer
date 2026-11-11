// Content-free, bounded load telemetry. No polling or text/geometry traversal.
try {
    const hash = document.querySelector('meta[name="pdf2html-hash"]')?.content || location.pathname.match(/^\/r\/([a-f0-9]+)\//)?.[1];
    if (hash && /^[a-f0-9]{6,64}$/.test(hash)) {
        const data = { load_id: crypto.randomUUID(), first_page_ms: null, text_ms: null, raster_failures: 0, timeouts: 0, errors: [] };
        let dirty = true, painting = false;
        const safe = fn => (...args) => { try { fn(...args); } catch (_) {} };
        const flush = safe(() => {
            if (!dirty) return;
            dirty = false;
            const body = JSON.stringify(data), url = '/entry/' + hash + '/timing';
            if (!navigator.sendBeacon?.(url, body)) fetch(url, {method: 'POST', body, keepalive: true}).catch(() => {});
        });
        const checkText = safe(() => {
            if (data.text_ms === null && document.documentElement.dataset.readerText === 'complete') {
                data.text_ms = performance.now(); dirty = true; flush(); observer.disconnect();
            }
        });
        const observer = new MutationObserver(checkText);
        observer.observe(document.documentElement, {attributes: true, attributeFilter: ['data-reader-text']});
        const raster = safe(img => {
            if (!img?.matches?.('.pf img.bi') || !img.complete || !img.naturalWidth || data.first_page_ms !== null || painting) return;
            const r = img.getBoundingClientRect();
            if (r.bottom <= 0 || r.top >= innerHeight || !r.width) return;
            painting = true;
            requestAnimationFrame(safe(() => requestAnimationFrame(safe(() => {
                data.first_page_ms = performance.now(); dirty = true; flush();
            }))));
        });
        document.addEventListener('load', safe(e => raster(e.target)), true);
        document.addEventListener('error', safe(e => { if (e.target?.matches?.('.pf img.bi')) { data.raster_failures++; dirty = true; flush(); } }), true);
        addEventListener('error', safe(e => { if (e.error && data.errors.length < 10) { data.errors.push(({TypeError:'type-error', RangeError:'range-error', SyntaxError:'syntax-error'})[e.error.name] || 'overlay-error'); dirty = true; flush(); } }));
        addEventListener('unhandledrejection', safe(() => { if (data.errors.length < 10) { data.errors.push('unhandled-rejection'); dirty = true; flush(); } }));
        addEventListener('pagehide', flush);
        document.addEventListener('visibilitychange', safe(() => { if (document.hidden) flush(); }));
        setTimeout(safe(() => { if (data.first_page_ms === null || data.text_ms === null) { data.timeouts++; dirty = true; } observer.disconnect(); flush(); }), 60000);
        document.querySelectorAll('.pf img.bi').forEach(raster);
        checkText();
    }
} catch (_) { /* Optional telemetry never prevents the overlay from mounting. */ }

// pdf_viewer page script — the reader at the PDF's own address.
//
// Runs at document_start in every top-level page and returns at once unless
// the page is a PDF this extension took over:
//
//   web    rules.json and the service worker's per-document rules rewrite a
//          PDF response's Content-Type to text/plain and add a
//          `Server-Timing: pdfv` entry, so Chrome builds an ordinary
//          (standards-mode) text page at the PDF's URL instead of starting
//          its viewer; the entry is how this script knows, synchronously.
//   file   Chrome starts a PDF document (contentType application/pdf); this
//          script runs before its viewer is created.
//
// It then replaces the page's root with the reader shell, fetched from the
// daemon through the bridge frame (bridge.js), connects the overlay's daemon
// transport (assets/overlay-daemon.js) and imports the overlay. The address
// bar keeps the PDF's URL. docs/in-place.md has the whole design.
//
// Vimium decides which keys it leaves to a page by the page's URL, so the
// address carries a `#page=<n>` fragment, the standard PDF page fragment kept
// at the page being read; docs/keybindings.md has the exclusion rule.
(() => {
    'use strict';

    const VIEWER = 'http://localhost:7435';
    const PASSTHROUGH = '_pdfvw=passthrough';

    if (window.top !== window) return;

    // On the daemon's own origin the reader needs nothing from this script.
    // Its localStorage holds the preferences set there so far: copy them
    // once, so readers at other addresses start with the same settings.
    if (location.origin === VIEWER) {
        seedPreferences();
        preferOwnAddress();
        return;
    }
    if (!takenOver()) return;

    function takenOver() {
        if (location.search.includes(PASSTHROUGH)) return false;
        if (location.protocol === 'file:') return document.contentType === 'application/pdf';
        if (location.protocol !== 'http:' && location.protocol !== 'https:') return false;
        if (document.contentType !== 'text/plain') return false;
        const nav = performance.getEntriesByType('navigation')[0];
        return !!(nav && nav.serverTiming && nav.serverTiming.some((entry) => entry.name === 'pdfv'));
    }

    // A document opened at the daemon's address (the library, an old link, the
    // open script) moves to its own address when it has one. Hidden until the
    // service worker has decided, so nothing flashes; `_pdfvw=local` is how
    // the worker says "stay here" (the site cannot be reached, say).
    function preferOwnAddress() {
        const entry = location.pathname.match(/^\/r\/([a-f0-9]{6,32})\/[^/]*$/);
        if (!entry || /^(icon|ocr)$/.test(location.pathname.split('/').pop())) return;
        if (location.search.includes('_pdfvw=local')) return;
        const root = document.documentElement;
        const show = () => { if (root) root.style.removeProperty('visibility'); };
        if (root) root.style.setProperty('visibility', 'hidden');
        const page = Number((location.hash.match(/[#&]page=(\d+)/i) || [])[1])
            || parseInt((location.hash.match(/^#pf([0-9a-f]+)$/i) || [])[1] || '', 16) || 0;
        setTimeout(show, 1500);
        chrome.runtime.sendMessage({ type: 'pdfv-own-address', hash: entry[1], page })
            .then((moving) => { if (moving !== true) show(); }, show);
    }

    function seedPreferences() {
        chrome.storage.local.get('pdfv-seeded').then((got) => {
            if (got['pdfv-seeded']) return;
            const items = { 'pdfv-seeded': '1' };
            try {
                for (let i = 0; i < localStorage.length; i++) {
                    const key = localStorage.key(i);
                    if (key && key.startsWith('pdf2html-') && !key.includes(':')) items[key] = localStorage.getItem(key);
                }
            } catch (_) {
                return;
            }
            // Nothing set there yet: try again on a later visit.
            if (Object.keys(items).length > 1) chrome.storage.local.set(items);
        }).catch(() => {});
    }

    // ------------------------------------------------------------------
    // The page: an empty document at this URL, before anything paints.
    // ------------------------------------------------------------------

    const requestedHash = location.hash;
    const pageUrl = location.href.split('#')[0];

    function fileName() {
        try {
            return decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || '') || location.host;
        } catch (_) {
            return location.host;
        }
    }

    const root = document.createElement('html');
    root.innerHTML = '<head><meta charset="utf-8"><meta name="color-scheme" content="light dark">'
        + '<title></title><style>html{background:Canvas;color:CanvasText}'
        + '#pdfv-opening{font:15px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;display:grid;'
        + 'place-items:center;min-height:100vh;margin:0;opacity:0;transition:opacity .2s}'
        + '#pdfv-opening.shown{opacity:.7}</style></head><body><p id="pdfv-opening">Opening…</p></body>';
    root.querySelector('title').textContent = fileName();
    for (const node of Array.from(document.childNodes)) {
        if (node.nodeType !== Node.DOCUMENT_TYPE_NODE) node.remove();
    }
    document.appendChild(root);
    // Stops the PDF's download (web) and Chrome's viewer from starting (file).
    window.stop();
    setTimeout(() => {
        const note = document.getElementById('pdfv-opening');
        if (note) note.classList.add('shown');
    }, 400);

    // The fragment Vimium's exclusion rule matches, from the first moment.
    // `#page=0` until the reader knows its page: the later change to a real
    // page also makes Vimium read the address again.
    function setPageFragment(page) {
        try {
            history.replaceState(history.state, '', location.pathname + location.search + '#page=' + page);
        } catch (_) {}
    }
    // The page the address asked for: `#page=12`, or the reader's own `#pfc`.
    const requestedPage = Number((requestedHash.match(/[#&]page=(\d+)/i) || [])[1])
        || parseInt((requestedHash.match(/^#pf([0-9a-f]+)$/i) || [])[1] || '', 16) || 0;
    setPageFragment(requestedPage);

    // ------------------------------------------------------------------
    // The bridge: a hidden extension frame that talks to the daemon.
    // ------------------------------------------------------------------

    function randomToken() {
        const bytes = crypto.getRandomValues(new Uint8Array(24));
        return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    }

    function openBridge() {
        return new Promise((resolve, reject) => {
            const token = randomToken();
            const frame = document.createElement('iframe');
            frame.id = 'pdfv-bridge';
            frame.setAttribute('aria-hidden', 'true');
            frame.tabIndex = -1;
            frame.style.cssText = 'display:none!important';
            const timer = setTimeout(() => reject(new Error('bridge did not answer')), 8000);
            frame.addEventListener('load', () => {
                const channel = new MessageChannel();
                channel.port1.onmessage = (event) => {
                    clearTimeout(timer);
                    if (event.data && event.data.ready) resolve(channel.port1);
                    else reject(new Error('bridge refused'));
                };
                frame.contentWindow.postMessage({ pdfv: 'connect', token }, new URL(frame.src).origin, [channel.port2]);
            }, { once: true });
            chrome.runtime.sendMessage({ type: 'pdfv-bridge-token', token }).then(() => {
                frame.src = chrome.runtime.getURL('bridge.html');
                // On the root, not the body: the shell replaces the body.
                document.documentElement.appendChild(frame);
            }, reject);
        });
    }

    function createClient(port) {
        let next = 1;
        const waiting = new Map();
        port.onmessage = (event) => {
            const msg = event.data || {};
            const entry = waiting.get(msg.id);
            if (!entry) return;
            waiting.delete(msg.id);
            if (msg.ok) entry.resolve(msg.result);
            else entry.reject(Object.assign(new Error(msg.error || 'bridge error'), { aborted: !!msg.aborted }));
        };
        function call(message, signal) {
            const id = next++;
            return new Promise((resolve, reject) => {
                if (signal && signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
                waiting.set(id, { resolve, reject });
                port.postMessage(Object.assign({ id }, message));
                if (signal) {
                    signal.addEventListener('abort', () => {
                        if (!waiting.delete(id)) return;
                        port.postMessage({ op: 'abort', target: id });
                        reject(new DOMException('Aborted', 'AbortError'));
                    }, { once: true });
                }
            });
        }
        // A daemon path → Response, as window.fetch would give on its origin.
        function daemonFetch(url, init) {
            init = init || {};
            const headers = {};
            if (init.headers) new Headers(init.headers).forEach((value, name) => { headers[name] = value; });
            const message = { op: 'fetch', url: String(url), init: {
                method: init.method, headers, cache: init.cache,
                body: init.body == null ? null : String(init.body),
            } };
            return call(message, init.signal).then((r) => {
                const empty = r.status === 204 || r.status === 205 || r.status === 304;
                return new Response(empty ? null : r.blob, { status: r.status, statusText: r.statusText, headers: r.headers });
            }, (error) => {
                if (error.name === 'AbortError') throw error;
                throw new TypeError('daemon request failed: ' + error.message);
            });
        }
        return { call, fetch: daemonFetch };
    }

    // ------------------------------------------------------------------
    // Leaving: the browser's own viewer, another document, the library.
    // ------------------------------------------------------------------

    function nativeUrl() {
        return pageUrl + (pageUrl.includes('?') ? '&' : '?') + PASSTHROUGH;
    }

    function navigate(url, newTab) {
        // The service worker moves the tab: a web page may not go to file://.
        chrome.runtime.sendMessage({ type: 'pdfv-navigate', url, newTab: !!newTab }).catch(() => {
            if (!newTab) location.href = url;
        });
    }

    function leave(url) {
        // A local PDF's bare address would bring the reader back.
        if (/^file:/.test(url) && !url.includes(PASSTHROUGH)) {
            url += (url.includes('?') ? '&' : '?') + PASSTHROUGH;
        }
        if (/^https?:/.test(url) || location.protocol === 'file:') location.replace(url);
        else navigate(url, false);
    }

    function toNative(reason) {
        console.warn('pdf_viewer: opening in the browser\'s viewer —', reason);
        location.replace(nativeUrl() + (requestedHash || ''));
    }

    // ------------------------------------------------------------------
    // The reader: shell markup from the daemon, then the overlay.
    // ------------------------------------------------------------------

    const asset = (name) => chrome.runtime.getURL('assets/' + name);

    function loaded(link) {
        return new Promise((resolve) => {
            link.addEventListener('load', resolve, { once: true });
            link.addEventListener('error', resolve, { once: true });
            setTimeout(resolve, 1500);
        });
    }

    function loadStylesheet() {
        const css = document.createElement('link');
        css.id = 'pdf2html-overlay-css';
        css.rel = 'stylesheet';
        css.href = asset('overlay.css');
        const ready = loaded(css);
        document.head.appendChild(css);
        return ready;
    }

    function loadIconAfterRaster(client, href) {
        // Figure extraction takes a PDFium worker. Keep it outside the first
        // visible page's work, with a fallback when a raster never arrives.
        const timer = setTimeout(loadIcon, 2000);
        document.addEventListener('load', onImage, true);
        function onImage(event) {
            const img = event.target;
            if (img?.matches?.('.pf img.bi') && img.naturalWidth > 1) loadIcon();
        }
        function loadIcon() {
            clearTimeout(timer);
            document.removeEventListener('load', onImage, true);
            client.fetch(href).then((r) => r.ok ? r.blob() : null).then((blob) => {
                if (!blob) return;
                const link = document.createElement('link');
                link.id = 'pdf2html-favicon';
                link.rel = 'icon';
                link.href = URL.createObjectURL(blob);
                document.head.appendChild(link);
            }).catch(() => {});
        }
    }

    async function mountShell(shellText, client, styles) {
        const shell = new DOMParser().parseFromString(shellText, 'text/html');
        // The overlay loads rasters through the bridge, including the first
        // one. Never load daemon paths relative to the PDF's origin.
        shell.querySelectorAll('img[src]').forEach((img) => img.removeAttribute('src'));

        const head = document.head;
        head.querySelectorAll('style, title').forEach((node) => node.remove());
        const title = document.createElement('title');
        title.textContent = shell.title || fileName();
        head.appendChild(title);
        shell.head.querySelectorAll('meta[name], style').forEach((node) => head.appendChild(document.adoptNode(node)));

        const icon = shell.head.querySelector('link[rel="icon"]');
        if (icon) loadIconAfterRaster(client, icon.getAttribute('href'));

        for (const attr of Array.from(shell.documentElement.attributes)) {
            document.documentElement.setAttribute(attr.name, attr.value);
        }
        await styles;
        const body = document.adoptNode(shell.body);
        document.body.replaceWith(body);
    }

    function createStorage(stored) {
        return {
            getItem: (key) => (Object.prototype.hasOwnProperty.call(stored, key) ? stored[key] : null),
            setItem: (key, value) => {
                stored[key] = String(value);
                chrome.storage.local.set({ [key]: String(value) }).catch(() => {});
            },
            removeItem: (key) => {
                delete stored[key];
                chrome.storage.local.remove(key).catch(() => {});
            },
        };
    }

    function createTransport(client, stored, readerPath) {
        const query = new URLSearchParams(readerPath.includes('?') ? readerPath.slice(readerPath.indexOf('?') + 1) : '');
        // The fragment in the address bar is this script's. The overlay sees
        // the page the address came with, until it clears it (the reader has
        // moved on, overlay-navigation.js).
        let hash = requestedPage ? '#page=' + requestedPage : '';
        const fragmentOf = (url) => (String(url == null ? '' : url).match(/#.*$/) || [''])[0];
        return {
            fetch: client.fetch,
            storage: createStorage(stored),
            query,
            location: {
                get hash() { return hash; },
                get pathname() { return location.pathname; },
                get search() { return location.search; },
                get origin() { return location.origin; },
                get href() { return location.href; },
            },
            history: {
                replaceState: (_state, _title, url) => { hash = fragmentOf(url); },
                pushState: (_state, _title, url) => { hash = fragmentOf(url); },
            },
            image: (url, signal) => client.call({ op: 'fetch', url: String(url), init: {} }, signal).then((r) => {
                if (r.status !== 200) throw new Error('HTTP ' + r.status);
                return URL.createObjectURL(r.blob);
            }),
            release: (src) => { try { URL.revokeObjectURL(src); } catch (_) {} },
            // A daemon address → where a tab shows it: the document's own URL
            // when it has one, else the daemon's page.
            open: async (href, newTab) => {
                let url = VIEWER + href;
                try {
                    const entry = href.match(/^\/r\/([a-f0-9]{6,32})(?:\/|$)/);
                    if (entry) {
                        const answer = await (await client.fetch('/extension/address/' + entry[1], { cache: 'no-store' })).json();
                        if (answer && answer.url) url = answer.url;
                    } else if (/^\/(?:read|view)\?url=/.test(href)) {
                        url = new URLSearchParams(href.slice(href.indexOf('?') + 1)).get('url') || url;
                    }
                } catch (_) {}
                navigate(url, newTab);
            },
            leave,
            url: (path) => VIEWER + path,
            post: (url, body) => { client.fetch(url, { method: 'POST', body }).catch(() => {}); },
            viewport: (width, dpr) => {
                chrome.storage.local.set({ 'pdfv-viewport': width + 'x' + dpr }).catch(() => {});
            },
        };
    }

    // The address follows the page being read (debounced: every change makes
    // Vimium re-read the address).
    function followPage(first) {
        let shown = null, timer = null, pending = first;
        function write() {
            timer = null;
            if (pending === shown) return;
            shown = pending;
            setPageFragment(shown);
        }
        document.addEventListener('pdf2html-page-change', (event) => {
            const page = event.detail && event.detail.page;
            if (!page || page < 1) return;
            pending = page;
            if (timer) clearTimeout(timer);
            timer = setTimeout(write, 600);
        });
        write();
    }

    // Vimium asks which keys to leave to this page when its script starts,
    // which can be before the browser has recorded the `#page=` fragment, and
    // again whenever the window gains focus. Its later re-checks on an address
    // change wait for DOMContentLoaded, which a stopped document never fires.
    // So, once the address is settled, move focus into a throwaway frame and
    // back: the window's focus event makes Vimium ask again. Only when this
    // tab already has focus; a background tab gets the real event later.
    function nudgeVimium() {
        if (!document.hasFocus()) return;
        const active = document.activeElement;
        const frame = document.createElement('iframe');
        frame.setAttribute('aria-hidden', 'true');
        frame.tabIndex = -1;
        frame.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;border:0;pointer-events:none';
        document.documentElement.appendChild(frame);
        try {
            frame.contentWindow.focus();
            window.focus();
        } catch (_) {}
        frame.remove();
        if (active && active !== document.body && active.focus) active.focus({ preventScroll: true });
    }

    async function open() {
        // Start local asset loading while the bridge locates the PDF. The
        // composition module has no work to do until the shell is mounted.
        const styles = loadStylesheet();
        const modules = Promise.all([import(asset('overlay-daemon.js')), import(asset('overlay.js'))]);
        const shell = Promise.all([openBridge(), chrome.storage.local.get(null).catch(() => ({}))])
            .then(async ([port, stored]) => {
                const client = createClient(port);
                const found = await client.call({
                    op: 'locate', pageUrl, requestedPage, viewport: stored['pdfv-viewport'] || '',
                });
                return { client, stored, found };
            });
        const [{ client, stored, found }, [host, overlay]] = await Promise.all([shell, modules]);
        if (!found || !found.shell) {
            toNative(found && found.native ? 'the daemon left it to the browser' : 'no reader for this address');
            return;
        }
        await mountShell(found.shell, client, styles);
        host.connect(createTransport(client, stored, found.reader));
        overlay.mountOverlay();
        followPage(requestedPage || 1);
        setTimeout(nudgeVimium, 250);
    }

    open().catch((error) => toNative(error && error.message || String(error)));
})();

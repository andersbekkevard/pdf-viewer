// pdf_viewer bridge — the daemon, for a reader built at a PDF's own address.
//
// A page on another site may not call localhost (CORS, and Chrome's local
// network permission), and the daemon answers no cross-origin request on
// purpose: any site could otherwise read the library. This extension page
// can call it. The page script (page.js) embeds it as a hidden frame and
// talks to it over a MessagePort; fetched bodies cross as Blobs, uncopied.
//
// bridge.html is web-accessible, so any site can frame it. It therefore
// serves only the frame's own tab's page script: page.js registers a random
// token with the service worker over extension messaging, which no web page
// can send, and the first message here must carry that token.

const DAEMON = 'http://127.0.0.1:7435';

const inflight = new Map();
let preload = null;


function daemonUrl(path) {
    // Daemon paths only: never an absolute URL chosen by the caller.
    if (typeof path !== 'string' || path[0] !== '/' || path[1] === '/') throw new Error('not a daemon path');
    return DAEMON + path;
}

async function daemonFetch(msg, signal) {
    const init = msg.init || {};
    const resp = await fetch(daemonUrl(msg.url), {
        method: init.method || 'GET',
        headers: init.headers || undefined,
        body: init.body == null ? undefined : init.body,
        cache: init.cache || 'default',
        signal,
    });
    const headers = {};
    for (const name of ['content-type', 'cache-control', 'etag']) {
        const value = resp.headers.get(name);
        if (value) headers[name] = value;
    }
    return { status: resp.status, statusText: resp.statusText, headers, blob: await resp.blob() };
}

async function json(path, init) {
    const resp = await fetch(daemonUrl(path), init);
    if (!resp.ok) throw new Error(`${path}: HTTP ${resp.status}`);
    return resp.json();
}

function prefetchRaster(response, requestedPage) {
    // The shell response supplies the same revision and width the overlay
    // will request. A different viewport, jump or zoom still fetches normally.
    const link = response.headers.get('Link') || '';
    const match = link.match(/^<(\/r\/[a-f0-9]+\/rev\/[\d-]+\/p\/(\d+)\/\d+\.jpg)>; rel=preload; as=image$/);
    if (!match || (requestedPage && Number(match[2]) !== requestedPage)) return;
    const controller = new AbortController();
    const url = match[1];
    const result = daemonFetch({ url }, controller.signal).catch(() => null);
    const entry = { url, result };
    preload = entry;
    // A width prediction may go unused. Keep only one temporary response.
    setTimeout(() => {
        if (preload === entry) preload = null;
        controller.abort();
    }, 3000);
}

async function fetchWithPreload(msg, signal) {
    if (preload && msg.url === preload.url && (!msg.init?.method || msg.init.method === 'GET')) {
        const { result } = preload;
        preload = null;
        const warmed = await result;
        if (!signal.aborted && warmed?.status === 200) return warmed;
    }
    return daemonFetch(msg, signal);
}

// Where the reader of this tab's URL is: {hash, reader, shell} or {native}.
async function locate(msg) {
    if (/^https?:/.test(msg.pageUrl)) {
        // The daemon may want the PDF through the browser's session; the
        // service worker answers that (background.js, "Browser opens").
        chrome.runtime.sendMessage({ type: 'pdfv-browser-open', url: msg.pageUrl }).catch(() => {});
    }
    const answer = await json('/extension/locate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: msg.pageUrl }),
        cache: 'no-store',
    });
    let reader = answer.reader || null;
    let native = answer.native || null;
    if (!reader && answer.wait != null) {
        // Still fetching (a large or sign-in-gated PDF): wait for its target.
        for (;;) {
            let status;
            try {
                status = await json(`/extension/open/${answer.wait}?wait=20`, { cache: 'no-store' });
            } catch (_) {
                break;   // expired
            }
            if (status.state !== 'done') continue;
            if (/^\/r\//.test(status.target || '')) reader = status.target;
            else native = status.target || native;
            break;
        }
    }
    if (!reader) return { native };
    const headers = msg.viewport ? { 'X-Pdfv-Viewport': msg.viewport } : {};
    const resp = await fetch(daemonUrl(reader), { headers, cache: 'no-store' });
    if (!resp.ok) throw new Error(`shell: HTTP ${resp.status}`);
    prefetchRaster(resp, msg.requestedPage);
    const hash = (reader.match(/^\/r\/([a-f0-9]{6,32})\//) || [])[1];
    return { hash, reader, shell: await resp.text() };
}

async function handle(port, msg) {
    if (msg.op === 'abort') {
        const controller = inflight.get(msg.target);
        if (controller) controller.abort();
        return;
    }
    const controller = new AbortController();
    inflight.set(msg.id, controller);
    try {
        const result = msg.op === 'locate' ? await locate(msg) : await fetchWithPreload(msg, controller.signal);
        port.postMessage({ id: msg.id, ok: true, result });
    } catch (error) {
        port.postMessage({ id: msg.id, ok: false, error: String(error && error.message || error), aborted: controller.signal.aborted });
    } finally {
        inflight.delete(msg.id);
    }
}

let connected = false;
window.addEventListener('message', async (event) => {
    if (connected || event.source !== window.parent) return;
    const data = event.data || {};
    const port = event.ports && event.ports[0];
    if (data.pdfv !== 'connect' || typeof data.token !== 'string' || !port) return;
    let valid = false;
    try {
        valid = await chrome.runtime.sendMessage({ type: 'pdfv-bridge-check', token: data.token });
    } catch (_) {
        valid = false;
    }
    if (valid !== true || connected) { port.postMessage({ refused: true }); return; }
    connected = true;
    port.onmessage = (e) => handle(port, e.data || {});
    port.postMessage({ ready: true });
});

// pdf_viewer extension — service worker.
//
// A PDF is read at its own address (docs/in-place.md). Nothing is redirected:
// header rules make Chrome build an ordinary page where it would have started
// its PDF viewer, and the page script (page.js) puts the reader there.
//
//   rules.json   any response typed application/pdf (or a `.pdf` URL typed
//                octet-stream), unless it is a download: Content-Type becomes
//                text/plain and a `Server-Timing: pdfv` entry marks it.
//   this worker  one dynamic rule per cached URL entry, from /cache-urls: the
//                same rewrite whatever the response's type, so a cached
//                document opens even when its host now answers with a sign-in
//                page; or an allow rule for an entry the user disabled.
//   local files  no rule: page.js sees Chrome's PDF document directly.
//
// Ordering: a disabled entry's allow rule has priority 4, an entry's rewrite
// 1, the passthrough allow 2, the static rewrites 1. An allow rule that wins
// stops the rewrites below it, so:
//   - disabled cached URL → allow (p4) → the browser's viewer
//   - URL carrying `_pdfvw=passthrough` → allow (p2) → the browser's viewer
//   - any other PDF response → rewrite → the reader, at that URL
//
// Service workers in MV3 can be terminated, so we use chrome.alarms (survives
// suspension) rather than setInterval.
//
// Sign-in-gated PDFs (see "Browser opens" below): when the daemon cannot
// download a URL itself, this worker fetches it with the browser's session
// and uploads the bytes. While the daemon is unreachable a session allow rule
// switches every rewrite off, so PDFs open in the browser's viewer.
//
// The daemon's own pages (`/r/<hash>/` on its origin, the library) still
// work as before and are what a document without a usable address falls back
// to; `/view-raw` navigations there keep their handling below.

// The service worker talks to the daemon on 127.0.0.1; redirected documents
// open on VIEWER, the origin the static rule, the open script and the
// Vimium exclusion use, so the viewer's localStorage is not split in two.
const DAEMON = 'http://127.0.0.1:7435';
const VIEWER = 'http://localhost:7435';
const DYNAMIC_RULE_ID_BASE = 1000;
const SYNC_ALARM = 'pdfviewer-sync';

// What a rewrite rule does to a PDF response (rules.json repeats it): a plain
// text page that page.js recognizes, free of the response's own restrictions
// on what the page may load.
const REWRITE_HEADERS = [
    { header: 'content-type', operation: 'set', value: 'text/plain; charset=utf-8' },
    { header: 'x-content-type-options', operation: 'set', value: 'nosniff' },
    { header: 'server-timing', operation: 'set', value: 'pdfv' },
    { header: 'content-disposition', operation: 'remove' },
    { header: 'content-security-policy', operation: 'remove' },
    { header: 'content-security-policy-report-only', operation: 'remove' },
    { header: 'cross-origin-embedder-policy', operation: 'remove' },
    { header: 'permissions-policy', operation: 'remove' },
    { header: 'refresh', operation: 'remove' },
];

// The URL a tab reports is the browser's normalized form of what the daemon
// sent it to; compare both that way.
function sameUrl(tabUrl, url) {
    if (tabUrl === url) return true;
    try {
        return tabUrl === new URL(url).href;
    } catch (_) {
        return false;
    }
}

function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Serialize syncs — multiple listeners (onInstalled, onStartup, top-level
// call, alarm) can fire within milliseconds of each other on extension load.
// Without this, two concurrent calls both read getDynamicRules() → [], both
// try to add id 1000, second one fails with "Rule with id 1000 does not have
// a unique ID." The mutex collapses concurrent calls into one.
let _syncInFlight = null;
// Fingerprint of the rule set this service worker last installed. The 30 s
// alarm then only touches declarativeNetRequest when the cache changed, so a
// steady state never passes through the brief remove-then-add gap below.
// Empty after a service-worker restart, which costs one full sync.
let _appliedRulesKey = null;

function syncCachedRules() {
    if (_syncInFlight) return _syncInFlight;
    _syncInFlight = _runSync().finally(() => { _syncInFlight = null; });
    return _syncInFlight;
}

async function _runSync() {
    let entries;
    try {
        const health = await fetch(`${DAEMON}/healthz`, { cache: 'no-store' });
        setDaemonDown(false);
        if (!health.ok) {
            console.warn(`pdf_viewer: /healthz returned ${health.status}`);
            return;
        }
        const resp = await fetch(`${DAEMON}/cache-urls`, { cache: 'no-store' });
        if (!resp.ok) {
            console.warn(`pdf_viewer: /cache-urls returned ${resp.status}`);
            return;
        }
        entries = await resp.json();
    } catch (e) {
        // Daemon down, or CORS / network error. Leave any previously-installed
        // rules in place — stale is better than an empty ruleset — and let
        // the session allow rule keep them from sending tabs to a dead port.
        console.warn('pdf_viewer: /cache-urls fetch failed —', e.message);
        setDaemonDown(true);
        return;
    }

    if (!Array.isArray(entries)) {
        console.warn('pdf_viewer: /cache-urls returned non-array', entries);
        return;
    }

    // A rule's filter must be ASCII (Chromium requirement). Host+path URL
    // segments should already be, but skip with a warning rather than fail
    // the whole sync.
    const isAscii = (s) => /^[\x00-\x7f]*$/.test(s);

    const addRules = [];
    let ruleIdCounter = DYNAMIC_RULE_ID_BASE;

    // Chrome reads this file from disk whenever the worker restarts, but keeps
    // the manifest and rules.json it loaded. Until the extension is reloaded
    // after an update from 0.4, there is no page script to build the reader:
    // install no rewrite rules, so the old static redirects keep working.
    const inPlace = (chrome.runtime.getManifest().content_scripts || []).length > 0;
    if (!inPlace) entries = [];

    for (const entry of entries) {
        // A local file needs no rule: page.js sees it, and asks the daemon
        // whether the entry is disabled.
        if (entry.kind === 'file') continue;
        // The exact navigation URL, whatever its query (signed URLs).
        const hostPath = entry.host + entry.path;
        const regexFilter = `^https?://${escapeRegex(hostPath)}(?:[?#].*)?$`;
        if (!isAscii(regexFilter)) {
            console.warn('pdf_viewer: non-ASCII in regex — skipping rule for', hostPath);
            continue;
        }
        addRules.push({
            id: ruleIdCounter++,
            priority: entry.disabled ? 4 : 1,
            action: entry.disabled
                ? { type: 'allow' }
                : { type: 'modifyHeaders', responseHeaders: REWRITE_HEADERS },
            condition: {
                regexFilter,
                resourceTypes: ['main_frame'],
                requestMethods: ['get'],
                excludedRequestDomains: ['localhost', '127.0.0.1']
            }
        });
    }

    const rulesKey = JSON.stringify(addRules);

    // We only touch IDs >= DYNAMIC_RULE_ID_BASE so static rule IDs (1, 2)
    // are never disturbed.
    let existing;
    try {
        existing = await chrome.declarativeNetRequest.getDynamicRules();
    } catch (e) {
        console.error('pdf_viewer: getDynamicRules failed —', e.message);
        return;
    }
    if (!Array.isArray(existing)) {
        console.warn('pdf_viewer: getDynamicRules returned non-array:', existing);
        existing = [];
    }

    const removeRuleIds = existing
        .filter(r => r && typeof r.id === 'number' && r.id >= DYNAMIC_RULE_ID_BASE)
        .map(r => r.id);

    if (rulesKey === _appliedRulesKey && removeRuleIds.length === addRules.length) {
        return;
    }

    console.log(
        `pdf_viewer: existing dynamic ids`,
        existing.map(r => r && r.id),
        `→ removing`, removeRuleIds
    );

    // Two-step update instead of one atomic call. Chromium has historically
    // had a bug where an update that both removes id N and adds id N in the
    // same call can fail with "Rule with id N does not have a unique ID" —
    // the uniqueness check runs against the pre-removal state. Splitting into
    // a remove call followed by an add call sidesteps this entirely.
    if (removeRuleIds.length > 0) {
        try {
            await chrome.declarativeNetRequest.updateDynamicRules({
                removeRuleIds
            });
        } catch (e) {
            console.error('pdf_viewer: remove stage failed —', e.message);
            return;
        }
    }
    // Batch add, with per-rule fallback on failure. Keeps one bad rule from
    // poisoning the whole batch (used to happen routinely under regexFilter
    // due to Chromium's 2KB compiled-memory limit; less likely with urlFilter
    // but the fallback is cheap insurance against future validation edges).
    let installed = 0;
    const skipped = [];
    if (addRules.length > 0) {
        try {
            await chrome.declarativeNetRequest.updateDynamicRules({ addRules });
            installed = addRules.length;
        } catch (e) {
            console.warn(
                `pdf_viewer: batch add failed (${e.message}) — falling back to per-rule`
            );
            for (const rule of addRules) {
                try {
                    await chrome.declarativeNetRequest.updateDynamicRules({
                        addRules: [rule]
                    });
                    installed++;
                } catch (err) {
                    skipped.push({
                        id: rule.id,
                        reason: err.message,
                        filter: rule.condition.urlFilter || rule.condition.regexFilter
                    });
                }
            }
        }
    }
    if (skipped.length > 0) {
        console.warn(
            `pdf_viewer: skipped ${skipped.length} over-limit rules:`,
            skipped
        );
    }
    // Remember the set only when it went in whole; a partial install retries
    // on the next sync.
    _appliedRulesKey = skipped.length === 0 ? rulesKey : null;
    console.log(
        `pdf_viewer: synced ${installed}/${addRules.length} rules ` +
        `(${removeRuleIds.length} stale rules removed, ${skipped.length} skipped)`
    );
}

// -----------------------------------------------------------------------------
// Navigation signals — extension-mediated tab navigation.
//
// The open script POSTs {from_url, to_url} to the daemon after a cache-miss
// conversion finishes. This long-poll loop picks up those signals and calls
// chrome.tabs.update(tabId, {url}) on matching tabs.
//
// Why not AppleScript from the open script itself: Chromium's Apple Event
// handler pulls the browser to the front on *any* tab mutation, causing a
// visible focus flash even with snapshot-and-restore tricks. chrome.tabs.update
// has no such side effect.
//
// MV3 service workers die after ~30s of inactivity, but an in-flight fetch
// counts as activity — so while the long-poll holds, the SW stays alive.
// If the SW *does* die between fetches, the periodic alarm (0.5min) wakes
// it up and startNavPollLoop() restarts the loop.
// -----------------------------------------------------------------------------

const NAV_POLL_TIMEOUT_SEC = 25;
const NAV_POLL_ERROR_BACKOFF_MS = 2000;

let _navPollRunning = false;
// Highest signal id seen. The daemon keeps signals for 60 s and gives every
// poller those newer than its cursor, so another browser or profile running
// this extension cannot take a signal meant for a tab here. After a service
// worker restart the cursor is 0 again: recent signals come back, which is
// harmless (a navigated tab no longer has the from_url; a rule sync repeats).
let _navCursor = 0;

async function navigateTab({ from_url, to_url }) {
    try {
        // `chrome.tabs.query({url: matchPattern})` ignores query strings, so
        // we query all tabs and filter by exact-URL match (the from_url the
        // open script captured includes the `_pdfvw=passthrough` marker
        // and must match byte-for-byte).
        const allTabs = await chrome.tabs.query({});
        const matches = allTabs.filter(t => sameUrl(t.url, from_url));
        if (matches.length === 0) {
            console.log(`pdf_viewer: nav signal — no tab with URL ${from_url}`);
            return;
        }
        for (const tab of matches) {
            await chrome.tabs.update(tab.id, { url: to_url });
            console.log(
                `pdf_viewer: navigated tab ${tab.id}: ${from_url} → ${to_url}`
            );
        }
    } catch (e) {
        console.warn('pdf_viewer: navigateTab failed —', e.message);
    }
}

// Fetch signals — the open script's curl download, or the reader's own
// download in the daemon, hit an auth wall (Cloudflare Access, campus SSO)
// because neither has the browser's cookies. Fetch the same URL here, where
// the session lives, and hand the bytes back through the daemon. Only URLs open in one of this browser's tabs
// are fetched, so a signal cannot make the extension read arbitrary pages.
const _handledFetchIds = new Set();

// Resolves true when the daemon still wants this result.
async function putFetchResult(id, body, headers) {
    const resp = await fetch(`${DAEMON}/fetch/${id}`, { method: 'PUT', headers, body });
    if (!resp.ok) return false;
    const answer = await resp.json().catch(() => ({}));
    return answer.accepted !== false;
}

async function fetchSourceForDaemon({ id, url }) {
    if (_handledFetchIds.has(id)) return;
    _handledFetchIds.add(id);
    const tabs = await chrome.tabs.query({});
    if (!tabs.some(t => sameUrl(t.url, url))) {
        console.log(`pdf_viewer: fetch signal — no tab with URL ${url}`);
        return;
    }
    try {
        // After a service-worker restart the signal cursor starts at 0 and
        // recent fetch signals replay. The daemon refuses the acknowledgement
        // for a fetch that is finished, expired or claimed by another browser;
        // skip the download then.
        if (!(await putFetchResult(id, '', { 'X-Fetch-Started': '1' }))) {
            console.log(`pdf_viewer: fetch ${id} no longer pending — skipped`);
            return;
        }
        const resp = await fetch(url, { credentials: 'include', cache: 'no-store' });
        const contentType = resp.headers.get('content-type') || '';
        if (!resp.ok) {
            throw new Error(`browser fetch got HTTP ${resp.status}`);
        }
        const body = await resp.arrayBuffer();
        const magic = new TextDecoder().decode(new Uint8Array(body, 0, Math.min(4, body.byteLength)));
        if (magic !== '%PDF') {
            throw new Error(
                `browser fetch got ${contentType || 'unknown content'}, not a PDF ` +
                `(signed out of ${new URL(url).host}?)`
            );
        }
        await putFetchResult(id, body, {
            'X-Source-Content-Type': contentType,
            'X-Source-Content-Disposition': resp.headers.get('content-disposition') || '',
        });
        console.log(`pdf_viewer: fetched ${body.byteLength} bytes for ${url}`);
    } catch (e) {
        console.warn('pdf_viewer: source fetch failed —', e.message);
        try {
            // Header values must be Latin-1; keep the message printable ASCII.
            const reason = String(e.message).replace(/[^\x20-\x7e]/g, '?');
            await putFetchResult(id, '', { 'X-Fetch-Error': reason || 'fetch failed' });
        } catch (_) {
            // Daemon gone; the script times out and reports that instead.
        }
    }
}

async function handleDaemonSignal(sig) {
    if (sig && sig.type === 'sync_rules') {
        await syncCachedRules();
        return;
    }
    if (sig && sig.type === 'fetch') {
        // Not awaited: a large download must not stall navigation signals.
        fetchSourceForDaemon(sig);
        return;
    }
    await navigateTab(sig || {});
}

async function startNavPollLoop() {
    if (_navPollRunning) return;
    _navPollRunning = true;
    console.log('pdf_viewer: nav poll loop starting');
    try {
        while (true) {
            try {
                // After a failure, a quick health probe turns redirects back
                // on without waiting for a whole long-poll to come back.
                if (_daemonDown) {
                    const health = await fetch(`${DAEMON}/healthz`, { cache: 'no-store' });
                    if (health.ok) await setDaemonDown(false);
                }
                const resp = await fetch(
                    `${DAEMON}/signal/navigate/wait?timeout=${NAV_POLL_TIMEOUT_SEC}&since=${_navCursor}&open=1`,
                    { cache: 'no-store' }
                );
                if (!resp.ok) {
                    console.warn(
                        `pdf_viewer: /signal/navigate/wait → ${resp.status}`
                    );
                    await new Promise(r => setTimeout(r, NAV_POLL_ERROR_BACKOFF_MS));
                    continue;
                }
                setDaemonDown(false);
                const signals = await resp.json();
                for (const sig of signals) {
                    if (typeof sig.id === 'number' && sig.id > _navCursor) _navCursor = sig.id;
                    await handleDaemonSignal(sig);
                }
            } catch (e) {
                // Daemon down / network hiccup. Back off before retry so we
                // don't pin CPU if the daemon is hard-down.
                console.warn('pdf_viewer: nav poll fetch failed —', e.message);
                setDaemonDown(true);
                await new Promise(r => setTimeout(r, NAV_POLL_ERROR_BACKOFF_MS));
            }
        }
    } finally {
        _navPollRunning = false;
    }
}

// -----------------------------------------------------------------------------
// Browser opens — a sign-in-gated PDF goes straight to the reader.
//
// A redirect rule sends the tab to `/view-raw?<url>`. This listener sees that
// request (webRequest, main frame, observe-only) the moment it starts, which
// also wakes a suspended service worker, and asks the daemon whether it wants
// the browser's bytes (`POST /extension/open`). The daemon answers once it
// knows: no when it has the source or downloaded it itself, yes for a host
// that needs the session. Then this worker fetches exactly that URL, the one
// its own tab is navigating to, with the browser's cookies, and uploads the
// bytes; the daemon's held response sends the tab to the reader. A sign-in
// page or other non-PDF answer is reported as an error and the daemon sends
// the tab to the original URL instead. The cookies never leave the browser:
// the daemon sees only the PDF bytes, over 127.0.0.1.
// -----------------------------------------------------------------------------

const PASSTHROUGH = '_pdfvw=passthrough';
const OPEN_ROUTES = new Set(['/view-raw', '/read-raw']);
const MAX_SOURCE_BYTES = 512 * 1024 * 1024;
// The bytes go to the daemon in pieces of about this size as they arrive, so
// the worker never holds a whole large PDF: a service worker buffering a few
// hundred MB was killed mid-upload in Chromium.
const UPLOAD_PIECE_BYTES = 4 * 1024 * 1024;
// Extension API calls reset the service worker's idle timer; a download
// longer than its ~30 s budget would otherwise be cut off.
const KEEPALIVE_MS = 20000;

function stripPassthrough(url) {
    const q = url.indexOf('?');
    if (q < 0) return url;
    const hash = url.indexOf('#', q);
    const query = url.slice(q + 1, hash < 0 ? undefined : hash);
    const kept = query.split('&').filter((item) => item !== PASSTHROUGH);
    const rest = hash < 0 ? '' : url.slice(hash);
    return url.slice(0, q) + (kept.length ? `?${kept.join('&')}` : '') + rest;
}

function withPassthrough(url) {
    const clean = stripPassthrough(url);
    const hash = clean.indexOf('#');
    const base = hash < 0 ? clean : clean.slice(0, hash);
    const frag = hash < 0 ? '' : clean.slice(hash);
    return `${base}${base.includes('?') ? '&' : '?'}${PASSTHROUGH}${frag}`;
}

// The URL a tab was going to before a redirect rule sent it to the daemon.
function originalUrl(daemonUrl) {
    let parsed;
    try {
        parsed = new URL(daemonUrl);
    } catch (_) {
        return null;
    }
    const raw = daemonUrl.slice(daemonUrl.indexOf('?') + 1);
    if (!parsed.search) return null;
    if (OPEN_ROUTES.has(parsed.pathname) || parsed.pathname === '/view-file-raw') {
        return /^(https?|file):\/\//.test(raw) ? raw : null;
    }
    if (parsed.pathname === '/view' || parsed.pathname === '/read') {
        const url = parsed.searchParams.get('url');
        if (url && /^https?:\/\//.test(url)) return url;
        const file = parsed.searchParams.get('path');
        if (file && file.startsWith('/')) {
            return `file://${file.split('/').map(encodeURIComponent).join('/')}`;
        }
    }
    return null;
}

let _activeTransfers = 0;
let _keepalive = null;

function transferStarted() {
    if (_activeTransfers++ === 0) {
        _keepalive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), KEEPALIVE_MS);
    }
}

function transferEnded() {
    if (--_activeTransfers === 0) {
        clearInterval(_keepalive);
        _keepalive = null;
    }
}

// Resolves true when the daemon still wants more of this open.
async function putOpen(id, body, headers, { offset = 0, done = true } = {}) {
    const resp = await fetch(`${DAEMON}/extension/open/${id}?offset=${offset}&done=${done ? 1 : 0}`, {
        method: 'PUT', headers, body,
    });
    if (!resp.ok) return false;
    const answer = await resp.json().catch(() => ({}));
    return answer.accepted !== false;
}

function concatBytes(parts, total) {
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.byteLength;
    }
    return out;
}

const isPdfMagic = (b) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46;

// Stream a fetch response to the daemon in pieces. Throws on a non-PDF.
async function uploadResponse(id, resp) {
    const headers = {
        'X-Source-ETag': resp.headers.get('etag') || '',
        'X-Source-Last-Modified': resp.headers.get('last-modified') || '',
        'X-Source-Content-Type': resp.headers.get('content-type') || '',
        'X-Source-Content-Disposition': resp.headers.get('content-disposition') || '',
    };
    const reader = resp.body.getReader();
    let parts = [];
    let pending = 0;
    let offset = 0;
    let checked = false;
    // One piece uploads while the next is read: at most two in memory.
    let inflight = Promise.resolve(true);
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (value && value.byteLength) {
                parts.push(value);
                pending += value.byteLength;
            }
            if (!checked && (pending >= 4 || done)) {
                const head = concatBytes(parts, pending);
                if (head.byteLength < 4 || !isPdfMagic(head)) {
                    throw new Error(`got ${headers['X-Source-Content-Type'] || 'unknown content'}, not a PDF (signed out?)`);
                }
                checked = true;
            }
            if (offset + pending > MAX_SOURCE_BYTES) throw new Error('source larger than 512 MB');
            if (pending >= UPLOAD_PIECE_BYTES || done) {
                const piece = concatBytes(parts, pending);
                parts = [];
                if (!(await inflight)) throw new Error('the daemon gave up on this open');
                inflight = putOpen(id, piece, headers, { offset, done });
                offset += pending;
                pending = 0;
            }
            if (done) {
                if (!(await inflight)) throw new Error('the daemon gave up on this open');
                return offset;
            }
        }
    } finally {
        reader.cancel().catch(() => {});
    }
}

// `address` is the URL a tab is opening: as page.js reports it (an in-place
// open), or inside a `/view-raw?<url>` navigation to the daemon.
async function openThroughBrowser(address) {
    const target = isDaemonPage(address) ? originalUrl(address) : address;
    if (!target || !/^https?:\/\//.test(target)) return;
    const url = stripPassthrough(target.split('#')[0]);
    let claim;
    try {
        const resp = await fetch(`${DAEMON}/extension/open`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url }),
            cache: 'no-store',
        });
        if (!resp.ok) return;
        claim = await resp.json();
    } catch (e) {
        // Daemon down: the tab's own request fails too; see onErrorOccurred.
        return;
    }
    if (!claim || !claim.fetch) return;
    console.log(`pdf_viewer: daemon wants the browser's bytes for ${url}`);
    transferStarted();
    try {
        const started = Date.now();
        const resp = await fetch(url, { credentials: 'include', cache: 'no-store', headers: claim.headers || {} });
        if (resp.status === 304) {
            if (!(await putOpen(claim.id, '', { 'X-Source-Not-Modified': '1' }))) {
                throw new Error('cached source no longer matches the conditional request');
            }
            return;
        }
        const contentType = resp.headers.get('content-type') || '';
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const length = Number(resp.headers.get('content-length') || 0);
        if (length > MAX_SOURCE_BYTES) throw new Error('source larger than 512 MB');
        const size = await uploadResponse(claim.id, resp);
        console.log(`pdf_viewer: opened ${size} bytes through the browser in ${Date.now() - started} ms`);
    } catch (e) {
        console.warn('pdf_viewer: browser open failed —', e.message);
        try {
            const reason = String(e.message).replace(/[^\x20-\x7e]/g, '?');
            await putOpen(claim.id, '', { 'X-Fetch-Error': reason || 'fetch failed' });
        } catch (_) {
            // Daemon gone; its held request is gone with it.
        }
    } finally {
        transferEnded();
    }
}

// -----------------------------------------------------------------------------
// Daemon down — PDFs open natively instead of on an error page.
//
// While the daemon cannot be reached, a session rule allows every main-frame
// request ahead of all redirect rules (priority above the dynamic ones), so
// no tab is sent to a dead port. A tab that was sent there before the worker
// noticed is put back on the URL it was going to.
// -----------------------------------------------------------------------------

const DAEMON_DOWN_RULE_ID = 900;
let _daemonDown = null;   // unknown after a service-worker start
let _daemonDownUpdate = Promise.resolve();

function setDaemonDown(down) {
    if (_daemonDown === down) return _daemonDownUpdate;
    _daemonDown = down;
    _daemonDownUpdate = _daemonDownUpdate.then(() => chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [DAEMON_DOWN_RULE_ID],
        addRules: down ? [{
            id: DAEMON_DOWN_RULE_ID,
            priority: 100,
            action: { type: 'allow' },
            condition: { resourceTypes: ['main_frame'] },
        }] : [],
    })).then(() => {
        console.log(`pdf_viewer: daemon ${down ? 'unreachable — redirects off' : 'reachable — redirects on'}`);
    }).catch((e) => console.warn('pdf_viewer: daemon-down rule update failed —', e.message));
    return _daemonDownUpdate;
}

// Tab id → time of the last bounce, so a tab is never bounced in a loop.
const _bounced = new Map();
const BOUNCE_COOLDOWN_MS = 10000;

async function bounceFromDeadDaemon(details) {
    const target = originalUrl(details.url);
    if (!target) return;
    const last = _bounced.get(details.tabId) || 0;
    if (Date.now() - last < BOUNCE_COOLDOWN_MS) return;
    _bounced.set(details.tabId, Date.now());
    await setDaemonDown(true);
    try {
        await chrome.tabs.update(details.tabId, {
            url: target.startsWith('file:') ? target : withPassthrough(target),
        });
        console.log(`pdf_viewer: daemon unreachable (${details.error}) — tab ${details.tabId} back to ${target}`);
    } catch (e) {
        console.warn('pdf_viewer: bounce failed —', e.message);
    }
}

const DAEMON_PAGES = { urls: [`${VIEWER}/*`, `${DAEMON}/*`], types: ['main_frame'] };

chrome.webRequest.onBeforeRequest.addListener((details) => {
    let path;
    try {
        path = new URL(details.url).pathname;
    } catch (_) {
        return;
    }
    if (OPEN_ROUTES.has(path)) openThroughBrowser(details.url);
}, DAEMON_PAGES);

chrome.webRequest.onErrorOccurred.addListener((details) => {
    // ERR_ABORTED is the user or a redirect moving on, not a dead daemon.
    if (details.tabId < 0 || /ERR_ABORTED|ERR_BLOCKED/.test(details.error)) return;
    bounceFromDeadDaemon(details);
}, DAEMON_PAGES);

function isDaemonPage(url) {
    return url.startsWith(`${VIEWER}/`) || url.startsWith(`${DAEMON}/`);
}

// -----------------------------------------------------------------------------
// Page script and bridge (page.js, bridge.js).
//
// bridge.html can be framed by any site, so it serves only a page script
// that proved itself here: page.js registers a random token for its tab over
// extension messaging, which no web page can send, and the bridge asks
// whether the token it was handed is that tab's. Tokens live in session
// storage so a restarted worker still knows them.
// -----------------------------------------------------------------------------

const bridgeKey = (tabId) => `bridge:${tabId}`;

// -----------------------------------------------------------------------------
// Own address ⇄ the daemon's address.
//
// A tab that opens `/r/<hash>/` on the daemon (the library, an old link) is
// sent to the document's own URL or file, where page.js builds the same
// reader. The way back: when that address then fails (offline, a redirect to
// a sign-in page), or a cached document's URL fails on a direct visit, the tab
// goes to the daemon's page with `_pdfvw=local`, which page.js leaves alone.
// -----------------------------------------------------------------------------

const LOCAL = '_pdfvw=local';
const MOVE_WATCH_MS = 30000;
// Tab id → { hash, at }: tabs this worker just sent to a document's own address.
const _moved = new Map();

const localReader = (hash) => `${VIEWER}/r/${hash}/?${LOCAL}`;

async function moveToOwnAddress(tabId, hash, page) {
    if (_daemonDown) return false;
    let info;
    try {
        const resp = await fetch(`${DAEMON}/extension/address/${hash}`, { cache: 'no-store' });
        if (!resp.ok) return false;
        info = await resp.json();
    } catch (_) {
        return false;
    }
    if (!info || !info.url || info.disabled) return false;
    if (info.url.startsWith('file:') && !(await chrome.extension.isAllowedFileSchemeAccess())) return false;
    // A document cached a moment ago (the open script) needs its rule first.
    await syncCachedRules();
    _moved.set(tabId, { hash, at: Date.now() });
    await chrome.tabs.update(tabId, { url: info.url.split('#')[0] + (page ? `#page=${page}` : '') });
    return true;
}

// The cached entry a URL belongs to, by host and path, as the dynamic rules
// match it.
async function cachedHashFor(url) {
    let parsed;
    try {
        parsed = new URL(url);
    } catch (_) {
        return null;
    }
    try {
        const resp = await fetch(`${DAEMON}/cache-urls`, { cache: 'no-store' });
        if (!resp.ok) return null;
        const entry = (await resp.json()).find((e) => e.kind === 'url' && !e.disabled
            && e.host === parsed.host && e.path === parsed.pathname);
        return entry ? entry.hash : null;
    } catch (_) {
        return null;
    }
}

async function fallBackToDaemonPage(details, why) {
    if (details.tabId < 0 || isDaemonPage(details.url) || details.url.includes(PASSTHROUGH)) return;
    const moved = _moved.get(details.tabId);
    _moved.delete(details.tabId);
    const hash = moved && Date.now() - moved.at < MOVE_WATCH_MS ? moved.hash : await cachedHashFor(details.url);
    if (!hash) return;
    console.log(`pdf_viewer: ${details.url} ${why} — tab ${details.tabId} reads the stored copy`);
    await chrome.tabs.update(details.tabId, { url: localReader(hash) }).catch(() => {});
}

const WEB_PAGES = { urls: ['http://*/*', 'https://*/*'], types: ['main_frame'] };

chrome.webRequest.onErrorOccurred.addListener((details) => {
    // Only a host that cannot be reached. Everything else is not a reason to
    // leave the address: ERR_ABORTED is page.js stopping the PDF's download, a
    // reload or the user moving on, and other errors come and go with those.
    if (!/ERR_(INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|CONNECTION_\w+|ADDRESS_UNREACHABLE|TIMED_OUT|EMPTY_RESPONSE|NETWORK_CHANGED|PROXY_\w+|TUNNEL_\w+)/.test(details.error)) return;
    fallBackToDaemonPage(details, `failed (${details.error})`);
}, WEB_PAGES);

chrome.webRequest.onBeforeRedirect.addListener((details) => {
    // Only for a tab this worker just moved: the document's address now
    // leads elsewhere (a sign-in page), and the stored copy is what was asked for.
    const moved = _moved.get(details.tabId);
    if (!moved || Date.now() - moved.at > MOVE_WATCH_MS) return;
    fallBackToDaemonPage(details, 'redirects');
}, WEB_PAGES);

chrome.webRequest.onCompleted.addListener((details) => {
    _moved.delete(details.tabId);
}, WEB_PAGES);

async function onPageMessage(message, sender) {
    if (!sender.tab || sender.id !== chrome.runtime.id) return undefined;
    const tabId = sender.tab.id;
    if (message.type === 'pdfv-bridge-token') {
        if (sender.frameId !== 0 || typeof message.token !== 'string' || message.token.length < 32) return false;
        await chrome.storage.session.set({ [bridgeKey(tabId)]: message.token });
        return true;
    }
    if (message.type === 'pdfv-bridge-check') {
        const stored = await chrome.storage.session.get(bridgeKey(tabId));
        return typeof message.token === 'string' && stored[bridgeKey(tabId)] === message.token;
    }
    if (message.type === 'pdfv-browser-open') {
        // Only for the URL the tab itself is on.
        if (typeof message.url === 'string' && sameUrl((sender.tab.url || '').split('#')[0], message.url)) {
            openThroughBrowser(message.url);
        }
        return true;
    }
    if (message.type === 'pdfv-own-address') {
        if (sender.frameId !== 0 || !/^[a-f0-9]{6,32}$/.test(String(message.hash))) return false;
        return moveToOwnAddress(tabId, message.hash, Number(message.page) || 0);
    }
    if (message.type === 'pdfv-navigate') {
        if (sender.frameId !== 0 || typeof message.url !== 'string' || !/^(https?|file):\/\//.test(message.url)) return false;
        if (message.newTab) {
            await chrome.tabs.create({ url: message.url, index: sender.tab.index + 1, openerTabId: tabId });
        } else {
            await chrome.tabs.update(tabId, { url: message.url });
        }
        return true;
    }
    return undefined;
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (!message || typeof message.type !== 'string' || !message.type.startsWith('pdfv-')) return false;
    onPageMessage(message, sender).then(respond, (e) => {
        console.warn('pdf_viewer: page message failed —', e.message);
        respond(false);
    });
    return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
    chrome.storage.session.remove(bridgeKey(tabId)).catch(() => {});
});

async function toggleCurrentPdf(tab) {
    if (!tab || !tab.id || !tab.url) {
        console.warn('pdf_viewer: toolbar toggle missing active tab URL');
        return;
    }

    let body;
    try {
        const resp = await fetch(`${DAEMON}/extension/toggle`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: isDaemonPage(tab.url) ? tab.url : tab.url.split('#')[0] }),
        });
        if (!resp.ok) {
            console.warn(`pdf_viewer: /extension/toggle → ${resp.status}`);
            return;
        }
        body = await resp.json();
    } catch (e) {
        console.warn('pdf_viewer: toolbar toggle failed —', e.message);
        return;
    }

    await syncCachedRules();
    if (body && body.target_url) {
        let target = body.target_url;
        if (body.disabled) {
            // A local PDF's bare address would bring the reader back.
            if (/^file:/.test(target) && !target.includes(PASSTHROUGH)) target = withPassthrough(target);
        } else if (!isDaemonPage(tab.url)) {
            // Re-enabled from the browser's viewer: the reader, in place.
            target = stripPassthrough(tab.url.split('#')[0]);
        }
        await chrome.tabs.update(tab.id, { url: target });
        console.log(
            `pdf_viewer: toolbar toggled ${body.hash} ` +
            `${body.disabled ? 'OFF' : 'ON'}`
        );
    }
}

// Fire on every plausible re-entry point, so new conversions become
// interceptable without a browser restart.
chrome.runtime.onInstalled.addListener(() => {
    syncCachedRules();
    startNavPollLoop();
});
chrome.runtime.onStartup.addListener(() => {
    syncCachedRules();
    startNavPollLoop();
});
chrome.action.onClicked.addListener((tab) => {
    toggleCurrentPdf(tab);
});

chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === SYNC_ALARM) {
        syncCachedRules();
        // Restart the nav loop if it died (SW was suspended and fetch got
        // cancelled). The flag prevents doubling up when it's still alive.
        startNavPollLoop();
    }
});

// Also fire once on service-worker startup (covers the case where the SW
// was terminated and got woken up by an event other than the ones above).
syncCachedRules();
startNavPollLoop();

// Isolated from rule sync and the sign-in relay for easy independent merging.
function reportFileSchemeAccess() {
    chrome.extension.isAllowedFileSchemeAccess((allowed) => {
        fetch(DAEMON + '/extension/file-access', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ allowed }),
        }).catch(() => {});
    });
}
reportFileSchemeAccess();
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === SYNC_ALARM) reportFileSchemeAccess();
});

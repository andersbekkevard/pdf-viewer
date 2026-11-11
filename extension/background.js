// pdf_viewer extension — dynamic rule sync.
//
// The static rules.json handles `.pdf$` URLs. This service worker handles
// everything else: it fetches /cache-urls from the daemon and installs one
// dynamic declarativeNetRequest rule per cached entry so that any URL whose
// host+path matches a cached doc gets intercepted — even signed URLs like
// Blackboard's that don't end in `.pdf`.
//
// Remote redirects target `/view-raw?<original-url>` instead of
// `/view?url=<original-url>` because declarativeNetRequest substitutions are
// not percent-encoded. The daemon reads the raw query string there so signed
// URLs containing `&` stay intact.
//
// Ordering: disabled allow rules use priority 4, active dynamic redirects use
// 3, the passthrough allow uses 2, and the static redirect and the generic
// file rule use 1. Highest priority wins, so:
//   - disabled cached URL click → dynamic allow (p4) → native viewer
//   - cached URL click → dynamic (p3) → /view-raw serves HTML
//   - unknown `.pdf$` URL → static (p1) → /view-raw 307s with marker
//   - 307-target with marker → allow (p2) → native viewer
//   - cache miss on non-.pdf URL → no rule → browser opens natively
//   - uncached `file://….pdf`, reader engine only → generic (p1) →
//     /view-file-raw opens the reader
//
// Service workers in MV3 can be terminated, so we use chrome.alarms (survives
// suspension) rather than setInterval.
//
// Sign-in-gated PDFs (daemon 0.4 protocol, see "Browser opens" below): the
// daemon holds a `/view-raw` navigation it cannot download itself, and this
// worker, which sees the same request through webRequest, fetches the URL
// with the browser's session and uploads the bytes, so the tab goes from the
// link straight to the reader. While the daemon is unreachable a session
// allow rule switches every redirect off, so PDFs open natively instead of
// on a connection error page.

// The service worker talks to the daemon on 127.0.0.1; redirected documents
// open on VIEWER, the origin the static rule, the convert script and the
// Vimium exclusion use, so the viewer's localStorage is not split in two.
const DAEMON = 'http://127.0.0.1:7435';
const VIEWER = 'http://localhost:7435';
const DYNAMIC_RULE_ID_BASE = 1000;
const SYNC_ALARM = 'pdfviewer-sync';

// urlFilter reserves `*`, `^`, `|` as metacharacters. File paths and URL
// paths may legitimately contain `|` (rare) or `^` (rarer), but not
// universally safely — we reject rather than guess. `*` never appears in
// valid URL/file paths we care about.
const URLFILTER_META = /[*^|]/;

// Any local PDF, for the reader engine, which opens files without
// conversion. `/view-file-raw` reads the raw query because the substitution
// cannot percent-encode the capture. Per-entry file rules (p3, p4) win, so a
// disabled entry's allow rule still keeps it native.
const GENERIC_FILE_PRIORITY = 1;
const GENERIC_FILE_REGEX = '^file://.*\\.[Pp][Dd][Ff](?:[?#].*)?$';

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
    let engine;
    try {
        const health = await fetch(`${DAEMON}/healthz`, { cache: 'no-store' });
        setDaemonDown(false);
        if (!health.ok) {
            console.warn(`pdf_viewer: /healthz returned ${health.status}`);
            return;
        }
        // Daemons older than the reader report no engine: pdf2htmlEX.
        engine = (await health.json()).engine || 'pdf2htmlex';
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

    // urlFilter must be ASCII (Chromium requirement). Encoded file paths
    // and host+path URL segments should already be ASCII, but macOS NFD
    // vs NFC unicode forms between Python's JSON and JS can leak non-ASCII
    // through — skip with a warning rather than failing the whole sync.
    const isAscii = (s) => /^[\x00-\x7f]*$/.test(s);

    const addRules = [];
    let ruleIdCounter = DYNAMIC_RULE_ID_BASE;

    if (engine === 'reader') {
        addRules.push({
            id: ruleIdCounter++,
            priority: GENERIC_FILE_PRIORITY,
            action: {
                type: 'redirect',
                redirect: { regexSubstitution: `${VIEWER}/view-file-raw?\\0` }
            },
            condition: {
                regexFilter: GENERIC_FILE_REGEX,
                resourceTypes: ['main_frame']
            }
        });
    }

    for (const entry of entries) {
        let rule;
        if (entry.kind === 'file') {
            // Chromium percent-encodes file:// paths segment-by-segment
            // (spaces → %20, non-ASCII → UTF-8 %XX). Mirror that to match
            // the URL the browser actually navigates to.
            const encodedPath = entry.path
                .split('/')
                .map(encodeURIComponent)
                .join('/');
            // `|` anchors to URL start; trailing `^` matches separator or
            // end-of-URL, so `...pdf`, `...pdf?x=1`, `...pdf#frag` all match.
            const urlFilter = `|file://${encodedPath}^`;

            if (!isAscii(urlFilter) || URLFILTER_META.test(encodedPath)) {
                console.warn(
                    'pdf_viewer: unsafe chars in urlFilter — skipping',
                    entry.path
                );
                continue;
            }
            rule = {
                id: ruleIdCounter++,
                priority: entry.disabled ? 4 : 3,
                action: entry.disabled
                    ? { type: 'allow' }
                    : {
                        type: 'redirect',
                        redirect: {
                            url: `${VIEWER}/view?path=${encodeURIComponent(entry.path)}`
                        }
                    },
                condition: {
                    urlFilter,
                    resourceTypes: ['main_frame']
                }
            };
        } else {
            // URL kind. Preserve the exact navigation URL in the redirect so
            // stale dynamic-rule cache misses still fall back with signed
            // query strings intact.
            const hostPath = entry.host + entry.path;
            const regexFilter = `^https?://${escapeRegex(hostPath)}(?:[?#].*)?$`;
            if (!isAscii(regexFilter)) {
                console.warn(
                    'pdf_viewer: non-ASCII in regex — skipping rule for',
                    hostPath
                );
                continue;
            }
            rule = {
                id: ruleIdCounter++,
                priority: entry.disabled ? 4 : 3,
                action: entry.disabled
                    ? { type: 'allow' }
                    : {
                        type: 'redirect',
                        redirect: {
                            regexSubstitution: `${VIEWER}/view-raw?\\0`
                        }
                    },
                condition: {
                    regexFilter,
                    resourceTypes: ['main_frame'],
                    excludedRequestDomains: ['localhost', '127.0.0.1']
                }
            };
        }
        addRules.push(rule);
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
        `pdf_viewer: synced ${installed}/${addRules.length} rules (engine ${engine}) ` +
        `(${removeRuleIds.length} stale rules removed, ${skipped.length} skipped)`
    );
}

// -----------------------------------------------------------------------------
// Navigation signals — extension-mediated tab navigation.
//
// The convert script POSTs {from_url, to_url} to the daemon after a cache-miss
// conversion finishes. This long-poll loop picks up those signals and calls
// chrome.tabs.update(tabId, {url}) on matching tabs.
//
// Why not AppleScript from the convert script itself: Chromium's Apple Event
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
        // convert script captured includes the `_pdfvw=passthrough` marker
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

// Fetch signals — the convert script's curl download, or the reader's own
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

async function putOpen(id, body, headers) {
    await fetch(`${DAEMON}/extension/open/${id}`, { method: 'PUT', headers, body });
}

async function openThroughBrowser(daemonUrl) {
    const target = originalUrl(daemonUrl);
    if (!target || !/^https?:\/\//.test(target)) return;
    const url = stripPassthrough(target);
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
    transferStarted();
    try {
        const started = Date.now();
        const resp = await fetch(url, { credentials: 'include', cache: 'no-store' });
        const contentType = resp.headers.get('content-type') || '';
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const length = Number(resp.headers.get('content-length') || 0);
        if (length > MAX_SOURCE_BYTES) throw new Error('source larger than 512 MB');
        const body = await resp.arrayBuffer();
        const magic = new TextDecoder().decode(new Uint8Array(body, 0, Math.min(4, body.byteLength)));
        if (magic !== '%PDF') {
            throw new Error(`got ${contentType || 'unknown content'}, not a PDF (signed out?)`);
        }
        await putOpen(claim.id, body, {
            'X-Source-Content-Type': contentType,
            'X-Source-Content-Disposition': resp.headers.get('content-disposition') || '',
        });
        console.log(`pdf_viewer: opened ${body.byteLength} bytes through the browser in ${Date.now() - started} ms`);
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
            body: JSON.stringify({ url: tab.url }),
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
        await chrome.tabs.update(tab.id, { url: body.target_url });
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

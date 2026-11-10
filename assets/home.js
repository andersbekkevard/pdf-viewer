// Home page (GET /): the library from /library, searchable and keyboard-driven.
// Keys outside the search field are limited to / ↑ ↓ Ctrl-j Ctrl-k Enter so
// Vimium keeps its own (docs/keybindings.md, "Permanently rejected").

const input = document.getElementById('q');
const sortSelect = document.getElementById('sort');
const list = document.getElementById('rows');
const stateLine = document.getElementById('state');
const countLine = document.getElementById('count');
const status = document.getElementById('status');

let entries = [];        // /library rows, in /library order
let rowsByHash = new Map();
let items = [];          // selectable <li> rows currently shown, top to bottom
let selected = 0;
let loaded = false;

// ---- search (same rule as overlay-library.js `matches`) ----
function normalize(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
function searchText(entry) {
    const base = entry.search_text
        ? normalize(entry.search_text)
        : normalize([entry.name, entry.source_ref].filter(Boolean).join(' '));
    return normalize([base, entry.title, entry.author].filter(Boolean).join(' '));
}
function matches(entry, query) {
    const q = normalize(query);
    if (!q) return true;
    return q.split(' ').every((token) => entry._text.indexOf(token) !== -1);
}

// A pasted http(s) URL or absolute/~ path opens through /read.
function openTarget(raw) {
    let value = String(raw || '').trim().replace(/^(['"])(.*)\1$/, '$2');
    if (/^https?:\/\/\S+$/i.test(value)) return { kind: 'url', value, href: '/read?url=' + encodeURIComponent(value) };
    if (/^file:\/\/\S+$/i.test(value)) {
        try { value = decodeURIComponent(new URL(value).pathname); } catch (_) { return null; }
    }
    if (/^(\/|~\/)\S/.test(value) || value === '~') {
        value = value.replace(/\\ /g, ' ');
        return { kind: 'path', value, href: '/read?path=' + encodeURIComponent(value) };
    }
    return null;
}

// ---- formatting ----
function sourceShort(ref) {
    if (!ref) return '';
    if (/^https?:\/\//i.test(ref)) {
        try { return new URL(ref).host.replace(/^www\./, ''); } catch (_) { return ref; }
    }
    const parts = ref.split('/').filter(Boolean);
    return parts.length > 1 ? parts[parts.length - 2] : '/';
}
function ago(lastSeen) {
    if (!lastSeen) return 'not opened';
    const sec = Date.now() / 1000 - lastSeen;
    if (sec < 60) return 'just now';
    if (sec < 3600) return Math.round(sec / 60) + ' min ago';
    if (sec < 86400) return Math.round(sec / 3600) + ' h ago';
    const days = Math.round(sec / 86400);
    if (days === 1) return 'yesterday';
    if (days < 30) return days + ' days ago';
    return new Date(lastSeen * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
}

// ---- thumbnails: only rows near the viewport get an <img> ----
const thumbs = 'IntersectionObserver' in window ? new IntersectionObserver((seen) => {
    for (const record of seen) {
        if (!record.isIntersecting) continue;
        loadThumb(record.target);
        thumbs.unobserve(record.target);
    }
}, { rootMargin: '300px 0px' }) : null;

function loadThumb(box) {
    const src = box.dataset.src;
    if (!src || box.firstChild) return;
    const img = new Image();
    img.alt = '';
    img.decoding = 'async';
    img.onerror = () => { img.remove(); box.textContent = 'PDF'; };
    img.src = src;
    box.appendChild(img);
}

// ---- rows ----
function buildRow(entry, index) {
    const li = el('li', 'row');
    li.dataset.hash = entry.hash;

    const link = el('a', 'link');
    link.href = entry.href;
    link.id = 'doc-' + index;
    const box = el('span', 'thumb');
    box.setAttribute('aria-hidden', 'true');
    if (entry.thumb_href) {
        box.dataset.src = entry.thumb_href;
        if (thumbs) thumbs.observe(box); else loadThumb(box);
    } else {
        box.textContent = 'PDF';
    }
    const text = el('span', 'text');
    text.appendChild(el('span', 'name', entry.name || entry.hash));
    const sub = el('span', 'sub');
    const bits = [];
    const titleLine = [entry.title, entry.author].filter(Boolean).join(' — ');
    if (titleLine && normalize(entry.title) !== normalize(entry.name)) bits.push(titleLine);
    else if (entry.author) bits.push(entry.author);
    if (entry.source_ref) bits.push(sourceShort(entry.source_ref));
    if (entry.pages) bits.push(entry.pages + (entry.pages === 1 ? ' page' : ' pages'));
    bits.forEach((bit, i) => {
        if (i) sub.appendChild(el('span', 'sep', '·'));
        sub.appendChild(document.createTextNode(bit));
    });
    if (entry.source_ref) sub.title = entry.source_ref;
    text.appendChild(sub);
    const meta = el('span', 'meta', ago(entry.last_seen));
    if (entry.count) meta.appendChild(el('span', 'opens', 'opened ' + entry.count + '×'));
    link.append(box, text, meta);

    const actions = el('span', 'actions');
    if (entry.source_ref) {
        const copy = el('button', 'act', /^https?:/i.test(entry.source_ref) ? 'Copy URL' : 'Copy path');
        copy.type = 'button';
        copy.setAttribute('aria-label', copy.textContent + ' of ' + (entry.name || entry.hash));
        copy.addEventListener('click', () => copySource(entry.source_ref, copy));
        actions.appendChild(copy);
    }
    const original = el('a', 'act', 'Original');
    original.href = '/native?hash=' + encodeURIComponent(entry.hash);
    original.setAttribute('aria-label', 'Open the original PDF of ' + (entry.name || entry.hash));
    actions.appendChild(original);

    li.append(link, actions);
    return li;
}

function buildOpenRow(target) {
    const li = el('li', 'row open-row');
    const link = el('a', 'link');
    link.href = target.href;
    link.id = 'open-target';
    const box = el('span', 'thumb', '↗');
    box.setAttribute('aria-hidden', 'true');
    const text = el('span', 'text');
    text.appendChild(el('span', 'name', 'Open ' + target.value + ' in the reader'));
    text.appendChild(el('span', 'sub', target.kind === 'url' ? 'Not in the library · download and read' : 'Not in the library · read from disk'));
    link.append(box, text, el('span', 'meta', ''));
    li.appendChild(link);
    return li;
}

async function copySource(text, button) {
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch (_) {
        const area = el('textarea');
        area.value = text;
        area.style.position = 'fixed'; area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        try { ok = document.execCommand('copy'); } catch (_) {}
        area.remove();
    }
    const label = button.textContent;
    button.textContent = ok ? 'Copied' : 'Copy failed';
    status.textContent = ok ? 'Copied ' + text : 'Could not copy';
    setTimeout(() => { button.textContent = label; }, 1200);
}

function sorted() {
    const mode = sortSelect.value;
    if (mode === 'recent') return entries.slice().sort((a, b) => (b.last_seen || 0) - (a.last_seen || 0));
    if (mode === 'name') return entries.slice().sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true, sensitivity: 'base' }));
    return entries;
}

function render() {
    const query = input.value;
    const target = openTarget(query);
    const shown = [];
    const fragment = document.createDocumentFragment();
    const previous = list.querySelector('.open-row');
    if (previous) previous.remove();
    if (target) {
        const openRow = buildOpenRow(target);
        fragment.appendChild(openRow);
        shown.push(openRow);
    }
    for (const entry of sorted()) {
        const row = rowsByHash.get(entry.hash);
        const hit = matches(entry, query);
        row.hidden = !hit;
        fragment.appendChild(row);
        if (hit) shown.push(row);
    }
    list.appendChild(fragment);
    items = shown;

    const hits = shown.length - (target ? 1 : 0);
    countLine.textContent = !loaded ? '' : normalize(query)
        ? hits + ' of ' + entries.length
        : entries.length + (entries.length === 1 ? ' document' : ' documents');
    if (loaded && !entries.length && !target) {
        showState('No documents yet. Paste a PDF URL or path above, or open any PDF link in the browser.');
    } else if (loaded && !hits && !target) {
        showState('Nothing matches “' + query.trim() + '”.');
    } else {
        showState('');
    }
    select(0, false);
}

function showState(text) {
    stateLine.textContent = text;
    stateLine.hidden = !text;
}

function select(index, focusRow) {
    for (const row of list.querySelectorAll('.row.selected')) {
        row.classList.remove('selected');
        row.querySelector('.link').removeAttribute('aria-current');
    }
    if (!items.length) { selected = 0; return; }
    selected = Math.max(0, Math.min(items.length - 1, index));
    const row = items[selected];
    row.classList.add('selected');
    const link = row.querySelector('.link');
    link.setAttribute('aria-current', 'true');
    if (focusRow) link.focus({ preventScroll: true });
    if (index !== 0 || focusRow) row.scrollIntoView({ block: 'nearest' });
    else window.scrollTo(0, 0);
}

function openSelected(newTab) {
    const row = items[selected];
    if (!row) return;
    const href = row.querySelector('.link').href;
    if (newTab) window.open(href, '_blank', 'noopener');
    else location.href = href;
}

// ---- keyboard ----
function direction(event) {
    if (event.altKey || event.metaKey) return 0;
    if (!event.ctrlKey && !event.shiftKey) {
        if (event.key === 'ArrowDown') return 1;
        if (event.key === 'ArrowUp') return -1;
    }
    if (event.ctrlKey && !event.shiftKey) {
        if (event.key === 'j') return 1;
        if (event.key === 'k') return -1;
    }
    return 0;
}

input.addEventListener('keydown', (event) => {
    const step = direction(event);
    if (step) { event.preventDefault(); select(selected + step, false); return; }
    if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault();
        openSelected(event.metaKey || event.ctrlKey);
    } else if (event.key === 'Escape') {
        event.preventDefault();
        if (input.value) { input.value = ''; render(); } else input.blur();
    }
});
input.addEventListener('input', render);
document.getElementById('search-form').addEventListener('submit', (event) => event.preventDefault());
sortSelect.addEventListener('change', render);

document.addEventListener('keydown', (event) => {
    const t = event.target;
    if (t === input || (t && t.closest && t.closest('input, select, textarea, [contenteditable]'))) return;
    if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        input.focus();
        input.select();
        return;
    }
    const step = direction(event);
    if (step) {
        event.preventDefault();
        const inRow = t && t.closest && t.closest('.row');
        const from = inRow && items.indexOf(inRow) !== -1 ? items.indexOf(inRow) : selected;
        select(from + step, true);
        return;
    }
    // Enter on a focused link follows it natively (⌘/Ctrl/middle-click too).
    if (event.key === 'Enter' && (!t || t === document.body)) {
        event.preventDefault();
        openSelected(event.metaKey || event.ctrlKey);
    }
});

// Keep the selection on the row that has focus (Tab, Vimium hints).
list.addEventListener('focusin', (event) => {
    const row = event.target.closest('.row');
    const index = items.indexOf(row);
    if (index !== -1 && index !== selected) select(index, false);
});

// ---- data ----
function headHeight() {
    document.documentElement.style.setProperty('--head-h', document.querySelector('.head').offsetHeight + 'px');
}

async function load() {
    let data;
    try {
        const response = await fetch('/library', { cache: 'no-store' });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        data = await response.json();
    } catch (error) {
        loaded = true;
        entries = [];
        rowsByHash = new Map();
        list.replaceChildren();
        render();
        showState('Could not load the library (' + error.message + '). Is the daemon running?');
        return;
    }
    entries = Array.isArray(data) ? data : [];
    entries.forEach((entry) => { entry._text = searchText(entry); });
    rowsByHash = new Map();
    list.replaceChildren();
    entries.forEach((entry, i) => rowsByHash.set(entry.hash, buildRow(entry, i)));
    loaded = true;
    render();
}

headHeight();
window.addEventListener('resize', headHeight);
// Back from a document (bfcache): refresh last-opened times and counts.
window.addEventListener('pageshow', (event) => { if (event.persisted) load(); });
input.focus();
load();

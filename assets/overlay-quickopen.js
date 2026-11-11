// Quick open: one panel that answers three questions.
//
//   ⌘O  where in this document   sections (or pages), marks, a page number
//   ⌘P  which document           the previous document first, then frecency
//   ⌘K  anything                 all of the above plus commands, one ranking
//
// One component with one row grammar (marker, primary text, muted secondary
// text, right-aligned hint) and one keyboard model. Pressing the open key
// again closes the panel; pressing another of the three switches it in place.
//
// Rows that point into this document preview their target in the document
// behind the panel without recording history. Esc, a click outside or focus
// leaving the field puts the reader back exactly where they were; Enter
// returns there first and then makes the jump, so it is recorded once and
// ⌘Z undoes it.
import { escapeHtml, removeOverlay } from './overlay-dom.js';
import { prepare, parseQuery, matchAny, highlight } from './overlay-matcher.js';

var ICON = {
    section: '<path d="M4 6h16M4 12h16M4 18h10"/>',
    page: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>',
    doc: '<rect x="3" y="5" width="4" height="14"/><rect x="9" y="3" width="4" height="16"/><path d="M15 7l3.5-1 3 11-3.5 1z"/>',
    cmd: '<path d="M5 8l4 4-4 4M12 16h7"/>',
    find: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
    back: '<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
};
function icon(name) {
    return '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" '
        + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICON[name] + '</svg>';
}

var MODES = {
    sections: { key: 'O', chip: 'This document', placeholder: 'Section title or page number' },
    documents: { key: 'P', chip: 'Documents', placeholder: 'Title, author or file name' },
    all: { key: 'K', chip: '', placeholder: 'Sections, documents, commands · @ sections  # pages  > commands' },
};
var NARROW = { '@': { scope: 'sections', chip: 'Sections' }, '#': { scope: 'pages', chip: 'Pages' },
    '>': { scope: 'commands', chip: 'Commands' } };
var SWITCH_LABEL = { sections: 'Sections', documents: 'Documents', all: 'Everything' };
// Rows rendered for a filtered list; nobody reads past this.
var MAX_RESULTS = 200;
var PREVIEW_GAP = 16;
// Row and heading heights in px, as in overlay.css; the list is windowed.
var ROW_H = 34;
var HEAD_H = 28;
var OVERSCAN = 240;

export function createQuickOpen(core) {
    var document = core.document;
    var window = core.window;
    var location = core.location;
    var navigation = core.navigation;
    var documentModel = core.documentModel;
    var library = core.library;
    var notify = core.notify || function () {};

    var panel = null;

    // ------------------------------------------------------------ the sources
    // Built once per document (sections, pages) or per library load (docs);
    // every target is prepared once, never per keystroke.
    var sectionCache = null;
    function sections() {
        if (sectionCache) return sectionCache;
        var entries = navigation.entries();
        var root = document.getElementById('outline');
        sectionCache = entries.map(function (entry) {
            var depth = 0, parents = [];
            var li = entry.link && entry.link.closest ? entry.link.closest('li') : null;
            var up = li && li.parentElement ? li.parentElement.closest('li') : null;
            while (up && root && root.contains(up)) {
                depth++;
                var a = up.querySelector(':scope > a');
                if (a) parents.unshift((a.textContent || '').replace(/\s+/g, ' ').trim());
                up = up.parentElement ? up.parentElement.closest('li') : null;
            }
            return { entry: entry, depth: depth, path: parents.join(' › '),
                title: prepare(entry.label), pathTarget: parents.length ? prepare(parents.join(' ')) : null };
        });
        return sectionCache;
    }
    function currentSectionIndex() {
        var entry = navigation.chapter() || navigation.chapterAt(navigation.page());
        return entry ? entry.index : -1;
    }

    var pageCache = null;
    function firstLine(n) {
        var pc = documentModel.pageContent(n);
        if (!pc) return '';
        var lines = pc.querySelectorAll('.t');
        for (var i = 0; i < lines.length && i < 6; i++) {
            var t = (lines[i].textContent || '').replace(/\s+/g, ' ').trim();
            if (t.length > 1) return t.length > 120 ? t.slice(0, 120) : t;
        }
        return '';
    }
    function pages() {
        // Reader text arrives in ranges; rebuild until every page has its line.
        if (pageCache && pageCache.complete) return pageCache.items;
        var total = documentModel.totalPages(), items = [];
        var complete = document.documentElement.getAttribute('data-reader-text') !== 'loading';
        for (var n = 1; n <= total; n++) {
            var line = firstLine(n);
            items.push({ page: n, line: line, target: line ? prepare(line) : null });
        }
        pageCache = { items: items, complete: complete };
        return items;
    }
    function pageValid(n) { return n >= 1 && !!documentModel.page(n); }

    function marks() {
        var all = navigation.marks();
        return Object.keys(all).sort().map(function (letter) {
            var m = all[letter];
            return { letter: letter, page: m.page, label: m.label || '',
                target: prepare(letter + ' ' + (m.label || '')) };
        });
    }

    var docCache = { rows: null, items: [] };
    function docs() {
        var rows = library.all();
        if (docCache.rows === rows) return docCache.items;
        docCache = { rows: rows, items: rows.filter(function (e) { return !library.isCurrent(e); }).map(function (e, i) {
            var title = String(e.title || e.name || '').trim() || '(untitled)';
            var secondary = e.author || e.host || (e.file && e.file.replace(/\.pdf$/i, '') !== title ? e.file : '');
            return { entry: e, order: i, title: prepare(title), secondary: secondary ? prepare(secondary) : null,
                file: e.file ? prepare(e.file) : null, source: prepare(e.host || e.source_ref || '') };
        }) };
        return docCache.items;
    }

    function commands() {
        return core.commands().map(function (c, i) {
            return { command: c, order: i, name: prepare(':' + c.name), alias: c.aliases[0] || '',
                aliasTarget: c.aliases.length ? prepare(c.aliases.join(' ')) : null,
                desc: typeof c.desc === 'function' ? c.desc() : (c.desc || '') };
        });
    }

    // ------------------------------------------------------------------- rows
    // A row: {kind, key, marker, primary (prepared), hits, secondary, hint,
    // depth, place (where it previews), commit(alt), alt (label or '')}.
    function relTime(sec) {
        if (!sec) return '';
        var age = Date.now() / 1000 - sec;
        if (age < 90) return 'now';
        if (age < 3600) return Math.round(age / 60) + ' min ago';
        if (age < 86400) return Math.round(age / 3600) + ' h ago';
        if (age < 2 * 86400) return 'yesterday';
        if (age < 14 * 86400) return Math.round(age / 86400) + ' days ago';
        if (age < 60 * 86400) return Math.round(age / (7 * 86400)) + ' weeks ago';
        return Math.round(age / (30 * 86400)) + ' months ago';
    }
    function newTabHref(page) {
        return location.pathname + location.search + '#pf' + page.toString(16);
    }

    function sectionRow(item, hit, opts) {
        var e = item.entry;
        var here = e.index === currentSectionIndex();
        return { kind: 'section', key: 's' + e.index, primary: item.title, hits: hit && hit.positions[0],
            secondary: opts.flat ? item.path : '', depth: opts.flat ? 0 : item.depth,
            marker: opts.mixed ? icon('section') : (here ? '<span class="here" title="You are here"></span>' : ''),
            hint: 'p. ' + e.page, place: { page: e.page, point: e.point }, alt: 'New tab',
            commit: function (alt) {
                if (alt) return window.open(newTabHref(e.page), '_blank');
                navigation.gotoEntry(e);
            } };
    }
    function pageRow(item, hit, mixed) {
        return { kind: 'page', key: 'p' + item.page, primary: item.target || prepare('Page ' + item.page),
            hits: hit && hit.positions[0], secondary: '', marker: mixed ? icon('page') : '',
            hint: 'p. ' + item.page, place: { page: item.page }, alt: 'New tab',
            commit: function (alt) { goPage(item.page, alt); } };
    }
    function gotoPageRow(n) {
        return { kind: 'goto', key: 'g' + n, primary: prepare('Go to page ' + n), secondary: '',
            marker: icon('page'), hint: 'of ' + documentModel.totalPages(), place: { page: n }, alt: 'New tab',
            commit: function (alt) { goPage(n, alt); } };
    }
    function goPage(n, alt) {
        if (alt) return window.open(newTabHref(n), '_blank');
        navigation.gotoPage(n, false);
    }
    function markRow(item, hit) {
        return { kind: 'mark', key: 'm' + item.letter, primary: prepare(item.label || 'Page ' + item.page),
            hits: null, secondary: '', marker: '<span class="letter">' + escapeHtml(item.letter) + '</span>',
            hint: 'p. ' + item.page, place: { page: item.page }, alt: 'New tab',
            commit: function (alt) {
                if (alt) return window.open(newTabHref(item.page), '_blank');
                navigation.gotoMark(item.letter);
            } };
    }
    // Pins (overlay-pins.js): numbered return points of this document.
    function pinItems() { return core.pins ? core.pins.list() : []; }
    function pinRow(pin) {
        return { kind: 'mark', key: 'pin' + pin.number, primary: prepare(pin.title || 'Page ' + pin.page),
            hits: null, secondary: pin.section || '', marker: '<span class="letter">' + pin.number + '</span>',
            hint: 'p. ' + pin.page, place: { page: pin.page }, alt: 'New tab',
            commit: function (alt) {
                if (alt) return window.open(newTabHref(pin.page), '_blank');
                core.pins.jump(pin.number);
            } };
    }
    function docRow(item, hit, mixed) {
        var e = item.entry;
        var bits = [];
        if (e.page > 1 && e.pages) bits.push('p. ' + e.page + ' of ' + e.pages);
        else if (e.page > 1) bits.push('p. ' + e.page);
        else if (e.pages) bits.push(e.pages + (e.pages === 1 ? ' page' : ' pages'));
        var when = relTime(e.last_read || e.last_seen);
        if (when) bits.push(when);
        return { kind: 'doc', key: 'd' + e.hash, primary: item.title, hits: hit && hit.positions[0],
            secondary: item.secondary, secondaryHits: hit && hit.positions[1],
            marker: mixed ? icon('doc') : (e.previous ? icon('back') : ''),
            hint: bits.join(' · '), alt: 'New tab',
            commit: function (alt) {
                if (!e.href) return;
                if (alt) return window.open(e.href, '_blank');
                location.href = e.href;
            } };
    }
    function commandRow(item, hit) {
        return { kind: 'cmd', key: 'c' + item.command.name, primary: item.name, hits: hit && hit.positions[0],
            secondary: item.desc, marker: icon('cmd'), hint: item.alias ? ':' + item.alias : '', alt: '',
            commit: function (alt, selection) { core.runCommand(item.command, selection); } };
    }
    function findRow(text) {
        return { kind: 'find', key: 'find', primary: prepare('Find “' + text + '” in this document'),
            secondary: '', marker: icon('find'), hint: '/', alt: '',
            commit: function () { if (core.find) core.find(text); } };
    }
    function heading(label) { return { heading: label }; }

    // ------------------------------------------------------------- the lists
    function ranked(list, tokens, fieldsOf, rowOf, prior) {
        var out = [];
        for (var i = 0; i < list.length; i++) {
            var hit = matchAny(tokens, fieldsOf(list[i]));
            if (hit) out.push({ score: hit.score + (prior ? prior(list[i]) : 0), i: i, row: rowOf(list[i], hit) });
        }
        out.sort(function (a, b) { return b.score - a.score || a.i - b.i; });
        return out;
    }
    function sectionFields(item) {
        return [{ target: item.title, penalty: 0 }, { target: item.pathTarget, penalty: 0.4 }];
    }
    function docFields(item) {
        return [{ target: item.title, penalty: 0 }, { target: item.secondary, penalty: 0.2 },
            { target: item.file, penalty: 0.3 }, { target: item.source, penalty: 0.5 }];
    }
    function docPrior(item) { return Math.min(0.5, 0.15 * Math.log1p(item.entry.score || 0)); }
    function commandFields(item) {
        return [{ target: item.name, penalty: 0 }, { target: item.aliasTarget, penalty: 0.1 }];
    }
    function digitsOf(q) {
        var m = /^\s*#?\s*(\d{1,6})\s*$/.exec(q);
        return m ? parseInt(m[1], 10) : 0;
    }

    // Each list returns {rows, select} where `select` is the key to select.
    function sectionsList(q) {
        var items = sections(), tokens = parseQuery(q), rows = [], n = digitsOf(q);
        var markItems = marks(), pinned = pinItems();
        if (!tokens.length) {
            if (pinned.length) {
                rows.push(heading('Pins'));
                pinned.forEach(function (pin) { rows.push(pinRow(pin)); });
            }
            if (markItems.length) {
                rows.push(heading('Marks'));
                markItems.forEach(function (m) { rows.push(markRow(m)); });
            }
            var current = currentSectionIndex();
            if (items.length) {
                if (markItems.length || pinned.length) rows.push(heading('Sections'));
                items.forEach(function (item) { rows.push(sectionRow(item, null, {})); });
                return { rows: rows, select: current >= 0 ? 's' + current : 's0', center: true };
            }
            if (markItems.length || pinned.length) rows.push(heading('Pages'));
            pages().forEach(function (item) { rows.push(pageRow(item, null, false)); });
            return { rows: rows, select: 'p' + navigation.page(), center: true };
        }
        if (n && pageValid(n)) rows.push(gotoPageRow(n));
        markItems.forEach(function (m) {
            if (tokens.length === 1 && tokens[0] === m.letter) rows.push(markRow(m));
        });
        var needle = q.trim().toLowerCase();
        pinned.forEach(function (pin) {
            if (needle && String(pin.title || '').toLowerCase().indexOf(needle) !== -1) rows.push(pinRow(pin));
        });
        var found = items.length
            ? ranked(items, tokens, sectionFields, function (item, hit) { return sectionRow(item, hit, { flat: true }); })
            : ranked(pages().filter(function (p) { return p.target; }), tokens,
                function (p) { return [{ target: p.target, penalty: 0 }]; },
                function (p, hit) { return pageRow(p, hit, false); });
        found.slice(0, MAX_RESULTS).forEach(function (r) { rows.push(r.row); });
        if (!n && !found.length) rows.push(findRow(q.trim()));
        return { rows: rows, empty: n ? noPage(n) : '' };
    }
    function noPage(n) {
        var total = documentModel.totalPages();
        return total ? 'No page ' + n + '. This document has ' + total + (total === 1 ? ' page.' : ' pages.')
            : 'This document has no pages to go to.';
    }
    function pagesList(q) {
        var tokens = parseQuery(q.replace(/^\s*#/, '')), n = digitsOf(q), rows = [];
        if (n) {
            if (pageValid(n)) rows.push(gotoPageRow(n));
            return { rows: rows, empty: noPage(n) };
        }
        if (!tokens.length) {
            pages().forEach(function (item) { rows.push(pageRow(item, null, false)); });
            return { rows: rows, select: 'p' + navigation.page(), center: true };
        }
        ranked(pages().filter(function (p) { return p.target; }), tokens,
            function (p) { return [{ target: p.target, penalty: 0 }]; },
            function (p, hit) { return pageRow(p, hit, false); })
            .slice(0, MAX_RESULTS).forEach(function (r) { rows.push(r.row); });
        return { rows: rows, empty: 'No page starts with “' + q.replace(/^\s*#/, '').trim() + '”' };
    }
    function documentsList(q) {
        var items = docs(), tokens = parseQuery(q), rows = [];
        if (!library.loaded()) return { rows: [], empty: 'Loading documents…' };
        if (!items.length) return { rows: [], empty: 'No other documents yet. Documents you open appear here.' };
        if (!tokens.length) {
            var previous = items.filter(function (d) { return d.entry.previous; })[0];
            if (previous) {
                rows.push(heading('Previous'));
                rows.push(docRow(previous, null, false));
                rows.push(heading('Recent and frequent'));
            }
            items.forEach(function (d) { if (d !== previous) rows.push(docRow(d, null, false)); });
            return { rows: rows };
        }
        ranked(items, tokens, docFields, function (d, hit) { return docRow(d, hit, false); }, docPrior)
            .slice(0, MAX_RESULTS).forEach(function (r) { rows.push(r.row); });
        return { rows: rows, empty: 'No document matches “' + q.trim() + '”' };
    }
    function commandsList(q) {
        var tokens = parseQuery(q), rows = [];
        if (!tokens.length) {
            commands().forEach(function (c) { rows.push(commandRow(c)); });
            return { rows: rows };
        }
        ranked(commands(), tokens, commandFields, commandRow)
            .forEach(function (r) { rows.push(r.row); });
        return { rows: rows, empty: 'No command matches “' + q.trim() + '”' };
    }
    function allList(q) {
        var tokens = parseQuery(q), rows = [], n = digitsOf(q);
        if (!tokens.length) {
            var items = docs();
            var previous = items.filter(function (d) { return d.entry.previous; })[0];
            if (previous) { rows.push(heading('Previous document')); rows.push(docRow(previous, null, true)); }
            var list = sections(), current = currentSectionIndex();
            var next = list.slice(current + 1, current + 4);
            if (next.length) {
                rows.push(heading('Next in this document'));
                next.forEach(function (item) { rows.push(sectionRow(item, null, { flat: true, mixed: true })); });
            }
            var recent = items.filter(function (d) { return d !== previous; })
                .sort(function (a, b) { return (b.entry.last_read || 0) - (a.entry.last_read || 0); }).slice(0, 4);
            if (recent.length) {
                rows.push(heading('Recent documents'));
                recent.forEach(function (d) { rows.push(docRow(d, null, true)); });
            }
            rows.push(heading('Commands'));
            commands().forEach(function (c) { rows.push(commandRow(c)); });
            return { rows: rows };
        }
        var merged = [];
        var secs = ranked(sections(), tokens, sectionFields,
            function (item, hit) { return sectionRow(item, hit, { flat: true, mixed: true }); });
        merged = merged.concat(secs);
        merged = merged.concat(ranked(docs(), tokens, docFields,
            function (d, hit) { return docRow(d, hit, true); }, docPrior));
        merged = merged.concat(ranked(commands(), tokens, commandFields, commandRow,
            function () { return -0.2; }));
        merged.sort(function (a, b) { return b.score - a.score; });
        if (n && pageValid(n)) rows.push(gotoPageRow(n));
        merged.slice(0, MAX_RESULTS).forEach(function (r) { rows.push(r.row); });
        if (!n && !secs.length) rows.push(findRow(q.trim()));
        return { rows: rows, empty: n ? noPage(n) : '' };
    }

    // The scope a query lands in: the panel's own, or a prefix in ⌘K.
    function scopeOf(mode, value) {
        if (mode !== 'all') return { scope: mode, query: value, chip: MODES[mode].chip };
        var c = value.charAt(0);
        if (NARROW[c]) return { scope: NARROW[c].scope, query: value.slice(1), chip: NARROW[c].chip };
        return { scope: 'all', query: value, chip: '' };
    }
    function listFor(scope, q) {
        if (scope === 'sections') return sectionsList(q);
        if (scope === 'documents') return documentsList(q);
        if (scope === 'pages') return pagesList(q);
        if (scope === 'commands') return commandsList(q);
        return allList(q);
    }

    // ----------------------------------------------------------------- preview
    function container() { return documentModel.container(); }
    function returnToOrigin() {
        if (!panel || !panel.previewed) return;
        var root = container();
        if (!root) return;
        navigation.quiet();
        root.scrollTop = panel.origin.top;
        root.scrollLeft = panel.origin.left;
        panel.previewed = false;
    }
    // Show a target just below the panel, so the dimmed document behind it
    // shows the heading and what follows. Enter lands it the usual way.
    // Preview follows the selection: a row without a place in this document
    // (a document, a command, nothing) shows where the reader was.
    function preview(row) {
        if (!panel) return;
        var root = container();
        var pf = row && row.place ? documentModel.page(row.place.page) : null;
        if (!root || !pf) { returnToOrigin(); renderFoot(); return; }
        var box = panel.box.getBoundingClientRect(), rootBox = root.getBoundingClientRect();
        var lead = Math.min(root.clientHeight * 0.6, Math.max(0, box.bottom - rootBox.top + PREVIEW_GAP));
        navigation.quiet();
        panel.previewed = true;
        var point = row.place.point;
        if (!(point && documentModel.scrollToPagePoint(pf, point.y, lead))) documentModel.scrollToPage(pf, lead, false);
        renderFoot();
    }
    function schedulePreview() {
        if (!panel || panel.previewFrame) return;
        panel.previewFrame = window.requestAnimationFrame(function () {
            if (!panel) return;
            panel.previewFrame = 0;
            preview(panel.rows[panel.idx]);
        });
    }

    // ------------------------------------------------------------------ render
    function rowHtml(row, i) {
        if (row.heading) return '<div class="pdf2html-finder-group" role="presentation">' + escapeHtml(row.heading) + '</div>';
        var secondary = row.secondary
            ? '<span class="secondary">' + (typeof row.secondary === 'string'
                ? escapeHtml(row.secondary) : highlight(row.secondary, row.secondaryHits)) + '</span>'
            : '';
        var indent = row.depth ? ' style="padding-left:' + (row.depth * 16) + 'px"' : '';
        return '<button type="button" tabindex="-1" role="option" id="pdf2html-finder-row-' + i + '" data-i="' + i
            + '" data-kind="' + row.kind + '" class="pdf2html-finder-row' + (i === panel.idx ? ' active' : '')
            + '" aria-selected="' + (i === panel.idx) + '">'
            + '<span class="marker">' + (row.marker || '') + '</span>'
            + '<span class="text"' + indent + '><span class="primary">' + highlight(row.primary, row.hits) + '</span>'
            + secondary + '</span>'
            + '<span class="hint">' + escapeHtml(row.hint || '') + '</span>'
            + '</button>';
    }
    function selectable(i) { return panel.rows[i] && !panel.rows[i].heading; }
    // The list is windowed: rows have fixed heights (ROW_H, HEAD_H, matching
    // overlay.css), and only those within OVERSCAN px of the visible part are
    // in the DOM, so 2,000 sections render as fast as 20.
    function layout() {
        var tops = new Array(panel.rows.length + 1), y = 0;
        for (var i = 0; i < panel.rows.length; i++) { tops[i] = y; y += panel.rows[i].heading ? HEAD_H : ROW_H; }
        tops[panel.rows.length] = y;
        panel.tops = tops;
    }
    function renderWindow() {
        if (!panel || !panel.rows.length) return;
        var list = panel.list, tops = panel.tops, n = panel.rows.length;
        var from = list.scrollTop - OVERSCAN, to = list.scrollTop + (list.clientHeight || 400) + OVERSCAN;
        var a = 0, b = n;
        while (a < n && tops[a + 1] <= from) a++;
        b = a;
        while (b < n && tops[b] < to) b++;
        if (panel.window && panel.window[0] === a && panel.window[1] === b) return;
        panel.window = [a, b];
        var html = '<div class="pdf2html-finder-space" style="height:' + tops[a] + 'px"></div>';
        for (var i = a; i < b; i++) html += rowHtml(panel.rows[i], i);
        html += '<div class="pdf2html-finder-space" style="height:' + (tops[n] - tops[b]) + 'px"></div>';
        list.innerHTML = html;
    }
    function render(opts) {
        if (!panel) return;
        opts = opts || {};
        var value = panel.input.value;
        var s = scopeOf(panel.mode, value);
        panel.chip.textContent = s.chip;
        panel.chip.hidden = !s.chip;
        var result = listFor(s.scope, s.query);
        panel.rows = result.rows;
        var keep = opts.keepKey;
        var want = keep || result.select;
        var idx = -1;
        if (want) for (var i = 0; i < panel.rows.length; i++) if (panel.rows[i].key === want) { idx = i; break; }
        if (idx < 0) for (var j = 0; j < panel.rows.length; j++) if (selectable(j)) { idx = j; break; }
        panel.idx = idx;
        panel.window = null;
        if (!panel.rows.length) {
            panel.tops = [0];
            panel.list.innerHTML = '<div class="pdf2html-finder-empty">' + escapeHtml(result.empty || 'Nothing here yet.') + '</div>';
        } else {
            layout();
            if (result.center) centerActive();
            else if (!keep) { panel.list.scrollTop = 0; scrollActive(); }
            renderWindow();
        }
        panel.input.setAttribute('aria-activedescendant', idx >= 0 ? 'pdf2html-finder-row-' + idx : '');
        renderFoot();
        if (panel.previewed) schedulePreview();
    }
    function activeEl() { return panel.list.querySelector('.pdf2html-finder-row.active'); }
    // Bring the selected row into view; at the top of a group, its heading too.
    function scrollActive() {
        var i = panel.idx, list = panel.list;
        if (i < 0 || !panel.tops) return;
        var top = panel.tops[i], bottom = panel.tops[i + 1];
        if (i > 0 && panel.rows[i - 1].heading) top = panel.tops[i - 1];
        if (top < list.scrollTop) list.scrollTop = top;
        else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
        renderWindow();
    }
    function centerActive() {
        var i = panel.idx;
        if (i < 0) return;
        panel.list.scrollTop = Math.max(0, panel.tops[i] - (panel.list.clientHeight - ROW_H) / 2);
    }
    function kbd(label) { return '<span class="pdf2html-kbd">' + escapeHtml(label) + '</span>'; }
    function footItem(keys, tip) {
        return '<span class="foot-item">' + keys.map(kbd).join('') + '<span class="tip">' + escapeHtml(tip) + '</span></span>';
    }
    var VERB = { section: 'Go', page: 'Go', goto: 'Go', mark: 'Go', doc: 'Open', cmd: 'Run', find: 'Find' };
    function renderFoot() {
        var row = panel.rows[panel.idx];
        var left = [];
        if (panel.rows.filter(function (r) { return !r.heading; }).length > 1) left.push(footItem(['↑', '↓'], 'Move'));
        if (row) left.push(footItem(['↵'], VERB[row.kind] || 'Go'));
        if (row && row.alt) left.push(footItem(['⌘', '↵'], row.alt));
        left.push(footItem(['Esc'], panel.previewed ? 'Back' : 'Close'));
        var right = ['sections', 'documents', 'all'].filter(function (m) { return m !== panel.mode; })
            .map(function (m) { return footItem(['⌘', MODES[m].key], SWITCH_LABEL[m]); });
        panel.foot.innerHTML = '<div class="foot-group">' + left.join('') + '</div>'
            + '<div class="foot-group">' + right.join('') + '</div>';
    }
    function setActive(i, fromKeyboard) {
        if (!panel || i === panel.idx || !selectable(i)) return;
        var old = activeEl();
        if (old) { old.classList.remove('active'); old.setAttribute('aria-selected', 'false'); }
        panel.idx = i;
        if (fromKeyboard) scrollActive();
        var el = panel.list.querySelector('[data-i="' + i + '"]');
        if (el) { el.classList.add('active'); el.setAttribute('aria-selected', 'true'); }
        panel.input.setAttribute('aria-activedescendant', 'pdf2html-finder-row-' + i);
        if (fromKeyboard) schedulePreview();
        renderFoot();
    }
    function move(delta) {
        if (!panel || !panel.rows.length) return;
        var n = panel.rows.length, i = panel.idx;
        for (var step = 0; step < n; step++) {
            i = ((i + delta) % n + n) % n;
            if (selectable(i)) break;
        }
        panel.interacted = true;
        setActive(i, true);
    }
    // Every commit first closes the panel, which returns to where the reader
    // was; a jump then starts from there and is recorded once.
    function commit(alt) {
        if (!panel) return;
        var row = panel.rows[panel.idx];
        if (!row) {
            if (panel.mode !== 'sections' && !library.loaded()) panel.pendingCommit = alt ? 'alt' : 'plain';
            return;
        }
        var selection = panel.selection;
        closePanel(true);
        try { row.commit(alt, selection); }
        catch (err) { console.warn('[quick open] commit failed:', err); }
    }

    // ------------------------------------------------------------- lifecycle
    // Close; with `restore`, put the reader back where the panel found them.
    function closePanel(restore) {
        if (!panel) return false;
        var p = panel;
        if (restore) returnToOrigin();
        if (p.previewFrame) window.cancelAnimationFrame(p.previewFrame);
        panel = null;
        removeOverlay(p.bg);
        if (restore) core.restoreSelection(p.selection);
        return true;
    }

    function open(mode) {
        var existing = document.getElementById('pdf2html-finder');
        if (existing && !panel) removeOverlay(existing);
        library.refresh();
        var root = container();
        var bg = document.createElement('div');
        bg.id = 'pdf2html-finder';
        bg.innerHTML =
            '<div class="pdf2html-finder" role="dialog" aria-label="Quick open">'
          +   '<div class="pdf2html-finder-input-row">'
          +     '<span class="pdf2html-finder-chip" hidden></span>'
          +     '<input type="text" class="pdf2html-finder-input" id="pdf2html-finder-input" role="combobox" '
          +       'aria-expanded="true" aria-controls="pdf2html-finder-list" aria-autocomplete="list" '
          +       'autocomplete="off" spellcheck="false" autocapitalize="off">'
          +     '<button type="button" class="pdf2html-finder-close" aria-label="Close"><span class="pdf2html-kbd sm">Esc</span></button>'
          +   '</div>'
          +   '<div class="pdf2html-finder-list" id="pdf2html-finder-list" role="listbox"></div>'
          +   '<div class="pdf2html-finder-foot"></div>'
          + '</div>';
        document.body.appendChild(bg);
        panel = {
            bg: bg, box: bg.querySelector('.pdf2html-finder'), mode: mode,
            input: bg.querySelector('#pdf2html-finder-input'), list: bg.querySelector('#pdf2html-finder-list'),
            foot: bg.querySelector('.pdf2html-finder-foot'), chip: bg.querySelector('.pdf2html-finder-chip'),
            origin: { top: root ? root.scrollTop : 0, left: root ? root.scrollLeft : 0 },
            previewed: false, rows: [], idx: -1, interacted: false, selection: core.saveSelection(),
            previewFrame: 0, pendingCommit: null,
        };
        wire(panel);
        applyMode(mode);
        panel.input.focus();
    }
    function applyMode(mode) {
        panel.mode = mode;
        panel.box.setAttribute('data-mode', mode);
        panel.input.placeholder = MODES[mode].placeholder;
        render();
    }
    // The open key again closes; another of the three switches in place and
    // keeps what was typed (without a ⌘K prefix).
    function toggle(mode) {
        if (!panel) { open(mode); return; }
        if (panel.mode === mode) { closePanel(true); return; }
        var v = panel.input.value;
        if (panel.mode === 'all' && NARROW[v.charAt(0)]) v = v.slice(1);
        panel.input.value = v.replace(/^\s+/, '');
        panel.interacted = false;
        applyMode(mode);
        panel.input.focus();
    }

    function wire(p) {
        var input = p.input;
        p.bg.addEventListener('mousedown', function (ev) {
            if (ev.target === p.bg) { ev.preventDefault(); closePanel(true); return; }
            // Clicks inside the panel keep the caret in the field.
            if (ev.target !== input) ev.preventDefault();
            var rowEl = ev.target.closest && ev.target.closest('.pdf2html-finder-row');
            if (rowEl) {
                var i = Number(rowEl.getAttribute('data-i'));
                if (selectable(i)) { setActive(i, false); commit(ev.metaKey || ev.ctrlKey); }
                return;
            }
            if (ev.target.closest && ev.target.closest('.pdf2html-finder-close')) closePanel(true);
        });
        p.list.addEventListener('scroll', function () {
            if (p.scrollFrame) return;
            p.scrollFrame = window.requestAnimationFrame(function () { p.scrollFrame = 0; if (panel === p) renderWindow(); });
        }, { passive: true });
        p.list.addEventListener('mousemove', function (ev) {
            var rowEl = ev.target.closest && ev.target.closest('.pdf2html-finder-row');
            if (rowEl) setActive(Number(rowEl.getAttribute('data-i')), false);
        });
        input.addEventListener('input', function () {
            p.interacted = true;
            render();
            if (panel && (panel.previewed || input.value.trim())) schedulePreview();
        });
        input.addEventListener('keydown', function (ev) {
            var k = ev.key, ctrl = ev.ctrlKey && !ev.metaKey && !ev.altKey;
            var lower = k.length === 1 ? k.toLowerCase() : k;
            if (k === 'Escape') {
                ev.preventDefault(); ev.stopPropagation(); closePanel(true);
            } else if (k === 'Enter') {
                ev.preventDefault(); ev.stopPropagation(); commit(ev.metaKey || ev.ctrlKey);
            } else if (k === 'ArrowDown' || (k === 'Tab' && !ev.shiftKey) || (ctrl && (lower === 'j' || lower === 'n'))) {
                ev.preventDefault(); move(1);
            } else if (k === 'ArrowUp' || (k === 'Tab' && ev.shiftKey) || (ctrl && (lower === 'k' || lower === 'p'))) {
                ev.preventDefault(); move(-1);
            }
        });
        // With Vimium, Escape in a text field never reaches the page: insert
        // mode takes it and blurs the field. Focus leaving for the page while
        // the window keeps focus is that Escape (or a click away); close and
        // restore then. Switching to another app leaves the panel open.
        input.addEventListener('blur', function () {
            window.setTimeout(function () {
                if (panel !== p || !p.bg.isConnected || !document.hasFocus()) return;
                if (document.activeElement === input) return;
                closePanel(true);
            }, 0);
        });
    }

    // The library arrived or changed while the panel was open.
    library.onChange(function () {
        if (!panel) return;
        var row = panel.rows[panel.idx];
        render(panel.interacted && row ? { keepKey: row.key } : {});
        if (panel && panel.pendingCommit && panel.rows[panel.idx]) commit(panel.pendingCommit === 'alt');
    });

    // Index the outline while the reader is idle, so the first ⌘O is as quick
    // as the rest.
    if (window.requestIdleCallback) window.requestIdleCallback(function () { sections(); }, { timeout: 4000 });

    return {
        toggle: toggle,
        close: function () { return closePanel(true); },
        isOpen: function () { return !!panel; },
        mode: function () { return panel ? panel.mode : null; },
    };
}

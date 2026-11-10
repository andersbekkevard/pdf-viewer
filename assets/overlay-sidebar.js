// Sidebar: toggle, header, Outline / Pages tabs, keyboard list navigation,
// and the page shift that keeps pages clear of it.
//
//   #sidebar                       (pdf2htmlEX)
//     #pdf2html-sidebar-head       title + author/pages, close button
//     #pdf2html-sidebar-tabs       Outline / Pages tab buttons
//     #pdf2html-sidebar-body       the scroller Vimium j/k targets
//       #outline                   (pdf2htmlEX, moved in)
//       #pdf2html-thumbs           page cards
//     #pdf2html-sidebar-footer     Settings + Help buttons
//
// Both tabs follow the reading position (active row) and offer a second,
// temporary keyboard selection: Ctrl-j/k or ↓/↑ move it, Enter jumps to it.
// The selection is only drawn while it differs from the active row.
import { el, svgIcon, ICONS, isInputTarget } from './overlay-dom.js';

export function createSidebar(core) {
    var document = core.document;
    var window = core.window;
    var fetch = core.fetch;
    var prefs = core.prefs;
    var focus = core.focus;
    var navigation = core.navigation;
    var documentModel = core.documentModel;
    var entryHash = core.entryHash;
    var openSettings = core.openSettings;
    var toggleCheatsheet = core.toggleCheatsheet;
    var requestAnimationFrame = core.requestAnimationFrame;

    var panels = {};
    var bodyEl = null;

    function isShown() { return document.body.classList.contains('sidebar-shown'); }
    function setShown(on) { document.body.classList.toggle('sidebar-shown', on); }
    function toggle() { setShown(!isShown()); }
    function currentTab() { return document.body.getAttribute('data-sidebar-tab') || 'outline'; }
    function tabVisible(name) { return isShown() && currentTab() === name; }

    function setTab(name) {
        name = name === 'thumbs' ? 'thumbs' : 'outline';
        prefs.set('sidebarTab', name);
        document.body.setAttribute('data-sidebar-tab', name);
        var tabs = document.querySelectorAll('#pdf2html-sidebar-tabs .pdf2html-sidebar-tab');
        for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('active', tabs[i].dataset.tab === name);
        // Re-activate the sidebar body so Vimium j/k scrolls the newly
        // visible tab.
        focus.refreshSidebar();
    }

    // ------------------------------------------------------------------ chrome
    function mountToggleButton() {
        document.body.appendChild(el('button', {
            id: 'pdf2html-toggle',
            title: 'Toggle sidebar (⌘. or ⌘B)',
            html: svgIcon(ICONS.sidebar, 16),
            onClick: toggle,
        }));
    }

    function mountChrome() {
        var sidebar = document.getElementById('sidebar');
        if (!sidebar) return false;
        var outline = document.getElementById('outline');

        var tabs = el('div', { id: 'pdf2html-sidebar-tabs' }, [
            el('button', {
                class: 'pdf2html-sidebar-tab', dataset: { tab: 'outline' },
                html: svgIcon(ICONS.outline, 13) + '<span>Outline</span>',
                onClick: function () { setTab('outline'); },
            }),
            el('button', {
                class: 'pdf2html-sidebar-tab', dataset: { tab: 'thumbs' },
                html: svgIcon(ICONS.grid, 13) + '<span>Pages</span>',
                onClick: function () { setTab('thumbs'); },
            }),
        ]);
        // tabindex=-1 makes the body a valid activeElement target, so Vimium's
        // j/k scroll scopes to the sidebar (see overlay-focus.js).
        bodyEl = el('div', { id: 'pdf2html-sidebar-body', tabindex: '-1' });
        if (outline && outline.parentElement === sidebar) bodyEl.appendChild(outline);
        bodyEl.appendChild(el('div', { id: 'pdf2html-thumbs' }));

        var footer = el('div', { id: 'pdf2html-sidebar-footer' }, [
            el('button', {
                class: 'pdf2html-sidebar-footer-btn', title: 'Settings (:set)', onClick: openSettings,
                html: svgIcon(ICONS.settings, 14) + '<span class="label">Settings</span><span class="shortcut">:set</span>',
            }),
            el('button', {
                class: 'pdf2html-sidebar-footer-btn icon-only', title: 'Keyboard shortcuts (?)',
                onClick: function () { toggleCheatsheet(); }, html: svgIcon(ICONS.help, 14),
            }),
        ]);

        var titleEl = el('div', { class: 'doc-title' }, document.title || 'Document');
        var metaEl = el('div', { class: 'doc-meta' });
        var head = el('div', { id: 'pdf2html-sidebar-head' }, [
            el('div', { class: 'doc-text' }, [titleEl, metaEl]),
            el('button', {
                class: 'pdf2html-sidebar-close', title: 'Close sidebar (⌘. or ⌘B)',
                onClick: function () { setShown(false); }, html: svgIcon(ICONS.sidebar, 15),
            }),
        ]);

        sidebar.insertBefore(head, sidebar.firstChild);
        sidebar.appendChild(tabs);
        sidebar.appendChild(bodyEl);
        sidebar.appendChild(footer);
        loadHeaderMeta(titleEl, metaEl);
        return true;
    }

    // Title, author and page count from /<hash>/meta.json (written by
    // scripts/extract-pdf-meta.sh). Non-fatal: the header keeps <title>.
    function loadHeaderMeta(titleEl, metaEl) {
        var hash = entryHash();
        if (!hash) return;
        fetch('/' + hash + '/meta.json', { cache: 'force-cache' }).then(function (r) {
            return r.ok ? r.json() : null;
        }).then(function (m) {
            if (!m) return;
            if (m.title) titleEl.textContent = String(m.title);
            var parts = [];
            if (m.author) parts.push(String(m.author));
            if (m.pages) parts.push(String(m.pages) + ' pages');
            metaEl.textContent = parts.join(' · ');
        }).catch(function () {});
    }

    // ---------------------------------------------------------------- outline
    function mountOutlinePanel() {
        var outline = document.getElementById('outline');
        var entries = navigation.entries();
        if (!outline || !bodyEl || !entries.length) return null;

        var activeEntry = null;
        var selected = null;
        var raf = null;
        var programmaticScrolls = 0;

        function sync() {
            for (var i = 0; i < entries.length; i++) {
                var e = entries[i];
                e.link.classList.toggle('pdf2html-active', e === activeEntry);
                e.link.classList.toggle('pdf2html-selected', e === selected && e !== activeEntry);
            }
        }
        function setActive(entry) {
            if (entry === activeEntry) return;
            activeEntry = entry;
            sync();
            if (entry) try { entry.link.scrollIntoView({ block: 'nearest' }); } catch (e) {}
        }
        // Keyboard moves keep the selected row at 35% of the sidebar height.
        function anchorY() {
            var r = bodyEl.getBoundingClientRect();
            return r.top + r.height * 0.35;
        }
        function nearestToAnchor() {
            var box = bodyEl.getBoundingClientRect(), y = anchorY(), best = null, bestDist = Infinity;
            for (var i = 0; i < entries.length; i++) {
                var r = entries[i].link.getBoundingClientRect();
                if (r.bottom < box.top || r.top > box.bottom) continue;
                var dist = Math.abs(r.top + r.height / 2 - y);
                if (dist < bestDist) { best = entries[i]; bestDist = dist; }
            }
            return best;
        }
        function scrollToAnchor(entry) {
            var r = entry.link.getBoundingClientRect();
            var delta = r.top + r.height / 2 - anchorY();
            if (Math.abs(delta) > 0.5) programmaticScrolls += 1;
            bodyEl.scrollTop += delta;
        }

        document.addEventListener('pdf2html-chapter-change', function (e) {
            setActive(e.detail && e.detail.entry || null);
        });
        // A free sidebar scroll moves the selection with it.
        bodyEl.addEventListener('scroll', function () {
            if (raf) return;
            raf = requestAnimationFrame(function () {
                raf = null;
                if (!tabVisible('outline')) return;
                if (programmaticScrolls > 0) { programmaticScrolls -= 1; return; }
                selected = nearestToAnchor();
                sync();
            });
        }, { passive: true });
        // Clicks take the same jump path as Enter (pdf2htmlEX destination plus
        // the explicit-pick rule), so stop pdf2htmlEX's own link handler.
        outline.addEventListener('click', function (e) {
            var link = e.target.closest && e.target.closest('a[href^="#pf"]');
            var entry = link && entries.filter(function (x) { return x.link === link; })[0];
            if (!entry) return;
            e.preventDefault();
            e.stopPropagation();
            selected = null;
            navigation.gotoEntry(entry);
        }, true);

        return {
            onShow: function () {
                selected = activeEntry;
                sync();
                if (activeEntry) try { activeEntry.link.scrollIntoView({ block: 'nearest' }); } catch (e) {}
            },
            move: function (dir) {
                var from = selected || nearestToAnchor() || activeEntry || entries[0];
                var idx = Math.max(0, Math.min(entries.length - 1, entries.indexOf(from) + dir));
                selected = entries[idx];
                sync();
                scrollToAnchor(selected);
            },
            commit: function () {
                if (!selected) return false;
                var entry = selected;
                selected = null;
                navigation.gotoEntry(entry);
                sync();
                return true;
            },
        };
    }

    // ------------------------------------------------------------- thumbnails
    // Real thumbnails come from /<hash>/thumbs/N.jpg (scripts/
    // extract-pdf-thumbs.sh); entries without them keep skeleton cards.
    function mountThumbsPanel() {
        var host = document.getElementById('pdf2html-thumbs');
        var pages = documentModel.pages();
        if (!host || !pages.length) return null;
        var hash = entryHash();
        // Converted entries have pre-extracted JPEGs; the reader renders a
        // small raster of the page on demand.
        var reader = documentModel.isReader();
        var thumbBase = !hash ? null : reader ? '/r/' + hash + '/p/' : '/' + hash + '/thumbs/';
        var thumbSuffix = reader ? '/240.png' : '.jpg';
        var cards = [];

        pages.forEach(function (pf, idx) {
            var pageNum = documentModel.pageNumber(pf) || idx + 1;
            var inner = el('div', { class: 'thumb-page' }, [
                el('div', {
                    class: 'thumb-skeleton',
                    html: '<div class="l1"></div><div class="l2"></div><div class="l3"></div>'
                        + '<div class="l2"></div><div class="l1"></div><div class="l3"></div>'
                        + '<div class="l2"></div>',
                }),
            ]);
            if (thumbBase) {
                // Native lazy loading: only fetched once the card nears the
                // viewport, so unbrowsed Pages tabs cost nothing.
                var img = new Image();
                img.className = 'thumb-img';
                img.loading = 'lazy';
                img.decoding = 'async';
                img.alt = 'Page ' + pageNum;
                img.addEventListener('load', function () { inner.classList.add('has-img'); });
                img.src = thumbBase + pageNum + thumbSuffix;
                inner.appendChild(img);
            }
            var card = el('button', {
                class: 'pdf2html-thumb', title: 'Page ' + pageNum, dataset: { page: String(pageNum) },
                onClick: function () { selected = null; navigation.gotoPage(pageNum, false); sync(); },
            }, [el('div', { class: 'thumb-stack' }, [inner, el('div', { class: 'thumb-label' }, String(pageNum))])]);
            host.appendChild(card);
            cards.push(card);
        });

        var activePage = navigation.page();
        var selected = null;

        function card(page) { return cards[page - 1] || null; }
        function sync() {
            for (var i = 0; i < cards.length; i++) {
                var page = i + 1;
                var on = page === activePage;
                cards[i].classList.toggle('active', on);
                if (on) cards[i].setAttribute('aria-current', 'page');
                else cards[i].removeAttribute('aria-current');
                cards[i].classList.toggle('pdf2html-selected', page === selected && !on);
            }
        }
        function center(page) {
            var c = card(page);
            if (c) try { c.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }); } catch (e) {}
        }

        document.addEventListener('pdf2html-page-change', function (e) {
            activePage = e.detail && e.detail.page || activePage;
            sync();
            if (tabVisible('thumbs')) center(activePage);
        });
        sync();

        return {
            onShow: function () { selected = null; sync(); center(activePage); },
            move: function (dir) {
                selected = Math.max(1, Math.min(cards.length, (selected || activePage || 1) + dir));
                sync();
                center(selected);
            },
            commit: function () {
                if (!selected) return false;
                var page = selected;
                selected = null;
                navigation.gotoPage(page, false);
                sync();
                return true;
            },
        };
    }

    // ------------------------------------------------------------------- keys
    function mountKeys() {
        document.addEventListener('keydown', function (e) {
            if (isInputTarget(e.target)) return;
            // `!e.shiftKey` matters: ⌘⇧. is the page-counter toggle and on
            // some layouts (e.g. Norwegian) e.key still reads '.' with shift
            // held, so without this guard both handlers fire.
            if (e.metaKey && !e.shiftKey && !e.ctrlKey && !e.altKey
                && (e.key === '.' || e.key === 'b' || e.key === 'B')) {
                e.preventDefault();
                toggle();
                return;
            }
            // ←/→ (and h/l) switch tabs while the sidebar is open; otherwise
            // arrows scroll and Vimium keeps h/l.
            var left = e.key === 'ArrowLeft' || e.key === 'h';
            var right = e.key === 'ArrowRight' || e.key === 'l';
            if ((left || right) && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && isShown()) {
                e.preventDefault();
                setTab(left ? 'outline' : 'thumbs');
            }
        });

        // List navigation inside the visible tab. Window capture so it runs
        // before Vimium sees Ctrl-j/k or Enter.
        window.addEventListener('keydown', function (e) {
            if (e.metaKey || e.altKey || e.shiftKey) return;
            if (isInputTarget(e.target) || !isShown() || !focus.isSidebarScope()) return;
            var panel = panels[currentTab()];
            if (!panel) return;
            var down = (e.ctrlKey && (e.key === 'j' || e.key === 'J')) || (!e.ctrlKey && e.key === 'ArrowDown');
            var up = (e.ctrlKey && (e.key === 'k' || e.key === 'K')) || (!e.ctrlKey && e.key === 'ArrowUp');
            var handled = false;
            if (down || up) { panel.move(down ? 1 : -1); handled = true; }
            else if (!e.ctrlKey && e.key === 'Enter') handled = panel.commit();
            if (handled) {
                e.preventDefault();
                e.stopImmediatePropagation();
            }
        }, true);
    }

    // Keep the sidebar fixed on the left, but only shift the pages once it
    // has used up the natural left gutter around the centered page — like a
    // native browser side panel, rather than re-centering the document.
    function mountLayout() {
        var sidebar = document.getElementById('sidebar');
        var root = documentModel.container();
        var pages = documentModel.pages();
        if (!sidebar || !root || !pages.length) return;
        var widest = pages.reduce(function (w, p) { return p.offsetWidth > w.offsetWidth ? p : w; }, pages[0]);
        var GUTTER = 14;
        var raf = null;
        var settleFrames = 0;

        function apply() {
            var shift = 0;
            if (isShown()) {
                var naturalLeft = (root.getBoundingClientRect().width - widest.getBoundingClientRect().width) / 2;
                shift = Math.max(0, Math.round(sidebar.getBoundingClientRect().right + GUTTER - naturalLeft));
            }
            document.documentElement.style.setProperty('--pdf2html-page-shift', shift + 'px');
            document.body.classList.toggle('pdf2html-page-shifted', shift > 0);
        }
        // Re-measure for a few frames: the sidebar can still be settling.
        function step() {
            raf = null;
            apply();
            if (settleFrames > 0) { settleFrames -= 1; raf = requestAnimationFrame(step); }
        }
        function sched() {
            settleFrames = Math.max(settleFrames, 6);
            if (!raf) raf = requestAnimationFrame(step);
        }
        new MutationObserver(sched).observe(document.body, { attributes: true, attributeFilter: ['class'] });
        document.addEventListener('pdf2html-viewport-change', sched);
        window.addEventListener('resize', sched);
        sched();
    }

    function mount() {
        mountToggleButton();
        if (!mountChrome()) return;
        panels.outline = mountOutlinePanel();
        panels.thumbs = mountThumbsPanel();
        setTab(prefs.get('sidebarTab'));
        mountKeys();
        mountLayout();

        // Showing a tab re-syncs its selection to the reading position.
        var last = null;
        new MutationObserver(function () {
            var visible = isShown() ? currentTab() : null;
            if (visible === last) return;
            last = visible;
            if (visible && panels[visible]) panels[visible].onShow();
        }).observe(document.body, { attributes: true, attributeFilter: ['class', 'data-sidebar-tab'] });
    }

    return { mount: mount, toggle: toggle, isShown: isShown, close: function () { setShown(false); } };
}

// ============================================================================
// pdf_viewer overlay — runtime layer on top of pdf2htmlEX's output.
//
// Served as /_assets/overlay.js, loaded via <script src="..." defer> injected
// into each converted HTML. Everything runs on DOMContentLoaded.
// ============================================================================

(function () {
    'use strict';

    document.addEventListener('DOMContentLoaded', init);

    function init() {
        killPdf2htmlExRenderLoop();
        mountSidebarToggleButton();
        registerEscapeHandler();
        registerQuestionHandler();
        registerPaletteHandler();
        registerFingerShortcutHandler();
        registerQuickOpenHandler();
        registerSettingsHandler();
        registerPagenoToggleHandler();
        registerRenderAllHandler();
        registerPageJumpHandler();
        registerSidebarKeyHandler();
        registerFocusRouting();
        registerPageTracker();
        mountCursorPin();
        mountRenderWindow();
        mountNativeFindShadowLayer();
        mountOutlineActiveTracker();
        mountPageCounter();
        mountResumePosition();
        mountZoom();
        mountSidebarBackdrop();
        mountSidebarChrome();
        mountOutlineScrollSelection();
        mountSidebarHeader();
        mountSidebarLayout();
        mountThumbnails();
        mountSearch();
        applyAppearanceSettings();
        loadLibrary();
    }

    // Module-level page tracker. mountPageCounter dispatches pdf2html-page-change
    // on scroll; other commands (`:mark`, `:yank`) read from here instead of
    // recomputing via elementFromPoint.
    var currentPage = 1;
    var fingerState = null;
    function registerPageTracker() {
        document.addEventListener('pdf2html-page-change', function (e) {
            if (e.detail && e.detail.page) currentPage = e.detail.page;
        });
    }

    function currentChapterLabel() {
        var link = document.querySelector('#outline a.pdf2html-active');
        return link ? (link.textContent || '').replace(/\s+/g, ' ').trim() : '';
    }


    // ------------------------------------------------------------------------
    // Tiny DOM helper — used across sidebar chrome + settings modal for
    // readable declarative construction. Not a framework, just sugar.
    // ------------------------------------------------------------------------
    function el(tag, attrs, children) {
        var n = document.createElement(tag);
        attrs = attrs || {};
        for (var k in attrs) {
            if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
            var v = attrs[k];
            if (v == null || v === false) continue;
            if (k === 'class') n.className = v;
            else if (k === 'html') n.innerHTML = v;
            else if (k.indexOf('on') === 0 && typeof v === 'function') {
                n.addEventListener(k.slice(2).toLowerCase(), v);
            } else if (k === 'dataset' && typeof v === 'object') {
                for (var dk in v) n.dataset[dk] = v[dk];
            } else {
                n.setAttribute(k, v);
            }
        }
        children = children || [];
        if (!Array.isArray(children)) children = [children];
        children.forEach(function (c) {
            if (c == null || c === false) return;
            n.appendChild(c.nodeType ? c : document.createTextNode(String(c)));
        });
        return n;
    }

    function svgIcon(path, size) {
        size = size || 14;
        return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" '
            + 'fill="none" stroke="currentColor" stroke-width="1.75" '
            + 'stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
    }

    // Resolve the cache-entry hash. Prefer the inject-time <meta> tag —
    // location.pathname lies when the page is served via /view?path=…
    // (daemon FileResponse keeps the URL on /view rather than redirecting
    // to /<hash>/<stem>.html). Fall back to pathname for older entries
    // that predate the meta injection.
    function entryHash() {
        var meta = document.querySelector('meta[name="pdf2html-hash"]');
        if (meta && meta.content) return meta.content;
        var m = location.pathname.match(/^\/([a-f0-9]{6,32})\//);
        return m ? m[1] : null;
    }
    var ICONS = {
        sidebar:  '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M9 4v16"/>',
        outline:  '<path d="M4 6h16M4 12h16M4 18h10"/>',
        grid:     '<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/>',
        settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
        help:     '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    };


    // ------------------------------------------------------------------------
    // Sidebar backdrop host. Kept in DOM as inert plumbing so older cache
    // entries and CSS selectors still have a stable target, but the sidebar
    // is no longer modal-overlay chrome — the main PDF stays clickable.
    // ------------------------------------------------------------------------
    function mountSidebarBackdrop() {
        var bd = document.createElement('div');
        bd.id = 'pdf2html-sidebar-backdrop';
        bd.setAttribute('aria-hidden', 'true');
        document.body.appendChild(bd);
    }


    // ------------------------------------------------------------------------
    // Sidebar chrome — wrap #sidebar's pre-existing #outline in a tabs +
    // body + footer structure matching the design. pdf2htmlEX provides
    // #outline; we don't touch its contents, just wrap and add siblings.
    //
    //   #sidebar
    //     #pdf2html-sidebar-head       (added later by mountSidebarHeader)
    //     #pdf2html-sidebar-tabs       (Outline / Pages tab buttons)
    //     #pdf2html-sidebar-body
    //       #outline                   (pdf2htmlEX, moved in)
    //       #pdf2html-thumbs           (mountThumbnails populates)
    //     #pdf2html-sidebar-footer     (Settings + Help icon buttons)
    // ------------------------------------------------------------------------
    function mountSidebarChrome() {
        var sidebar = document.getElementById('sidebar');
        if (!sidebar) return;
        var outline = document.getElementById('outline');

        var tabs = el('div', { id: 'pdf2html-sidebar-tabs' }, [
            el('button', {
                class: 'pdf2html-sidebar-tab',
                dataset: { tab: 'outline' },
                html: svgIcon(ICONS.outline, 13) + '<span>Outline</span>',
                onClick: function () { setSidebarTab('outline'); },
            }),
            el('button', {
                class: 'pdf2html-sidebar-tab',
                dataset: { tab: 'thumbs' },
                html: svgIcon(ICONS.grid, 13) + '<span>Pages</span>',
                onClick: function () { setSidebarTab('thumbs'); },
            }),
        ]);

        // tabindex=-1 makes the body a valid activeElement target, so Vimium's
        // j/k scroll scopes to the sidebar (nearest scrollable ancestor of
        // activeElement) rather than the main page. See registerFocusRouting.
        var body = el('div', { id: 'pdf2html-sidebar-body', tabindex: '-1' });
        if (outline && outline.parentElement === sidebar) body.appendChild(outline);
        var thumbs = el('div', { id: 'pdf2html-thumbs' });
        body.appendChild(thumbs);

        var footer = el('div', { id: 'pdf2html-sidebar-footer' }, [
            el('button', {
                class: 'pdf2html-sidebar-footer-btn',
                title: 'Settings (:set)',
                onClick: openSettings,
                html: svgIcon(ICONS.settings, 14)
                    + '<span class="label">Settings</span>'
                    + '<span class="shortcut">:set</span>',
            }),
            el('button', {
                class: 'pdf2html-sidebar-footer-btn icon-only',
                title: 'Keyboard shortcuts (?)',
                onClick: toggleCheatsheet,
                html: svgIcon(ICONS.help, 14),
            }),
        ]);

        sidebar.appendChild(tabs);
        sidebar.appendChild(body);
        sidebar.appendChild(footer);

        var saved = localStorage.getItem('pdf2html-sidebar-tab');
        setSidebarTab(saved === 'thumbs' ? 'thumbs' : 'outline');
    }

    function setSidebarTab(name) {
        if (name !== 'outline' && name !== 'thumbs') name = 'outline';
        document.body.setAttribute('data-sidebar-tab', name);
        localStorage.setItem('pdf2html-sidebar-tab', name);
        var tabs = document.querySelectorAll('#pdf2html-sidebar-tabs .pdf2html-sidebar-tab');
        for (var i = 0; i < tabs.length; i++) {
            tabs[i].classList.toggle('active', tabs[i].dataset.tab === name);
        }
        // Re-activate the sidebar body so Vimium j/k scrolls the newly-visible
        // tab. Only when sidebar is shown, so palette-driven tab changes
        // (e.g. a future `:tab thumbs`) while closed don't hijack j/k.
        var body = document.getElementById('pdf2html-sidebar-body');
        if (body && document.body.classList.contains('sidebar-shown')) {
            try { body.focus({ preventScroll: true }); } catch (e) {}
            try { body.dispatchEvent(new Event('DOMActivate', { bubbles: true, cancelable: true })); } catch (e) {}
            try { body.dispatchEvent(new MouseEvent('click',   { bubbles: true, cancelable: true })); } catch (e) {}
        }
    }

    // ------------------------------------------------------------------------
    // Outline selection — a second, temporary target for keyboard navigation in
    // the sidebar. It stays visually hidden while it matches the current active
    // chapter; Ctrl-j/k or arrows move it, and Enter activates it.
    // ------------------------------------------------------------------------
    function mountOutlineScrollSelection() {
        var body = document.getElementById('pdf2html-sidebar-body');
        var outline = document.getElementById('outline');
        if (!body || !outline) return;

        var links = Array.prototype.slice.call(outline.querySelectorAll('a[href^="#pf"]'));
        if (!links.length) return;

        var selected = null;
        var raf = null;
        var programmaticScrollsToIgnore = 0;

        function outlineVisible() {
            return document.body.classList.contains('sidebar-shown')
                && document.body.getAttribute('data-sidebar-tab') === 'outline';
        }

        function sameTarget(a, b) {
            if (!a || !b) return false;
            return a === b || a.getAttribute('href') === b.getAttribute('href');
        }

        function syncSelectedMarker() {
            var active = activeLink();
            for (var i = 0; i < links.length; i++) {
                links[i].classList.toggle('pdf2html-selected', links[i] === selected && !sameTarget(links[i], active));
            }
        }

        function setSelected(link) {
            if (link === selected) {
                syncSelectedMarker();
                return;
            }
            selected = link || null;
            syncSelectedMarker();
        }

        function activeLink() {
            return outline.querySelector('a.pdf2html-active[href^="#pf"]');
        }

        function selectedLink() {
            return selected || nearestAnchorLink() || activeLink() || links[0] || null;
        }

        function pageFromLink(link) {
            var m = link && (link.getAttribute('href') || '').match(/#pf([0-9a-f]+)/i);
            return m ? parseInt(m[1], 16) : null;
        }

        function setActiveLink(link) {
            for (var i = 0; i < links.length; i++) {
                links[i].classList.toggle('pdf2html-active', links[i] === link);
            }
            syncSelectedMarker();
        }

        function replaceHash(link) {
            var href = link && link.getAttribute('href');
            if (!href || href.charAt(0) !== '#') return;
            try {
                history.replaceState(null, '', location.pathname + location.search + href);
            } catch (e) {}
        }

        function commitSelected() {
            var link = selected;
            if (!link) return;
            var page = pageFromLink(link);
            var pf = pageElement(page);
            var pc = document.getElementById('page-container');
            if (!pf || !pc) return;

            setActiveLink(link);
            setSelected(null);
            pc.scrollTop = Math.max(0, pf.offsetTop);
            replaceHash(link);
        }

        function scrollLinkToAnchor(link) {
            if (!link) return;
            var bodyRect = body.getBoundingClientRect();
            var linkRect = link.getBoundingClientRect();
            var anchorY = bodyRect.top + bodyRect.height * 0.35;
            var linkY = linkRect.top + linkRect.height / 2;
            var delta = linkY - anchorY;
            if (Math.abs(delta) > 0.5) programmaticScrollsToIgnore += 1;
            body.scrollTop += delta;
        }

        function moveSelected(dir) {
            var from = selectedLink();
            if (!from) return;
            var idx = links.indexOf(from);
            if (idx < 0) idx = 0;
            idx = Math.max(0, Math.min(links.length - 1, idx + dir));
            var next = links[idx];
            setSelected(next);
            scrollLinkToAnchor(next);
        }

        function nearestAnchorLink() {
            var bodyRect = body.getBoundingClientRect();
            var anchorY = bodyRect.top + bodyRect.height * 0.35;
            var best = null;
            var bestDist = Infinity;

            for (var i = 0; i < links.length; i++) {
                var r = links[i].getBoundingClientRect();
                if (r.bottom < bodyRect.top || r.top > bodyRect.bottom) continue;
                var mid = r.top + r.height / 2;
                var dist = Math.abs(mid - anchorY);
                if (dist < bestDist) {
                    best = links[i];
                    bestDist = dist;
                }
            }
            return best;
        }

        function updateFromScroll() {
            raf = null;
            if (!outlineVisible()) return;
            if (programmaticScrollsToIgnore > 0) {
                programmaticScrollsToIgnore -= 1;
                syncSelectedMarker();
                return;
            }
            setSelected(nearestAnchorLink());
        }

        function scheduleFromScroll() {
            if (raf) return;
            raf = requestAnimationFrame(updateFromScroll);
        }

        function syncOnVisibilityChange() {
            if (!outlineVisible()) return;
            var active = activeLink();
            if (active) {
                setSelected(active);
                try { active.scrollIntoView({ block: 'nearest' }); } catch (e) {}
                return;
            }
            setSelected(null);
        }

        for (var i = 0; i < links.length; i++) (function (link) {
            link.addEventListener('click', function () { setSelected(link); });
        })(links[i]);

        body.addEventListener('scroll', scheduleFromScroll, { passive: true });
        new MutationObserver(syncOnVisibilityChange).observe(document.body, {
            attributes: true,
            attributeFilter: ['class', 'data-sidebar-tab'],
        });
        new MutationObserver(syncSelectedMarker).observe(outline, {
            attributes: true,
            attributeFilter: ['class'],
            subtree: true,
        });

        window.addEventListener('keydown', function (e) {
            if (e.metaKey || e.altKey) return;
            if (isInputTarget(e.target)) return;
            if (!outlineVisible()) return;
            if (document.activeElement !== body
                && document.body.getAttribute('data-scroll-focus') !== 'sidebar') return;

            var ctrlDown = e.ctrlKey && !e.shiftKey && (e.key === 'j' || e.key === 'J');
            var ctrlUp = e.ctrlKey && !e.shiftKey && (e.key === 'k' || e.key === 'K');
            var arrowDown = !e.ctrlKey && !e.shiftKey && e.key === 'ArrowDown';
            var arrowUp = !e.ctrlKey && !e.shiftKey && e.key === 'ArrowUp';
            if (ctrlDown || ctrlUp || arrowDown || arrowUp) {
                e.preventDefault();
                e.stopPropagation();
                if (e.stopImmediatePropagation) e.stopImmediatePropagation();
                moveSelected((ctrlDown || arrowDown) ? 1 : -1);
                return;
            }

            if (!e.ctrlKey && !e.shiftKey && e.key === 'Enter') {
                if (!selected) return;
                e.preventDefault();
                e.stopPropagation();
                if (e.stopImmediatePropagation) e.stopImmediatePropagation();
                commitSelected();
            }
        }, true);

        syncOnVisibilityChange();
    }

    // ------------------------------------------------------------------------
    // Sidebar layout — keep the sidebar fixed on the left, but only translate
    // the PDF pages once the sidebar has exhausted the natural left-side gutter
    // around the centered page. That mirrors native browser side panels more
    // closely than re-centering the whole document inside a narrowed viewport.
    // ------------------------------------------------------------------------
    function mountSidebarLayout() {
        var sidebar = document.getElementById('sidebar');
        var pc = document.getElementById('page-container');
        if (!sidebar || !pc) return;
        var pages = Array.prototype.slice.call(pc.querySelectorAll('.pf'));
        var widestPage = pages[0] || null;
        for (var i = 1; i < pages.length; i++) {
            if (!widestPage || pages[i].offsetWidth > widestPage.offsetWidth) widestPage = pages[i];
        }

        var raf = null;
        var settleFrames = 0;

        function apply() {
            var shift = 0;
            if (document.body.classList.contains('sidebar-shown')) {
                var maxWidth = widestPage ? widestPage.getBoundingClientRect().width : 0;
                var viewportWidth = pc.getBoundingClientRect().width;
                var naturalLeft = (viewportWidth - maxWidth) / 2;
                var sidebarRect = sidebar.getBoundingClientRect();
                var gutter = 14;
                shift = Math.max(0, Math.round(sidebarRect.right + gutter - naturalLeft));
            }
            document.documentElement.style.setProperty('--pdf2html-page-shift', shift + 'px');
        }

        function step() {
            raf = null;
            apply();
            if (settleFrames > 0) {
                settleFrames -= 1;
                raf = requestAnimationFrame(step);
            }
        }

        function sched(extraFrames) {
            if (extraFrames == null) extraFrames = 4;
            settleFrames = Math.max(settleFrames, extraFrames);
            if (raf) return;
            raf = requestAnimationFrame(step);
        }

        new MutationObserver(function () { sched(6); }).observe(document.body, {
            attributes: true,
            attributeFilter: ['class'],
        });
        requestAnimationFrame(function () { sched(6); });
    }


    // ------------------------------------------------------------------------
    // Thumbnails grid — a 2-col grid of placeholder page cards. pdf2htmlEX
    // doesn't ship real thumbnails (would double the cache size); these are
    // skeleton shapes purely for spatial navigation. Click scrolls the real
    // page into view.
    //
    // Active state updates via the `pdf2html-page-change` custom event that
    // mountPageCounter dispatches on scroll.
    // ------------------------------------------------------------------------
    function mountThumbnails() {
        var host = document.getElementById('pdf2html-thumbs');
        var pc = document.getElementById('page-container');
        if (!host || !pc) return;
        var pages = pc.querySelectorAll('.pf');
        if (!pages.length) return;

        // Template real thumbnail URLs at /<hash>/thumbs/N.jpg (written by
        // scripts/extract-pdf-thumbs.sh at convert time). For cache entries
        // without thumbs yet, the <img> 404s silently and skeletons stay.
        var hash = entryHash();
        var thumbBase = hash ? '/' + hash + '/thumbs/' : null;

        for (var i = 0; i < pages.length; i++) (function (pf, idx) {
            var m = (pf.id || '').match(/pf([0-9a-f]+)/i);
            var pageNum = m ? parseInt(m[1], 16) : (idx + 1);

            var inner = el('div', { class: 'thumb-page' }, [
                el('div', {
                    class: 'thumb-skeleton',
                    html: '<div class="l1"></div><div class="l2"></div><div class="l3"></div>'
                        + '<div class="l2"></div><div class="l1"></div><div class="l3"></div>'
                        + '<div class="l2"></div>',
                }),
            ]);

            if (thumbBase) {
                // Native lazy loading: Chrome only fetches once the <img>
                // scrolls near the viewport, so we pay nothing for 797 pages
                // unless the user actually browses the Pages tab.
                var img = new Image();
                img.className = 'thumb-img';
                img.loading   = 'lazy';
                img.decoding  = 'async';
                img.alt = 'Page ' + pageNum;
                img.addEventListener('load',  function () { inner.classList.add('has-img'); });
                img.addEventListener('error', function () { /* leave skeleton */ });
                img.src = thumbBase + pageNum + '.jpg';
                inner.appendChild(img);
            }

            var card = el('button', {
                class: 'pdf2html-thumb',
                title: 'Page ' + pageNum,
                dataset: { page: String(pageNum) },
                onClick: function () { pf.scrollIntoView({ block: 'start' }); },
            }, [
                el('div', { class: 'thumb-stack' }, [
                    inner,
                    el('div', { class: 'thumb-label' }, String(pageNum)),
                ]),
            ]);
            host.appendChild(card);
        })(pages[i], i);

        function thumbsTabVisible() {
            return document.body.classList.contains('sidebar-shown')
                && document.body.getAttribute('data-sidebar-tab') === 'thumbs';
        }

        var thumbButtons = Array.prototype.slice.call(host.querySelectorAll('.pdf2html-thumb'));
        var selectedPage = null;

        function thumbPage(thumb) {
            return thumb ? parseInt(thumb.dataset.page, 10) : NaN;
        }

        function activeThumbPage() {
            var active = host.querySelector('.pdf2html-thumb.active');
            var page = thumbPage(active);
            return !isNaN(page) ? page : currentPage;
        }

        function thumbForPage(page) {
            for (var i = 0; i < thumbButtons.length; i++) {
                if (thumbPage(thumbButtons[i]) === page) return thumbButtons[i];
            }
            return null;
        }

        function syncSelectedThumbMarker() {
            var activePage = activeThumbPage();
            for (var i = 0; i < thumbButtons.length; i++) {
                var page = thumbPage(thumbButtons[i]);
                thumbButtons[i].classList.toggle(
                    'pdf2html-selected',
                    selectedPage === page && selectedPage !== activePage
                );
            }
        }

        function setSelectedPage(page) {
            if (!page || page < 1) selectedPage = null;
            else selectedPage = Math.max(1, Math.min(pages.length, page));
            syncSelectedThumbMarker();
        }

        function selectedPageBase() {
            return selectedPage || activeThumbPage() || currentPage || 1;
        }

        function moveSelectedPage(delta) {
            setSelectedPage(selectedPageBase() + delta);
            var thumb = thumbForPage(selectedPage);
            if (thumb) {
                try { thumb.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' }); } catch (e) {}
            }
        }

        function replaceHashForPage(page) {
            try {
                history.replaceState(null, '', location.pathname + location.search + '#pf' + page.toString(16));
            } catch (e) {}
        }

        function commitSelectedPage() {
            if (!selectedPage) return;
            var pf = pageElement(selectedPage);
            if (!pf) return;
            currentPage = selectedPage;
            syncThumbState(selectedPage, true);
            setSelectedPage(null);
            pc.scrollTop = Math.max(0, pf.offsetTop);
            replaceHashForPage(currentPage);
        }

        function syncThumbState(page, center) {
            if (!page || page < 1) return;
            var active = null;
            for (var j = 0; j < thumbButtons.length; j++) {
                var on = thumbPage(thumbButtons[j]) === page;
                thumbButtons[j].classList.toggle('active', on);
                if (on) thumbButtons[j].setAttribute('aria-current', 'page');
                else thumbButtons[j].removeAttribute('aria-current');
                if (on) active = thumbButtons[j];
            }
            syncSelectedThumbMarker();
            if (active && center && thumbsTabVisible()) {
                try { active.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' }); } catch (err) {}
            }
        }

        document.addEventListener('pdf2html-page-change', function (e) {
            var page = e.detail && e.detail.page;
            syncThumbState(page, true);
        });

        new MutationObserver(function () {
            if (thumbsTabVisible()) syncThumbState(currentPage, true);
        }).observe(document.body, {
            attributes: true,
            attributeFilter: ['class', 'data-sidebar-tab'],
        });

        window.addEventListener('keydown', function (e) {
            if (e.metaKey || e.altKey) return;
            if (isInputTarget(e.target)) return;
            if (!thumbsTabVisible()) return;
            if (document.activeElement !== document.getElementById('pdf2html-sidebar-body')
                && document.body.getAttribute('data-scroll-focus') !== 'sidebar') return;

            var ctrlDown = e.ctrlKey && !e.shiftKey && (e.key === 'j' || e.key === 'J');
            var ctrlUp = e.ctrlKey && !e.shiftKey && (e.key === 'k' || e.key === 'K');
            var arrowDown = !e.ctrlKey && !e.shiftKey && e.key === 'ArrowDown';
            var arrowUp = !e.ctrlKey && !e.shiftKey && e.key === 'ArrowUp';
            if (ctrlDown || ctrlUp || arrowDown || arrowUp) {
                e.preventDefault();
                e.stopPropagation();
                if (e.stopImmediatePropagation) e.stopImmediatePropagation();
                moveSelectedPage((ctrlDown || arrowDown) ? 1 : -1);
                return;
            }

            if (!e.ctrlKey && !e.shiftKey && e.key === 'Enter') {
                if (!selectedPage) return;
                e.preventDefault();
                e.stopPropagation();
                if (e.stopImmediatePropagation) e.stopImmediatePropagation();
                commitSelectedPage();
            }
        }, true);

        syncThumbState(currentPage, false);
    }


    // ------------------------------------------------------------------------
    // Appearance settings — exposes window setters used by the settings
    // modal.
    //
    //  pdf2html-esc-clears  '1' | '0'  (default '1'; consulted in the
    //                                   escape handler)
    // ------------------------------------------------------------------------
    function applyAppearanceSettings() {
        window.__pdf2htmlSetEscClears = function (on) {
            localStorage.setItem('pdf2html-esc-clears', on ? '1' : '0');
        };
        window.__pdf2htmlSetSearchCase = function (on) {
            localStorage.setItem('pdf2html-search-case', on ? '1' : '0');
            var sIn = document.getElementById('pdf2html-search-input');
            if (sIn) { updateSearchHits(sIn.value); updateSearchCount(); }
        };
    }

    function isSearchCaseSensitive() {
        return localStorage.getItem('pdf2html-search-case') === '1';
    }


    // ------------------------------------------------------------------------
    // Settings modal — opens via `:set`, the sidebar footer button, or the
    // `⌘,` keybind. Groups: Appearance (theme/accent/zoom), Behavior
    // (render-all, counter, buffer, pin), Keyboard (leader, esc-clears,
    // smooth-scroll).
    //
    // Controls talk to the same hidden #pdf2html-all-input / -buffer-input /
    // -pin-input that the palette commands fire change events on, so state
    // flows through a single persistence path.
    // ------------------------------------------------------------------------
    function openSettings() {
        var ex = document.getElementById('pdf2html-settings');
        if (ex) { ex.remove(); return; }

        var bd = el('div', {
            id: 'pdf2html-settings',
            class: 'pdf2html-modal-backdrop',
            onClick: function (e) { if (e.target === bd) bd.remove(); },
        });
        var card = el('div', { class: 'pdf2html-settings-card' });

        card.appendChild(el('div', { class: 'pdf2html-settings-head' }, [
            el('div', {}, [
                el('h2', {}, 'Settings'),
                el('div', { class: 'sub' }, ':set  ·  persisted locally'),
            ]),
            el('span', {
                class: 'close',
                html: '<span class="pdf2html-kbd sm">Esc</span> to close',
            }),
        ]));

        var body = el('div', { class: 'pdf2html-settings-body', tabindex: '-1' });

        // --- Appearance ------------------------------------------------
        var curZoom = parseFloat(localStorage.getItem('pdf2html-zoom') || '1.4');
        if (!isFinite(curZoom) || curZoom <= 0) curZoom = 1.4;

        body.appendChild(makeGroup('Appearance', [
            makeRow('Theme', 'Light PDF · dark chrome',
                makeSeg([
                    { value: 'dark',   label: 'Dark' },
                    { value: 'system', label: 'System' },
                ], 'dark', function () { /* monochromatic single theme */ })),
            makeRow('Zoom', 'Page-container scale (:zoom)',
                makeSliderWithValue(0.6, 2.5, 0.1, curZoom, function (v) {
                    if (window.__pdf2htmlSetZoom) window.__pdf2htmlSetZoom(v);
                })),
        ]));

        // --- Behavior --------------------------------------------------
        var renderAllOn  = localStorage.getItem('pdf2html-render-all') === '1';
        var counterVis   = localStorage.getItem('pdf2html-pageno-hidden') === '0';
        var curBuffer    = parseInt(localStorage.getItem('pdf2html-buffer') || '10', 10);
        if (isNaN(curBuffer)) curBuffer = 10;
        var curScrollOffPct = Math.round(
            (parseFloat(localStorage.getItem('pdf2html-scrolloff') || '0.25')) * 100);
        var pinnedOn = localStorage.getItem('pdf2html-pinned') !== '0';
        var caseOn = isSearchCaseSensitive();

        // Scrolloff slider + pin switch are cross-wired: flipping pin locks
        // the slider to 50% and disables it; flipping back restores the
        // stored scrolloff. Built inline so the two controls can see each
        // other without extra plumbing.
        var soReadout = el('span', { class: 'pdf2html-slider-readout' },
            (pinnedOn ? 50 : curScrollOffPct) + '%');
        var soInput = el('input', {
            type: 'range', class: 'pdf2html-slider-input',
            min: '0', max: '50', step: '1',
            value: String(pinnedOn ? 50 : curScrollOffPct),
        });
        if (pinnedOn) soInput.disabled = true;
        soInput.addEventListener('input', function () {
            var v = parseInt(soInput.value, 10);
            soReadout.textContent = v + '%';
            setInputValueAndFire('pdf2html-scrolloff-input', v);
        });
        var soWrap = el('div', { class: 'pdf2html-slider-wrap' });
        soWrap.appendChild(soInput);
        soWrap.appendChild(soReadout);

        var pinSwitchOnToggle = function (on) {
            setCheckboxAndFire('pdf2html-pinned-input', on);
            soInput.disabled = on;
            if (on) {
                soInput.value = '50';
                soReadout.textContent = '50%';
            } else {
                var stored = Math.round(scrollOffFraction * 100);
                soInput.value = String(stored);
                soReadout.textContent = stored + '%';
            }
        };

        body.appendChild(makeGroup('Behavior', [
            makeRow('Render all pages', ':all · heavy for long docs',
                makeSwitch(renderAllOn, function (on) {
                    setCheckboxAndFire('pdf2html-all-input', on);
                })),
            makeRow('Page counter visible', 'Top pill; toggles with ⌘⇧. or :counter',
                makeSwitch(counterVis, function (on) {
                    var isHidden = document.body.classList.contains('pageno-hidden');
                    if ((on && isHidden) || (!on && !isHidden)) {
                        if (window.__pdf2htmlTogglePageno) window.__pdf2htmlTogglePageno();
                    }
                })),
            makeRow('Render buffer', 'Pages kept rendered ±N around viewport',
                makeSeg([
                    { value: 5,  label: '±5'  },
                    { value: 10, label: '±10' },
                    { value: 20, label: '±20' },
                    { value: 50, label: '±50' },
                    { value: 100, label: '±100' },
                ], curBuffer, function (v) {
                    setInputValueAndFire('pdf2html-buffer-input', v);
                })),
            makeRow('Scrolloff', 'Auto-scroll when cursor enters ±N% band',
                soWrap),
            makeRow('Pin cursor to center', ':pin · locks scrolloff to 50%',
                makeSwitch(pinnedOn, pinSwitchOnToggle)),
            makeRow('Case-sensitive search', ':case · / matches exact casing',
                makeSwitch(caseOn, function (on) {
                    if (window.__pdf2htmlSetSearchCase) window.__pdf2htmlSetSearchCase(on);
                })),
        ]));

        // --- Keyboard --------------------------------------------------
        var escOn = localStorage.getItem('pdf2html-esc-clears') !== '0';

        body.appendChild(makeGroup('Keyboard', [
            makeRow('Leader key', 'Space (reserved for future mappings)',
                el('div', { class: 'pdf2html-kbd' }, 'Space')),
            makeRow('Escape clears selection', 'Esc on non-overlay clears text selection',
                makeSwitch(escOn, function (on) {
                    if (window.__pdf2htmlSetEscClears) window.__pdf2htmlSetEscClears(on);
                })),
        ]));

        card.appendChild(body);
        bd.appendChild(card);
        document.body.appendChild(bd);
    }

    function makeGroup(title, rows) {
        var g = el('div', { class: 'pdf2html-settings-group' });
        g.appendChild(el('h4', {}, title));
        rows.forEach(function (r) { g.appendChild(r); });
        return g;
    }
    function makeRow(label, hint, control) {
        return el('div', { class: 'pdf2html-settings-row' }, [
            el('div', {}, [
                el('div', { class: 'label' }, label),
                hint ? el('div', { class: 'hint' }, hint) : null,
            ].filter(Boolean)),
            control,
        ]);
    }
    function makeSeg(opts, current, onPick) {
        var s = el('div', { class: 'pdf2html-seg' });
        opts.forEach(function (o) {
            var btn = el('button', {
                class: (o.value === current) ? 'active' : '',
                onClick: function () {
                    var all = s.querySelectorAll('button');
                    for (var k = 0; k < all.length; k++) all[k].classList.remove('active');
                    btn.classList.add('active');
                    onPick(o.value);
                },
            }, o.label);
            s.appendChild(btn);
        });
        return s;
    }
    function makeSwitch(on, onToggle) {
        var sw = el('button', {
            type: 'button',
            class: 'pdf2html-switch' + (on ? ' on' : ''),
            role: 'switch',
            'aria-checked': on ? 'true' : 'false',
        });
        sw.addEventListener('click', function () {
            var v = !sw.classList.contains('on');
            sw.classList.toggle('on', v);
            sw.setAttribute('aria-checked', v ? 'true' : 'false');
            onToggle(v);
        });
        return sw;
    }
    function makeSliderWithValue(min, max, step, val, onChange) {
        var wrap = el('div', { class: 'pdf2html-slider-wrap' });
        var readout = el('span', { class: 'pdf2html-slider-readout' }, formatSlider(val));
        var inp = el('input', {
            type: 'range', class: 'pdf2html-slider-input',
            min: String(min), max: String(max), step: String(step), value: String(val),
        });
        inp.addEventListener('input', function () {
            var v = parseFloat(inp.value);
            readout.textContent = formatSlider(v);
            onChange(v);
        });
        wrap.appendChild(inp);
        wrap.appendChild(readout);
        return wrap;
    }
    function formatSlider(v) { return (Math.round(v * 10) / 10).toFixed(1) + '×'; }

    function setCheckboxAndFire(id, val) {
        var cb = document.getElementById(id);
        if (!cb) return;
        cb.checked = !!val;
        cb.dispatchEvent(new Event('change'));
    }


    // ------------------------------------------------------------------------
    // Default zoom — pdf2htmlEX emits pages at the PDF's native size (~595px
    // wide for A4), which leaves huge margins on a modern wide viewport.
    // Apply a CSS `zoom` to #page-container on load so the default view
    // fills more of the screen, closer to Chrome's fit-to-width. Persist to
    // localStorage; tweak via `:zoom 1.8` palette command.
    // ------------------------------------------------------------------------
    function mountZoom() {
        var pc = document.getElementById('page-container');
        if (!pc) return;
        var raw = localStorage.getItem('pdf2html-zoom');
        var z = raw !== null ? parseFloat(raw) : 1.4;
        if (!isFinite(z) || z <= 0) z = 1.4;
        pc.style.zoom = String(z);

        window.__pdf2htmlSetZoom = function (n) {
            if (!isFinite(n) || n <= 0 || n > 10) return;
            pc.style.zoom = String(n);
            localStorage.setItem('pdf2html-zoom', String(n));
        };
    }


    // ------------------------------------------------------------------------
    // Neutralize pdf2htmlEX's own render loop.
    // It's a setTimeout-driven loop that touches .pc inline styles on scroll,
    // which causes paint flashing now that we manage visibility ourselves.
    // ------------------------------------------------------------------------
    function killPdf2htmlExRenderLoop() {
        function kill(v) {
            try {
                if (v.render_timer) clearTimeout(v.render_timer);
                v.render_timer = null;
                v.render = function () {};
                return true;
            } catch (e) { return false; }
        }
        function attempt() {
            return window.pdf2htmlEX
                && window.pdf2htmlEX.defaultViewer
                && kill(window.pdf2htmlEX.defaultViewer);
        }
        if (attempt()) return;
        var n = 0;
        var iv = setInterval(function () {
            if (attempt() || ++n > 100) clearInterval(iv);
        }, 20);
    }


    // ------------------------------------------------------------------------
    // Floating ☰ button top-left — click or ⌘. / ⌘B toggles sidebar.
    // ------------------------------------------------------------------------
    function mountSidebarToggleButton() {
        var b = document.createElement('button');
        b.id = 'pdf2html-toggle';
        b.title = 'Toggle sidebar (⌘. or ⌘B)';
        // Same SVG as the in-sidebar close button — one visual language
        // for "the sidebar affordance" whether it's open or closed.
        b.innerHTML = svgIcon(ICONS.sidebar, 16);
        b.onclick = function () { document.body.classList.toggle('sidebar-shown'); };
        document.body.appendChild(b);
    }

    function registerSidebarKeyHandler() {
        document.addEventListener('keydown', function (e) {
            if (isInputTarget(e.target)) return;
            // `!e.shiftKey` matters: ⌘⇧. is the page-counter toggle and on
            // some layouts (e.g. Norwegian) e.key still reads '.' with
            // shift held, so without this guard both handlers fire.
            if (e.metaKey && !e.shiftKey && (e.key === '.' || e.key === 'b' || e.key === 'B')) {
                e.preventDefault();
                document.body.classList.toggle('sidebar-shown');
                return;
            }
            if (e.key === 'Tab'
                && !e.metaKey && !e.ctrlKey && !e.altKey
                && document.body.classList.contains('sidebar-shown')
                && !document.getElementById('pdf2html-palette')
                && !document.getElementById('pdf2html-finder')
                && !document.getElementById('pdf2html-settings')
                && !document.getElementById('pdf2html-cheatsheet')) {
                e.preventDefault();
                if (window.__pdf2htmlToggleScrollFocus) window.__pdf2htmlToggleScrollFocus();
                return;
            }
            // ←/→ (and h/l) switch tabs when the sidebar is open. Guarded on
            // sidebar-shown so arrows keep their default (scroll) behavior when
            // it's closed; h/l are guarded the same way so Vimium's own
            // bindings on those keys are untouched outside the sidebar.
            var leftKey  = e.key === 'ArrowLeft'  || e.key === 'h';
            var rightKey = e.key === 'ArrowRight' || e.key === 'l';
            if ((leftKey || rightKey)
                && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey
                && document.body.classList.contains('sidebar-shown')) {
                e.preventDefault();
                setSidebarTab(leftKey ? 'outline' : 'thumbs');
            }
        });
    }


    // ------------------------------------------------------------------------
    // Focus routing — scope Vimium's j/k to whichever overlay is open.
    //
    // Vimium tracks a separate `activatedElement` (its own notion of "what
    // j/k scrolls"), NOT document.activeElement. It updates activatedElement
    // only on DOMActivate (Chromium) or click (Firefox) — see Vimium's
    // scroller.js Scroller.init. So calling .focus() on a scroller has zero
    // effect on Vimium's scrolling behavior.
    //
    // To scope j/k to a container we must dispatch a DOMActivate (+ click,
    // for Firefox parity) on it. activate() below does all three: focus for
    // native keyboard nav (Tab/arrow-scroll), DOMActivate + click for Vimium.
    //
    // Declarative routing via MutationObserver avoids wrapping every open/
    // close call site (sidebar toggles live in 5+ places; modals close via
    // Esc, backdrop click, and toggle keys). The observer reacts to the
    // canonical state change — body.sidebar-shown toggling, modal nodes
    // added/removed — so new call sites automatically participate.
    //
    // Modals stash the previously-activated element on open and restore it
    // on close, so closing settings-opened-over-sidebar hands j/k back to
    // the sidebar. Sidebar close re-activates document.body so j/k scrolls
    // the main page.
    //
    // Safety re: synthetic click — backdrop "click outside to close" checks
    // e.target === backdrop, and the scroll containers are either descendants
    // of their backdrop (modals) or on a sibling tree (sidebar vs its
    // backdrop), so bubbling won't trigger a close.
    // ------------------------------------------------------------------------
    function registerFocusRouting() {
        var prevActivation = { settings: null, cheatsheet: null };
        var body = document.body;

        function setScrollFocus(kind) {
            body.setAttribute('data-scroll-focus', kind);
        }
        function activate(el, kind) {
            if (!el) return;
            if (kind) setScrollFocus(kind);
            try { el.focus({ preventScroll: true }); } catch (e) { try { el.focus(); } catch (e2) {} }
            try { el.dispatchEvent(new Event('DOMActivate', { bubbles: true, cancelable: true })); } catch (e) {}
            try { el.dispatchEvent(new MouseEvent('click',   { bubbles: true, cancelable: true })); } catch (e) {}
        }
        function stash(kind) {
            var ae = document.activeElement;
            prevActivation[kind] = (ae && ae !== document.body) ? ae : null;
        }
        // Handing j/k back to the PDF: DOMActivate alone isn't enough (Vimium
        // needs the click too), so we dispatch both, then immediately clear
        // any selection range created by pdf2htmlEX's own click listener on
        // the text layer (the blue glow the user saw is our ::selection color
        // on a tiny range that the click materializes).
        function activateMain() {
            setScrollFocus('main');
            var el = document.getElementById('page-container') || document.body;
            try { el.dispatchEvent(new Event('DOMActivate', { bubbles: true, cancelable: true })); } catch (e) {}
            try { el.dispatchEvent(new MouseEvent('click',   { bubbles: true, cancelable: true })); } catch (e) {}
            try {
                var sel = window.getSelection();
                if (sel && sel.rangeCount > 0) sel.removeAllRanges();
            } catch (e) {}
        }
        function activateSidebar() {
            activate(document.getElementById('pdf2html-sidebar-body'), 'sidebar');
        }
        function restore(kind) {
            var target = prevActivation[kind];
            prevActivation[kind] = null;
            if (target && document.contains(target)) {
                var role = target.id === 'pdf2html-sidebar-body' ? 'sidebar'
                    : (target.id === 'page-container' ? 'main' : null);
                activate(target, role);
            }
            else activateMain();
        }

        window.__pdf2htmlFocusMain = activateMain;
        window.__pdf2htmlFocusSidebar = activateSidebar;
        window.__pdf2htmlToggleScrollFocus = function () {
            if (!body.classList.contains('sidebar-shown')) return;
            if (body.getAttribute('data-scroll-focus') === 'sidebar') activateMain();
            else activateSidebar();
        };

        var pc = document.getElementById('page-container');
        if (pc) pc.addEventListener('mousedown', function () {
            if (body.classList.contains('sidebar-shown')) activateMain();
        });
        var sidebarBody = document.getElementById('pdf2html-sidebar-body');
        if (sidebarBody) sidebarBody.addEventListener('mousedown', function () {
            if (body.classList.contains('sidebar-shown')) activateSidebar();
        });

        // Sidebar: body.sidebar-shown is the canonical "visible" signal.
        var wasShown = body.classList.contains('sidebar-shown');
        new MutationObserver(function () {
            var isShown = body.classList.contains('sidebar-shown');
            if (isShown === wasShown) return;
            wasShown = isShown;
            if (isShown) {
                activateSidebar();
            } else {
                // Hand j/k back to the PDF scroller.
                activateMain();
            }
        }).observe(body, { attributes: true, attributeFilter: ['class'] });

        // Modals: react to addition/removal of the backdrop nodes.
        new MutationObserver(function (mutations) {
            mutations.forEach(function (m) {
                for (var i = 0; i < m.addedNodes.length; i++) {
                    var n = m.addedNodes[i];
                    if (!(n instanceof HTMLElement)) continue;
                    if (n.id === 'pdf2html-settings') {
                        stash('settings');
                        activate(n.querySelector('.pdf2html-settings-body'));
                    } else if (n.id === 'pdf2html-cheatsheet') {
                        stash('cheatsheet');
                        activate(n.querySelector('.pdf2html-cheatsheet-body'));
                    }
                }
                for (var j = 0; j < m.removedNodes.length; j++) {
                    var r = m.removedNodes[j];
                    if (!(r instanceof HTMLElement)) continue;
                    if (r.id === 'pdf2html-settings') restore('settings');
                    else if (r.id === 'pdf2html-cheatsheet') restore('cheatsheet');
                }
            });
        }).observe(body, { childList: true });

        setScrollFocus(body.classList.contains('sidebar-shown') ? 'sidebar' : 'main');
    }


    // ------------------------------------------------------------------------
    // Escape: priority chain — palette → cheatsheet → clear selection.
    // Capture phase, since Vimium also listens for Escape.
    // ------------------------------------------------------------------------
    function registerEscapeHandler() {
        document.addEventListener('keydown', function (e) {
            if (e.key !== 'Escape') return;
            var fnd = document.getElementById('pdf2html-finder');
            if (fnd) { e.preventDefault(); e.stopPropagation(); fnd.remove(); return; }
            var pal = document.getElementById('pdf2html-palette');
            if (pal) { e.preventDefault(); e.stopPropagation(); pal.remove(); return; }
            if (fingerState) { e.preventDefault(); e.stopPropagation(); closeFingerMode(); return; }
            if (isInputTarget(e.target)) return;
            var settings = document.getElementById('pdf2html-settings');
            if (settings) { settings.remove(); return; }
            var cs = document.getElementById('pdf2html-cheatsheet');
            if (cs) { cs.remove(); return; }
            if (document.body.classList.contains('sidebar-shown')) {
                document.body.classList.remove('sidebar-shown');
                return;
            }
            if (localStorage.getItem('pdf2html-esc-clears') === '0') return;
            var sel = window.getSelection();
            if (sel && !sel.isCollapsed) sel.removeAllRanges();
        }, true);
    }


    // ------------------------------------------------------------------------
    // Cheatsheet overlay — ? toggles, :help invokes.
    // ------------------------------------------------------------------------
    function toggleCheatsheet() {
        var ex = document.getElementById('pdf2html-cheatsheet');
        if (ex) { ex.remove(); return; }
        var bg = document.createElement('div');
        bg.id = 'pdf2html-cheatsheet';
        bg.innerHTML = cheatsheetHTML();
        bg.addEventListener('click', function (ev) { if (ev.target === bg) bg.remove(); });
        document.body.appendChild(bg);
    }

    // Cheatsheet markup — grouped card, two columns:
    //   left = Viewer + Modes + Vimium + sidebar controls
    //   right = command palette reference
    // Each row uses kbd chips (.pdf2html-kbd) for keys; commands get an aligned
    // cmd/alias pair. Keep every command listed here in sync with the COMMANDS
    // table below so the palette + help stay consistent.
    function cheatsheetHTML() {
        function keysHtml(groups) {
            return groups.map(function (group, gi) {
                var chips = group.map(function (k) {
                    return '<span class="pdf2html-kbd">' + escapeHtml(k) + '</span>';
                }).join('');
                return (gi > 0 ? '<span class="sep-or">or</span>' : '') + chips;
            }).join('');
        }
        function kRow(groups, desc) {
            return '<div class="pdf2html-cheatsheet-row">'
                + '<span class="keys">' + keysHtml(groups) + '</span>'
                + '<span class="desc">' + escapeHtml(desc) + '</span>'
                + '</div>';
        }
        function cRow(cmd, alias, desc) {
            var aliasHtml = (alias && alias !== '—')
                ? '<span class="alias">' + escapeHtml(alias) + '</span>' : '';
            return '<div class="pdf2html-cheatsheet-row">'
                + '<span class="cmd">' + escapeHtml(cmd) + aliasHtml + '</span>'
                + '<span class="desc">' + escapeHtml(desc) + '</span>'
                + '</div>';
        }
        return '<div id="pdf2html-cheatsheet-panel">'
            + '<div class="pdf2html-cheatsheet-head">'
                + '<div>'
                    + '<div class="title">Keyboard reference</div>'
                    + '<div class="subtitle">Comet PDF viewer</div>'
                + '</div>'
                + '<span class="close">'
                    + '<span class="pdf2html-kbd sm">?</span> or '
                    + '<span class="pdf2html-kbd sm">Esc</span> to close'
                + '</span>'
            + '</div>'
                + '<div class="pdf2html-cheatsheet-body" tabindex="-1">'
                + '<div class="pdf2html-cheatsheet-section">'
                    + '<h3>Viewer</h3>'
                    + kRow([['⌘','.'], ['⌘','B']], 'Toggle sidebar')
                    + kRow([['Tab']], 'Sidebar open: toggle j/k focus between sidebar and main PDF')
                    + kRow([['Ctrl','J'], ['Ctrl','K'], ['↓'], ['↑']], 'Sidebar: move Outline / Pages selector')
                    + kRow([['←','h'], ['→','l']], 'Sidebar: Outline / Pages tab (when open)')
                    + kRow([['A']], 'Toggle render-all pages')
                    + kRow([['e'], ['q'], ['E']], 'Next / prev page; active text selection extends pagewise instead')
                    + kRow([['c'], ['C']], 'Next / prev chapter; active browser selection + c selects full chapter')
                    + kRow([['⌘','⇧','.']], 'Toggle page counter')
                    + '<h3>Modes</h3>'
                    + kRow([[':']], 'Command palette (Tab / ^J / ^K to cycle)')
                    + kRow([['⌘','K']], 'Quick-open another cached doc')
                    + kRow([['⌘',',']], 'Open settings')
                    + kRow([['Ctrl','f']], 'Finger visible tokens; hint copies token')
                    + kRow([['/'], ['s']], 'Find in visible pages (Enter to jump, n/N to cycle)')
                    + kRow([[':','f']], 'Finger visible tokens; hint copies token')
                    + kRow([['?']], 'Toggle this cheatsheet')
                    + kRow([['Esc']], 'Close overlay / clear selection')
                    + '<h3>Vimium (external)</h3>'
                    + kRow([['v']], 'Visual mode (extend with j/k/w/b)')
                    + kRow([['m','{a-z}'], ["'", '{a-z}']], 'Set / jump to bookmark')
                    + kRow([['g','g'], ['G']], 'Top / bottom of document')
                    + kRow([['z','i'], ['z','o'], ['z','0']], 'Zoom in / out / reset')
                    + '<h3>Sidebar controls</h3>'
                    + '<div class="pdf2html-cheatsheet-row"><span class="cmd">Render all</span><span class="desc">Force every page visible (inflates find)</span></div>'
                    + '<div class="pdf2html-cheatsheet-row"><span class="cmd">Render ±N</span><span class="desc">Pages kept in DOM around viewport</span></div>'
                    + '<div class="pdf2html-cheatsheet-row"><span class="cmd">Scrolloff N%</span><span class="desc">Auto-scroll band; Pin toggle locks at 50%</span></div>'
                + '</div>'
                + '<div class="pdf2html-cheatsheet-section">'
                    + '<h3>Commands · type : to begin</h3>'
                    + cRow(':42', '—', 'Goto page 42 (bare number)')
                    + cRow(':page N', ':p', 'Goto page N')
                    + cRow(':chapter <name>', '—', 'Jump to chapter by name (Tab to pick)')
                    + cRow(':next', '—', 'Next chapter')
                    + cRow(':prev', '—', 'Prev chapter (or chapter start if mid-chapter)')
                    + cRow(':mark <a-z>', '—', 'Bookmark current page (persists across reloads)')
                    + cRow(':jump <a-z>', '—', 'Jump to bookmark')
                    + cRow(':clear <a-z>', '—', 'Delete a bookmark')
                    + cRow(':open <doc>', ':o', 'Open another cached doc')
                    + cRow(':pin', '—', 'Toggle pin-to-center')
                    + cRow(':scrolloff N', ':so', 'Scrolloff band at N% (e.g. :so 25)')
                    + cRow(':buffer N', ':buf', 'Render ±N pages around viewport')
                    + cRow(':all', '—', 'Toggle render-all pages')
                    + cRow(':yank <kind>', ':y', 'Copy ref / page / chapter / document')
                    + cRow(':finger', ':f', 'Hint visible URL / DOI / ISBN / ID tokens')
                    + cRow(':counter', ':num', 'Toggle page counter')
                    + cRow(':zoom N', '—', 'Set page-container zoom')
                    + cRow(':help', ':h', 'Open this cheatsheet')
                + '</div>'
            + '</div>'
            + '</div>';
    }

    function escapeHtml(s) {
        return String(s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function registerQuestionHandler() {
        document.addEventListener('keydown', function (e) {
            if (e.key !== '?') return;
            if (isInputTarget(e.target)) return;
            e.preventDefault(); e.stopPropagation();
            toggleCheatsheet();
        }, true);
    }


    // ------------------------------------------------------------------------
    // Command palette — : opens a vim-like ex-bar at the bottom, with
    // nvim wildmenu-style autocomplete: Tab cycles matches, Shift+Tab
    // reverses, commands + arguments are both completable.
    //
    // COMMANDS is the single source of truth for both the dispatcher and
    // the completer. Extend by pushing a new entry here — one line per
    // command, one line in the cheatsheet, done.
    // ------------------------------------------------------------------------
    // Prefix filter used by numeric arg completers. Case-insensitive. Completers
    // own their filtering (empty tail = return everything) so the `chapter` completer
    // can do substring matching without the outer filter fighting it.
    function prefixFilter(list, tail) {
        var lt = String(tail || '').toLowerCase();
        return list.filter(function (a) { return String(a).toLowerCase().indexOf(lt) === 0; });
    }

    // Library — list of all cached docs for `:open`. Daemon returns the
    // full set sorted by zoxide-style frecency. The palette filters that
    // ordered corpus without letting text-match score reorder it.
    var OPEN_COMPLETION_LIMIT = 30;
    var currentLibraryHash = entryHash();
    var libraryEntries = null;
    function loadLibrary() {
        if (libraryEntries !== null) return;
        fetch('/library', { cache: 'no-store' })
            .then(function (r) { return r.ok ? r.json() : []; })
            .catch(function () { return []; })
            .then(function (d) { libraryEntries = Array.isArray(d) ? d : []; });
    }

    // Relative age label ("3h", "2d", "12m"). Returns '' when we have no
    // visit record yet.
    function recencyLabel(entry) {
        var n = entry && entry.rank != null ? entry.rank : (entry && entry.count);
        if (!entry || !entry.last_seen) return n ? n + 'x' : '';
        var ageSec = (Date.now() / 1000) - entry.last_seen;
        var ago;
        if (ageSec < 60) ago = 'now';
        else if (ageSec < 3600) ago = Math.round(ageSec / 60) + 'm';
        else if (ageSec < 86400) ago = Math.round(ageSec / 3600) + 'h';
        else ago = Math.round(ageSec / 86400) + 'd';
        return n + 'x · ' + ago;
    }

    function normalizeOpenQuery(s) {
        return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
    }

    function librarySearchText(entry) {
        if (!entry) return '';
        if (entry.search_text) return normalizeOpenQuery(entry.search_text);
        return normalizeOpenQuery([entry.name, entry.source_ref].filter(Boolean).join(' '));
    }

    function libraryEntryMatches(entry, query) {
        var q = normalizeOpenQuery(query);
        if (!q) return true;
        var text = librarySearchText(entry);
        var tokens = q.split(' ');
        for (var i = 0; i < tokens.length; i++) {
            if (text.indexOf(tokens[i]) === -1) return false;
        }
        return true;
    }

    function isCurrentLibraryEntry(entry) {
        return !!(currentLibraryHash && entry && entry.hash === currentLibraryHash);
    }

    function completeLibraryEntries(tail) {
        if (!libraryEntries) return [];
        var out = [];
        for (var i = 0; i < libraryEntries.length; i++) {
            var e = libraryEntries[i];
            if (isCurrentLibraryEntry(e)) continue;
            if (!libraryEntryMatches(e, tail)) continue;
            out.push(e);
            if (out.length >= OPEN_COMPLETION_LIMIT) break;
        }
        // Daemon sends best-first. Reverse only the rendered window so the
        // best match sits at the BOTTOM of the wildmenu, closest to the caret.
        return out.reverse();
    }

    function openLibraryEntry(needle) {
        if (!needle || !libraryEntries || !libraryEntries.length) return;
        var n = needle.toLowerCase().trim();
        var exact = null, sub = null;
        for (var i = 0; i < libraryEntries.length; i++) {
            if (isCurrentLibraryEntry(libraryEntries[i])) continue;
            var name = (libraryEntries[i].name || '').toLowerCase();
            if (name === n) { exact = libraryEntries[i]; break; }
            if (!sub && name.indexOf(n) !== -1) sub = libraryEntries[i];
        }
        var pick = exact || sub || completeLibraryEntries(needle).slice(-1)[0];
        if (pick && pick.href) location.href = pick.href;
    }

    // Marks — persistent bookmarks keyed by hash + single letter.
    // Vimium's `m`/`'` don't survive reloads; these do. Writes only happen
    // at user intent (`:mark x`), so the storage footprint is tiny.
    function marksKey() {
        var h = entryHash();
        return h ? 'pdf2html-marks:' + h : null;
    }

    function loadMarks() {
        var k = marksKey();
        if (!k) return {};
        try { return JSON.parse(localStorage.getItem(k) || '{}') || {}; }
        catch (_) { return {}; }
    }

    function saveMarks(m) {
        var k = marksKey();
        if (!k) return;
        try { localStorage.setItem(k, JSON.stringify(m)); } catch (_) {}
    }

    // Letter parser — accept first a-z char, normalize to lowercase. Lets
    // the user type `:mark A` or `:mark apple`; only the `a` is used.
    function markLetter(s) {
        if (!s) return null;
        var m = String(s).trim().match(/^([a-zA-Z])/);
        return m ? m[1].toLowerCase() : null;
    }

    function setMark(arg) {
        var letter = markLetter(arg);
        if (!letter) return;
        var marks = loadMarks();
        marks[letter] = {
            page: currentPage,
            label: currentChapterLabel(),
            ts: Date.now(),
        };
        saveMarks(marks);
    }

    function gotoMark(arg) {
        var letter = markLetter(arg);
        if (!letter) return;
        var marks = loadMarks();
        var m = marks[letter];
        if (m && m.page) gotoPage(m.page);
    }

    function clearMark(arg) {
        var letter = markLetter(arg);
        if (!letter) return;
        var marks = loadMarks();
        if (!marks[letter]) return;
        delete marks[letter];
        saveMarks(marks);
    }

    // Chapter-relative navigation. Uses the full outline (incl. subsections)
    // as "section boundaries" — same mental model as vim's `]]` / `[[`.
    // `:prev` has two modes: if we're deeper than NEAR_THRESHOLD pages into
    // the current section, go to the section's start; otherwise go to the
    // previous section. Threshold keeps the UX forgiving when the user is
    // slightly past a heading.
    var CHAPTER_NEAR_THRESHOLD = 2;

    function sortedChapterPages() {
        var chaps = getChapters();
        chaps.sort(function (a, b) { return a.page - b.page; });
        var seen = {};
        return chaps.filter(function (c) {
            if (seen[c.page]) return false;
            seen[c.page] = true;
            return true;
        });
    }

    // Step by N chapters from the current reading position. Positive delta =
    // forward, negative = backward. `delta === -1` keeps a threshold
    // forgiveness: if we're >= NEAR_THRESHOLD pages into the current section,
    // backtrack to its start rather than the previous section. Multi-step
    // backward jumps (|delta| >= 2) skip that rule — a user asking for "-3"
    // wants three section boundaries, not two. Uses snapToPage for flush
    // alignment, matching the e/E page-step feel. Also the backing function
    // for the `:next` / `:prev` palette commands.
    function gotoChapterBy(delta) {
        var chaps = sortedChapterPages();
        if (!chaps.length || !delta) return;
        var idx = -1;
        for (var i = 0; i < chaps.length; i++) {
            if (chaps[i].page <= currentPage) idx = i; else break;
        }
        var target;
        if (delta > 0) {
            target = (idx === -1 ? 0 : idx + delta);
        } else if (delta === -1) {
            if (idx === -1) return;
            var offset = currentPage - chaps[idx].page;
            target = (offset >= CHAPTER_NEAR_THRESHOLD) ? idx : idx - 1;
        } else {
            if (idx === -1) return;
            target = idx + delta;
        }
        target = Math.min(chaps.length - 1, Math.max(0, target));
        snapToPage(chaps[target].page);
    }

    // Pull current outline entries. Re-read on each palette open so that
    // late-mounted outlines and user-navigated state both work.
    function getChapters() {
        var links = document.querySelectorAll('#outline a[href^="#pf"]');
        var out = [];
        for (var i = 0; i < links.length; i++) {
            var a = links[i];
            var m = (a.getAttribute('href') || '').match(/#pf([0-9a-f]+)/i);
            if (!m) continue;
            var label = (a.textContent || '').replace(/\s+/g, ' ').trim();
            if (!label) continue;
            out.push({ label: label, page: parseInt(m[1], 16) });
        }
        return out;
    }

    var COMMANDS = [
        { name: 'page',    aliases: ['p'],    desc: 'goto page N',
          requiresArg: true,
          argCompleter: null,
          handler: function (a) { if (a) gotoPage(parseInt(a, 10)); } },
        { name: 'chapter', aliases: [],       desc: 'goto chapter by name',
          argCompleter: function (tail) {
              var lt = String(tail || '').toLowerCase().trim();
              var chaps = getChapters();
              var matched = lt ? chaps.filter(function (c) {
                  return c.label.toLowerCase().indexOf(lt) !== -1;
              }) : chaps;
              return matched.map(function (c) {
                  return {
                      value: 'chapter ' + c.label,
                      display: c.label,
                      alias: 'p. ' + c.page,
                      desc: '',
                      rawDisplay: true,
                  };
              });
          },
          handler: function (a) { gotoChapter(a); } },
        { name: 'mark',    aliases: [],       desc: 'bookmark current page as <letter>',
          argCompleter: function (tail) {
              var marks = loadMarks();
              var lt = markLetter(tail) || '';
              // z → a so the most-reached letter ('a' on a home-row hand)
              // sits at the bottom of the wildmenu, closest to the caret.
              var letters = 'zyxwvutsrqponmlkjihgfedcba'.split('');
              if (lt) letters = [lt];
              return letters.map(function (L) {
                  var m = marks[L];
                  var preview = m
                      ? 'p. ' + m.page + (m.label ? ' · ' + m.label : '')
                      : '—';
                  return {
                      value: 'mark ' + L,
                      display: L + '  ·  ' + preview,
                      alias: m ? 'set' : '',
                      rawDisplay: true,
                  };
              });
          },
          handler: function (a) { setMark(a); } },
        { name: 'jump',    aliases: [],       desc: 'jump to mark <letter>',
          argCompleter: function (tail) {
              var marks = loadMarks();
              var lt = markLetter(tail);
              // Most recently set mark last (bottom = closest to caret).
              var letters = Object.keys(marks).sort(function (a, b) {
                  return (marks[a].ts || 0) - (marks[b].ts || 0);
              });
              if (lt) letters = letters.filter(function (L) { return L === lt; });
              return letters.map(function (L) {
                  var m = marks[L];
                  return {
                      value: 'jump ' + L,
                      display: L + '  ·  p. ' + m.page + (m.label ? ' · ' + m.label : ''),
                      alias: '',
                      rawDisplay: true,
                  };
              });
          },
          handler: function (a) { gotoMark(a); } },
        { name: 'clear',   aliases: [],       desc: 'delete mark <letter>',
          argCompleter: function (tail) {
              var marks = loadMarks();
              var lt = markLetter(tail);
              // Most recently set last — mirrors `:jump` ordering.
              var letters = Object.keys(marks).sort(function (a, b) {
                  return (marks[a].ts || 0) - (marks[b].ts || 0);
              });
              if (lt) letters = letters.filter(function (L) { return L === lt; });
              return letters.map(function (L) {
                  var m = marks[L];
                  return {
                      value: 'clear ' + L,
                      display: L + '  ·  p. ' + m.page + (m.label ? ' · ' + m.label : ''),
                      alias: '',
                      rawDisplay: true,
                  };
              });
          },
          handler: function (a) { clearMark(a); } },
        { name: 'pin',     aliases: [],
          desc: function () {
              return 'turn pin-to-center ' + (localStorage.getItem('pdf2html-pinned') !== '0' ? 'OFF' : 'ON');
          },
          argCompleter: null,
          handler: function () { toggleCheckboxAndFire('pdf2html-pinned-input'); } },
        { name: 'scrolloff', aliases: ['so'], desc: 'scrolloff N% (0-50)',
          argCompleter: function (tail) { return prefixFilter(['0', '10', '25', '33', '50'], tail); },
          handler: function (a) { if (a !== undefined) setInputValueAndFire('pdf2html-scrolloff-input', parseInt(a, 10)); } },
        { name: 'buffer',  aliases: ['buf'],  desc: 'render ±N pages',
          argCompleter: function (tail) { return prefixFilter(['5', '10', '20', '50'], tail); },
          handler: function (a) { if (a !== undefined) setInputValueAndFire('pdf2html-buffer-input', parseInt(a, 10)); } },
        { name: 'all',     aliases: [],
          desc: function () {
              return 'turn render-all ' + (localStorage.getItem('pdf2html-render-all') === '1' ? 'OFF' : 'ON');
          },
          argCompleter: null,
          handler: function () { toggleCheckboxAndFire('pdf2html-all-input'); } },
        { name: 'yank',    aliases: ['y'],    desc: 'copy content (ref/page/chapter/doc)',
          argCompleter: function (tail) {
              // Order: ref → document → chapter → page. Reversed in spirit
              // with the project's "priority at the bottom" convention —
              // `page` (the narrowest, most-frequent selection) sits last,
              // so `:y<space><Enter>` yanks just the current page.
              var options = [
                  { value: 'yank ref',      display: 'ref',      desc: 'chapter · p. N (meta)' },
                  { value: 'yank document', display: 'document', desc: 'full document text' },
                  { value: 'yank chapter',  display: 'chapter',  desc: 'current chapter text' },
                  { value: 'yank page',     display: 'page',     desc: 'current page text' },
              ];
              var lt = String(tail || '').toLowerCase().trim();
              if (!lt) return options;
              return options.filter(function (o) {
                  return o.display.indexOf(lt) === 0;
              });
          },
          handler: function (a) { dispatchYank(a); } },
        { name: 'finger',  aliases: ['f'],    desc: 'hint visible URL/DOI/ISBN/ID tokens',
          argCompleter: null,
          handler: function () { openFingerMode(); } },
        { name: 'counter', aliases: ['num'],
          desc: function () {
              return (document.body.classList.contains('pageno-hidden') ? 'show' : 'hide') + ' page counter';
          },
          argCompleter: null,
          handler: function () { if (window.__pdf2htmlTogglePageno) window.__pdf2htmlTogglePageno(); } },
        { name: 'case',    aliases: [],
          desc: function () {
              return 'turn case-sensitive search ' + (isSearchCaseSensitive() ? 'OFF' : 'ON');
          },
          argCompleter: null,
          handler: function () {
              if (window.__pdf2htmlSetSearchCase) window.__pdf2htmlSetSearchCase(!isSearchCaseSensitive());
          } },
        // `next`/`prev` are ordered AFTER `counter` so that `:n<Enter>` —
        // which prefix-matches both `counter` (via alias `num`) and `next` —
        // auto-selects `next` (state.idx = last match in COMMANDS order).
        // Same logic puts `prev` after `pin` so `:p<Enter>` lands on prev.
        { name: 'next',    aliases: [],       desc: 'next chapter',
          argCompleter: null,
          handler: function () { gotoChapterBy(1); } },
        { name: 'prev',    aliases: [],       desc: 'prev chapter (or chapter start)',
          argCompleter: null,
          handler: function () { gotoChapterBy(-1); } },
        { name: 'zoom',    aliases: [],       desc: 'set zoom N',
          argCompleter: function (tail) { return prefixFilter(['1.0', '1.2', '1.4', '1.6', '1.8', '2.0', '2.5'], tail); },
          handler: function (a) { if (a !== undefined && window.__pdf2htmlSetZoom) window.__pdf2htmlSetZoom(parseFloat(a)); } },
        { name: 'open',    aliases: ['o'],    desc: 'open another cached doc',
          argCompleter: function (tail) {
              var matched = completeLibraryEntries(tail);
              return matched.map(function (e) {
                  return {
                      value: 'open ' + e.name,
                      display: e.name,
                      alias: recencyLabel(e),
                      rawDisplay: true,
                  };
              });
          },
          handler: function (a) { openLibraryEntry(a); } },
        { name: 'help',    aliases: ['h'],    desc: 'show cheatsheet',
          argCompleter: null,
          handler: function () { toggleCheatsheet(); } },
        { name: 'set',     aliases: [],       desc: 'open settings',
          argCompleter: null,
          handler: function () { openSettings(); } },
    ];

    function findCommand(name) {
        if (name == null) return null;
        var n = String(name).toLowerCase();
        for (var i = 0; i < COMMANDS.length; i++) {
            if (COMMANDS[i].name === n || COMMANDS[i].aliases.indexOf(n) !== -1) return COMMANDS[i];
        }
        return null;
    }

    function commandTakesArg(cmd) {
        return !!(cmd && (cmd.argCompleter || cmd.requiresArg));
    }

    function openPalette() {
        var ex = document.getElementById('pdf2html-palette');
        if (ex) { ex.remove(); return; }

        var wrap = document.createElement('div');
        wrap.id = 'pdf2html-palette';

        var completeRow = document.createElement('div');
        completeRow.id = 'pdf2html-palette-complete';
        wrap.appendChild(completeRow);

        var lineRow = document.createElement('div');
        lineRow.id = 'pdf2html-palette-line';
        lineRow.innerHTML =
            '<span id="pdf2html-palette-prompt">:</span>' +
            '<input type="text" id="pdf2html-palette-input" autocomplete="off" ' +
                'spellcheck="false" autocapitalize="off" ' +
                'placeholder="command · Tab to complete · Enter to run">' +
            '<span class="pdf2html-palette-hint">' +
                '<span class="pdf2html-kbd sm">Tab</span>/' +
                '<span class="pdf2html-kbd sm">^J</span>/' +
                '<span class="pdf2html-kbd sm">^K</span> cycle · ' +
                '<span class="pdf2html-kbd sm">Esc</span> close' +
            '</span>';
        wrap.appendChild(lineRow);
        document.body.appendChild(wrap);

        var input = document.getElementById('pdf2html-palette-input');
        var state = { matches: [], idx: -1 };

        function computeMatches() {
            var v = input.value;
            // Empty input → no suggestions. Showing all commands on open
            // feels noisy for a 4h/day UI — palette opens clean, starts
            // suggesting on the first keystroke.
            if (v.length === 0) { state.matches = []; state.idx = -1; return; }
            var firstSpace = v.indexOf(' ');
            if (firstSpace === -1) {
                // Command-name completion — match canonical OR any alias.
                // The wildmenu displays name + alias + desc, so carry all three.
                var commandNeedle = v.toLowerCase();
                state.matches = COMMANDS
                    .filter(function (c) {
                        if (c.name.indexOf(commandNeedle) === 0) return true;
                        return c.aliases.some(function (a) { return a.indexOf(commandNeedle) === 0; });
                    })
                    .map(function (c) {
                        return {
                            value: c.name,
                            display: c.name,
                            alias: c.aliases[0] || '',
                            desc: typeof c.desc === 'function' ? c.desc() : c.desc,
                        };
                    });
            } else {
                // Arg completion — completer owns the filter so `chapter` can
                // substring-match while numeric completers prefix-match.
                var head = v.slice(0, firstSpace);
                var tail = v.slice(firstSpace + 1);
                var cmd = findCommand(head);
                if (cmd && cmd.argCompleter) {
                    var results = cmd.argCompleter(tail) || [];
                    state.matches = results.map(function (a) {
                        if (a && typeof a === 'object') {
                            return {
                                value: a.value != null ? a.value : (head + ' ' + (a.display || '')),
                                display: a.display != null ? String(a.display) : String(a.value || ''),
                                alias: a.alias || '',
                                desc: a.desc != null ? a.desc : (cmd.desc || ''),
                                rawDisplay: !!a.rawDisplay,
                            };
                        }
                        return {
                            value: head + ' ' + a,
                            display: String(a),
                            alias: '',
                            desc: cmd.desc || '',
                        };
                    });
                } else {
                    state.matches = [];
                }
            }
            // Auto-highlight the LAST match — visually the row closest to the
            // input (wildmenu stacks above the input, so the bottom of the
            // list is right next to the caret). Enter runs the highlighted
            // match, so a prefix + Enter completes without Tab.
            state.idx = state.matches.length - 1;
        }

        function renderMatches() {
            completeRow.innerHTML = '';
            if (state.matches.length === 0) {
                completeRow.style.display = 'none';
                return;
            }
            completeRow.style.display = '';
            state.matches.forEach(function (m, i) {
                var row = document.createElement('div');
                row.className = 'pdf2html-palette-match' +
                    (i === state.idx ? ' pdf2html-palette-match-active' : '') +
                    (m.rawDisplay ? ' pdf2html-palette-match--wide' : '');

                var nameEl = document.createElement('span');
                nameEl.className = 'name';
                var label = m.display || m.value;
                nameEl.textContent = m.rawDisplay ? label : (':' + label);

                var aliasEl = document.createElement('span');
                aliasEl.className = 'alias';
                aliasEl.textContent = m.alias
                    ? (m.rawDisplay ? m.alias : ':' + m.alias)
                    : '—';

                var descEl = document.createElement('span');
                descEl.className = 'pdf2html-palette-match-desc';
                descEl.textContent = m.desc || '';

                row.appendChild(nameEl);
                row.appendChild(aliasEl);
                row.appendChild(descEl);

                // Mousedown (not click) so we fire before the input loses focus.
                row.addEventListener('mousedown', function (ev) {
                    ev.preventDefault();
                    acceptMatchOrRun(m);
                });
                completeRow.appendChild(row);
            });
            var active = completeRow.querySelector('.pdf2html-palette-match-active');
            if (active && active.scrollIntoView) {
                active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
            }
        }

        function expandCommandMatch(match) {
            if (!match || input.value.indexOf(' ') !== -1) return false;
            var cmd = findCommand(match.value);
            if (!commandTakesArg(cmd)) return false;
            input.value = cmd.name + ' ';
            computeMatches(); renderMatches();
            return true;
        }

        function acceptMatchOrRun(match) {
            if (expandCommandMatch(match)) return;
            input.value = match && match.value != null ? match.value : input.value;
            runCommand(input.value);
            wrap.remove();
        }

        function cycleMatch(delta) {
            if (state.matches.length === 0) return;
            // Tab on an unambiguous command completion (single match, no
            // space yet) expands straight into arg mode — skips the "Tab
            // then Space" two-step once there's only one command it could
            // be. Multi-match cycling still uses Space/Enter to commit.
            if (state.matches.length === 1 && input.value.indexOf(' ') === -1) {
                if (expandCommandMatch(state.matches[0])) return;
            }
            var n = state.matches.length;
            state.idx = ((state.idx + delta) % n + n) % n;
            // Fill input with the match; don't recompute (we want cycling to
            // stay in the current set of candidates).
            input.value = state.matches[state.idx].value;
            renderMatches();
        }

        input.focus();
        input.addEventListener('input', function () { computeMatches(); renderMatches(); });
        input.addEventListener('keydown', function (ev) {
            if (ev.key === 'Escape') {
                ev.stopPropagation(); ev.preventDefault(); wrap.remove();
            } else if (ev.key === 'Enter') {
                ev.preventDefault();
                // If a match is highlighted (auto-selected bottom row, or
                // Tab-cycled), run *that* — so typing a prefix + Enter
                // expands to the full command. Fall back to the raw input
                // when there's no match (bare `:42`, no-completion args).
                var match = state.idx >= 0 ? state.matches[state.idx] : null;
                acceptMatchOrRun(match);
            } else if (ev.key === 'Tab') {
                ev.preventDefault(); cycleMatch(ev.shiftKey ? -1 : 1);
            } else if (ev.ctrlKey && !ev.metaKey && !ev.altKey
                       && (ev.key === 'j' || ev.key === 'J')) {
                ev.preventDefault(); cycleMatch(1);
            } else if (ev.ctrlKey && !ev.metaKey && !ev.altKey
                       && (ev.key === 'k' || ev.key === 'K')) {
                ev.preventDefault(); cycleMatch(-1);
            } else if (ev.key === 'ArrowDown'
                       && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
                ev.preventDefault(); cycleMatch(1);
            } else if (ev.key === 'ArrowUp'
                       && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
                ev.preventDefault(); cycleMatch(-1);
            } else if (ev.key === ' ' && input.value.indexOf(' ') === -1
                       && state.matches.length > 0) {
                // Space = "I'm done typing the command, let me give an arg."
                // Expand the highlighted match. If multiple commands prefix-
                // match, prefer one that takes an argument (since user just
                // signaled they want to provide one) — this is what makes
                // `:c<space>` land on `chapter` instead of `counter`.
                var pick = null;
                for (var i = 0; i < state.matches.length; i++) {
                    var c = findCommand(state.matches[i].value);
                    if (c && c.argCompleter) { pick = state.matches[i]; break; }
                }
                if (!pick && state.idx >= 0) pick = state.matches[state.idx];
                if (pick) {
                    ev.preventDefault();
                    input.value = pick.value + ' ';
                    computeMatches(); renderMatches();
                }
            }
        });

        // Show all commands by default on open — nvim user already knows
        // what they want, but the discoverable surface is nice for anyone
        // wandering in.
        computeMatches();
        renderMatches();
    }

    function runCommand(raw) {
        var trimmed = raw.trim();
        if (!trimmed) return;
        // Bare number: `:42` = goto page 42
        if (/^\d+$/.test(trimmed)) { gotoPage(parseInt(trimmed, 10)); return; }
        var firstSpace = trimmed.indexOf(' ');
        var head = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
        var tail = firstSpace === -1 ? '' : trimmed.slice(firstSpace + 1).trim();
        var cmd = findCommand(head);
        if (cmd) cmd.handler(tail || undefined);
    }

    function gotoPage(n) {
        if (!n || n < 1) return;
        var el = document.getElementById('pf' + n.toString(16));
        if (el) el.scrollIntoView({ block: 'start' });
    }

    function pageElement(pageNum) {
        if (!pageNum || pageNum < 1) return null;
        return document.getElementById('pf' + pageNum.toString(16));
    }

    function pageNumberFromElement(pf) {
        if (!pf || !pf.id) return null;
        var m = pf.id.match(/^pf([0-9a-f]+)$/i);
        return m ? parseInt(m[1], 16) : null;
    }

    function pageElementFromNode(node) {
        if (!node) return null;
        var el = node.nodeType === 1 ? node : node.parentElement;
        return el && el.closest ? el.closest('.pf') : null;
    }

    function pageNumberFromNode(node) {
        return pageNumberFromElement(pageElementFromNode(node));
    }

    function pageTextBoundaryPosition(pageNum, towardsStart) {
        var pf = pageElement(pageNum);
        if (!pf) return null;
        var pc = pf.querySelector('.pc');
        if (!pc) return null;
        var walker = document.createTreeWalker(pc, NodeFilter.SHOW_TEXT);
        var node, pick = null;
        while ((node = walker.nextNode())) {
            if (!node.nodeValue || node.nodeValue.length === 0) continue;
            pick = node;
            if (towardsStart) break;
        }
        if (!pick) return null;
        return {
            node: pick,
            offset: towardsStart ? 0 : pick.nodeValue.length,
        };
    }

    function ensurePageRangeRendered(startPage, endPage) {
        if (!startPage || !endPage) return;
        var from = Math.min(startPage, endPage);
        var to = Math.max(startPage, endPage);
        for (var p = from; p <= to; p++) {
            var pf = pageElement(p);
            if (pf) setPageForceRendered(pf, true);
        }
    }

    function selectionPageSpan(sel) {
        if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
        var anchorPage = pageNumberFromNode(sel.anchorNode);
        var focusPage = pageNumberFromNode(sel.focusNode);
        if (!anchorPage || !focusPage) return null;
        return {
            start: Math.min(anchorPage, focusPage),
            end: Math.max(anchorPage, focusPage),
            anchor: anchorPage,
            focus: focusPage,
        };
    }

    function extendSelectionByPage(delta) {
        var sel = window.getSelection();
        var span = selectionPageSpan(sel);
        if (!span || !sel || typeof sel.extend !== 'function') return false;
        var total = totalPages();
        if (!total) return false;
        var targetPage = Math.max(1, Math.min(total, span.focus + delta));
        if (targetPage === span.focus) return true;
        var pos = pageTextBoundaryPosition(targetPage, delta > 0);
        if (!pos) return false;
        ensurePageRangeRendered(span.anchor, targetPage);
        document.body.classList.remove('pdf2html-search-entered');
        try {
            sel.extend(pos.node, pos.offset);
            return true;
        } catch (e) {
            return false;
        }
    }

    function chapterRangeForPage(pageNum) {
        if (!pageNum || pageNum < 1) return null;
        var chaps = sortedChapterPages();
        if (!chaps.length) return null;
        var idx = -1;
        for (var i = 0; i < chaps.length; i++) {
            if (chaps[i].page <= pageNum) idx = i; else break;
        }
        if (idx === -1) idx = 0;
        var startPage = chaps[idx].page;
        var endPage = totalPages() + 1;
        for (var j = idx + 1; j < chaps.length; j++) {
            if (chaps[j].page > startPage) { endPage = chaps[j].page; break; }
        }
        return {
            start: startPage,
            end: endPage,
            label: chaps[idx].label,
        };
    }

    function selectCurrentChapterFromSelection() {
        var sel = window.getSelection();
        var span = selectionPageSpan(sel);
        if (!span || !sel) return false;
        var chapter = chapterRangeForPage(span.focus);
        if (!chapter) return false;
        var startPos = pageTextBoundaryPosition(chapter.start, true);
        var endPos = pageTextBoundaryPosition(chapter.end - 1, false);
        if (!startPos || !endPos) return false;
        ensurePageRangeRendered(chapter.start, chapter.end - 1);
        document.body.classList.remove('pdf2html-search-entered');
        try {
            // Chapter-promotion is a selection reshape. Let the browser's own
            // selection scroll behavior carry the viewport, and only suppress
            // our cursor-pin fallback so we don't add a second competing
            // smooth-scroll on top.
            searchSuppressPinUntil = performance.now() + 500;
            var range = document.createRange();
            range.setStart(startPos.node, startPos.offset);
            range.setEnd(endPos.node, endPos.offset);
            sel.removeAllRanges();
            sel.addRange(range);
            return true;
        } catch (e) {
            return false;
        }
    }

    // Like gotoPage, but bypasses #page-container's scroll-padding so the
    // target page's top aligns flush with the viewport top. An 8 px lead-in
    // keeps a sliver of inter-page gap visible (no prev-page content, but a
    // clear "this is the top of a page" cue). Used by e/E page stepping.
    function snapToPage(n) {
        if (!n || n < 1) return;
        var el = document.getElementById('pf' + n.toString(16));
        var pc = document.getElementById('page-container');
        if (!el || !pc) return;
        pc.scrollTop = Math.max(0, el.offsetTop - 8);
    }

    // Match by exact (case-insensitive) label first, then substring. Falls back
    // silently if there's no match — palette already showed candidates, so an
    // empty submit is user saying "never mind."
    function gotoChapter(needle) {
        if (!needle) return;
        var chaps = getChapters();
        if (!chaps.length) return;
        var n = needle.toLowerCase().trim();
        var exact = null, sub = null;
        for (var i = 0; i < chaps.length; i++) {
            var lbl = chaps[i].label.toLowerCase();
            if (lbl === n) { exact = chaps[i]; break; }
            if (!sub && lbl.indexOf(n) !== -1) sub = chaps[i];
        }
        var pick = exact || sub;
        if (pick) gotoPage(pick.page);
    }

    function setInputValueAndFire(id, val) {
        if (isNaN(val)) return;
        var i = document.getElementById(id);
        if (!i) return;
        i.value = val;
        i.dispatchEvent(new Event('change'));
    }

    function toggleCheckboxAndFire(id) {
        var cb = document.getElementById(id);
        if (!cb) return;
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event('change'));
    }

    function yankCurrentLocation() {
        var link = document.querySelector('#outline a.pdf2html-active');
        var chapter = link ? link.textContent.trim() : '';
        var pc = document.getElementById('page-container');
        if (!pc) return;
        var pages = document.querySelectorAll('.pf');
        var st = pc.scrollTop, sb = st + pc.clientHeight, bestIdx = 0, bestO = -1;
        for (var i = 0; i < pages.length; i++) {
            var t = pages[i].offsetTop, b = t + pages[i].offsetHeight;
            var o = Math.min(b, sb) - Math.max(t, st);
            if (o > bestO) { bestO = o; bestIdx = i; }
        }
        var text = (chapter ? chapter + ' · ' : '') + 'p. ' + (bestIdx + 1);
        writeClip(text);
    }

    // Text extraction — yanks actual content for notes / quoting workflow.
    // pdf2htmlEX lays out each visual line as a `.t` div inside `.pc`; joining
    // them with '\n' preserves the per-line structure that plain textContent
    // on `.pc` would collapse. Hidden pages (display:none outside render
    // window) still have their DOM — textContent traverses regardless.
    function pageText(pageNum) {
        var pf = document.getElementById('pf' + pageNum.toString(16));
        if (!pf) return '';
        var pc = pf.querySelector('.pc');
        if (!pc) return '';
        var lines = pc.querySelectorAll('.t');
        if (!lines.length) return (pc.textContent || '').trim();
        var out = [];
        for (var i = 0; i < lines.length; i++) {
            var t = (lines[i].textContent || '').trim();
            if (t) out.push(t);
        }
        return out.join('\n');
    }

    function pageRangeText(startPage, endPageExcl) {
        var out = [];
        for (var p = startPage; p < endPageExcl; p++) {
            var t = pageText(p);
            if (t) out.push(t);
        }
        return out.join('\n\n');
    }

    function totalPages() {
        return document.querySelectorAll('.pf').length;
    }

    // Active chapter → [startPage, endPage). End is the next outline entry
    // with strictly greater page (so subsections within the same page don't
    // terminate the range early), or document end.
    function activeChapterRange() {
        return chapterRangeForPage(currentPage);
    }

    function writeClip(text) {
        if (!text) return Promise.resolve(false);
        var value = String(text);
        if (navigator.clipboard && navigator.clipboard.writeText) {
            try {
                return navigator.clipboard.writeText(value).then(function () {
                    return true;
                }, function () {
                    return fallbackWriteClip(value);
                });
            } catch (e) {
                return Promise.resolve(fallbackWriteClip(value));
            }
        }
        return Promise.resolve(fallbackWriteClip(value));
    }

    function fallbackWriteClip(text) {
        var ta = document.createElement('textarea');
        var active = document.activeElement;
        var selection = window.getSelection ? window.getSelection() : null;
        var ranges = [];
        try {
            if (selection) {
                for (var i = 0; i < selection.rangeCount; i++) {
                    ranges.push(selection.getRangeAt(i).cloneRange());
                }
            }
            ta.value = text;
            ta.setAttribute('readonly', '');
            ta.style.position = 'fixed';
            ta.style.left = '-9999px';
            ta.style.top = '0';
            document.body.appendChild(ta);
            ta.select();
            ta.setSelectionRange(0, ta.value.length);
            return !!document.execCommand && document.execCommand('copy');
        } catch (e) {
            return false;
        } finally {
            if (ta.parentElement) ta.remove();
            if (selection) {
                try {
                    selection.removeAllRanges();
                    ranges.forEach(function (r) { selection.addRange(r); });
                } catch (e) {}
            }
            if (active && active.focus) {
                try { active.focus({ preventScroll: true }); } catch (e) {}
            }
        }
    }

    function yankPage() {
        writeClip(pageText(currentPage));
    }

    function yankChapter() {
        var r = activeChapterRange();
        if (!r) return;
        var body = pageRangeText(r.start, r.end);
        writeClip((r.label ? r.label + '\n\n' : '') + body);
    }

    function yankDocument() {
        var body = pageRangeText(1, totalPages() + 1);
        if (!body) return;
        var title = (document.title || 'Document').trim();
        writeClip(title + '\n\n' + body);
    }

    function dispatchYank(kind) {
        var k = (kind || '').toLowerCase().trim();
        if (k === 'page')                     yankPage();
        else if (k === 'chapter' || k === 'ch') yankChapter();
        else if (k === 'document' || k === 'doc') yankDocument();
        else                                  yankCurrentLocation();  // ref (default)
    }

    // ------------------------------------------------------------------------
    // Finger mode — tmux-fingers-style token picker for the visible viewport.
    //
    // V1 deliberately stays local: it scans only visible rendered page frames
    // and only structured tokens. Hints use keys that already pass through
    // Vimium on localhost (e/s/q/c/h/l/n), so the mode works without extending
    // Vimium's exclusion list. The pdf2htmlEX text DOM remains untouched:
    // targets are painted through CSS Custom Highlights, while hint labels live
    // in a fixed overlay layer backed by original browser Ranges for copy.
    // ------------------------------------------------------------------------
    var FINGER_ALPHABET = 'esqchln'.split('');
    var FINGER_HIGHLIGHTS = [
        'pdf2html-finger-url',
        'pdf2html-finger-doi',
        'pdf2html-finger-isbn',
        'pdf2html-finger-id',
    ];
    var FINGER_PATTERNS = [
        {
            kind: 'url',
            priority: 0,
            re: /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi,
        },
        {
            kind: 'doi',
            priority: 1,
            re: /\b(?:doi:\s*)?10\.\d{4,9}\/[-._;()/:A-Z0-9]+/gi,
        },
        {
            kind: 'isbn',
            priority: 2,
            re: /\bISBN(?:-1[03])?:?\s*(?:97[89][-\s]?)?\d(?:[-\s]?\d){8,12}[-\s]?[0-9X]\b|\b97[89](?:[-\s]?\d){10}\b/gi,
        },
        {
            kind: 'id',
            priority: 3,
            re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
        },
        {
            kind: 'id',
            priority: 4,
            re: /\b[0-9a-f]{7,64}\b/gi,
        },
        {
            kind: 'id',
            priority: 5,
            re: /\b\d{6,}\b/g,
        },
    ];

    function openFingerMode() {
        if (fingerState) { closeFingerMode(); return; }
        closeSearch();
        clearFingerHighlights();
        var stale = document.getElementById('pdf2html-fingers');
        if (stale) stale.remove();
        document.body.classList.remove('pdf2html-fingers-active');

        var targets = collectFingerTargets();
        if (!targets.length) return;

        assignFingerHints(targets);
        var root = document.createElement('div');
        root.id = 'pdf2html-fingers';
        root.setAttribute('aria-hidden', 'true');
        document.body.appendChild(root);

        targets.forEach(function (target, idx) {
            target.id = idx;
            target.nodes = [];

            var first = target.rects[0];
            var label = document.createElement('div');
            label.className = 'pdf2html-finger-label';
            label.dataset.kind = target.kind;
            label.dataset.hint = target.hint;
            label.textContent = target.hint;
            label.style.left = first.left + 'px';
            label.style.top = (first.top + first.height / 2) + 'px';
            styleFingerLabel(label, first);
            root.appendChild(label);
            target.nodes.push(label);
        });

        var pc = document.getElementById('page-container');
        fingerState = {
            prefix: '',
            root: root,
            targets: targets,
            keydown: handleFingerKeydown,
            closeOnScroll: function () { closeFingerMode(); },
            closeOnGeometryChange: function () { closeFingerMode(); },
        };
        document.body.classList.add('pdf2html-fingers-active');
        window.addEventListener('keydown', fingerState.keydown, true);
        window.addEventListener('resize', fingerState.closeOnGeometryChange);
        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', fingerState.closeOnGeometryChange);
            window.visualViewport.addEventListener('scroll', fingerState.closeOnGeometryChange);
        }
        if (pc) pc.addEventListener('scroll', fingerState.closeOnScroll, { passive: true });
        updateFingerPrefix();
    }

    function closeFingerMode() {
        if (!fingerState) return;
        var state = fingerState;
        var pc = document.getElementById('page-container');
        fingerState = null;
        window.removeEventListener('keydown', state.keydown, true);
        window.removeEventListener('resize', state.closeOnGeometryChange);
        if (window.visualViewport) {
            window.visualViewport.removeEventListener('resize', state.closeOnGeometryChange);
            window.visualViewport.removeEventListener('scroll', state.closeOnGeometryChange);
        }
        if (pc) pc.removeEventListener('scroll', state.closeOnScroll);
        if (state.root && state.root.parentElement) state.root.remove();
        document.body.classList.remove('pdf2html-fingers-active');
        clearFingerHighlights();
    }

    function handleFingerKeydown(e) {
        if (!fingerState) return;
        if (e.key === 'Escape') {
            e.preventDefault(); e.stopImmediatePropagation();
            closeFingerMode();
            return;
        }
        if (e.key === 'Backspace') {
            e.preventDefault(); e.stopImmediatePropagation();
            fingerState.prefix = fingerState.prefix.slice(0, -1);
            updateFingerPrefix();
            return;
        }
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        var key = String(e.key || '').toLowerCase();
        if (FINGER_ALPHABET.indexOf(key) === -1) return;

        e.preventDefault(); e.stopImmediatePropagation();
        var next = fingerState.prefix + key;
        var matches = fingerState.targets.filter(function (t) {
            return t.hint.indexOf(next) === 0;
        });
        if (!matches.length) return;

        fingerState.prefix = next;
        var exact = null;
        for (var i = 0; i < matches.length; i++) {
            if (matches[i].hint === next) { exact = matches[i]; break; }
        }
        if (exact) {
            writeClip(exact.text);
            closeFingerMode();
        } else {
            updateFingerPrefix();
        }
    }

    function updateFingerPrefix() {
        if (!fingerState) return;
        var prefix = fingerState.prefix;
        fingerState.root.dataset.prefix = prefix;
        fingerState.targets.forEach(function (target) {
            var match = !prefix || target.hint.indexOf(prefix) === 0;
            var exact = !!prefix && target.hint === prefix;
            target.nodes.forEach(function (node) {
                node.classList.toggle('pdf2html-finger-hidden', !match);
                node.classList.toggle('pdf2html-finger-exact', exact);
                node.classList.toggle('pdf2html-finger-prefixed', !!prefix && match);
            });
        });
        updateFingerHighlights(prefix);
    }

    function styleFingerLabel(label, rect) {
        var size = Math.max(16, Math.min(26, rect.height * 0.95));
        label.style.setProperty('--pdf2html-finger-size', size.toFixed(1) + 'px');
    }

    function updateFingerHighlights(prefix) {
        if (!fingerState) return;
        if (!window.CSS || !CSS.highlights || typeof Highlight === 'undefined') return;
        var groups = {
            url: new Highlight(),
            doi: new Highlight(),
            isbn: new Highlight(),
            id: new Highlight(),
        };
        fingerState.targets.forEach(function (target) {
            if (prefix && target.hint.indexOf(prefix) !== 0) return;
            try {
                groups[target.kind].add(target.range);
            } catch (e) {
                // Detached range after a render-window update; ignore until the
                // mode closes on scroll/resize.
            }
        });
        try {
            CSS.highlights.set('pdf2html-finger-url', groups.url);
            CSS.highlights.set('pdf2html-finger-doi', groups.doi);
            CSS.highlights.set('pdf2html-finger-isbn', groups.isbn);
            CSS.highlights.set('pdf2html-finger-id', groups.id);
        } catch (e) { /* Highlight API unavailable or rejected a stale range. */ }
    }

    function clearFingerHighlights() {
        if (!window.CSS || !CSS.highlights) return;
        try {
            FINGER_HIGHLIGHTS.forEach(function (name) { CSS.highlights.delete(name); });
        } catch (e) { /* no-op */ }
    }

    function collectFingerTargets() {
        var pages = visiblePageFrames();
        if (!pages.length) return [];
        var candidates = [];
        var scopeId = 0;
        var order = 0;
        var pc = document.getElementById('page-container');
        var viewport = pc ? pc.getBoundingClientRect() : null;
        if (!viewport) return [];

        pages.forEach(function (pf) {
            var content = pf.querySelector('.pc');
            if (!content) return;
            var lines = content.querySelectorAll('.t');
            if (!lines.length) lines = [content];

            for (var i = 0; i < lines.length; i++) {
                var run = textRunForFinger(lines[i]);
                if (!run || !run.text.trim()) continue;
                var thisScope = scopeId++;
                collectFingerCandidatesForRun(run, thisScope, order, viewport, candidates);
                order += 1;
            }
        });

        return suppressFingerOverlaps(candidates).sort(function (a, b) {
            return (a.rects[0].top - b.rects[0].top)
                || (a.rects[0].left - b.rects[0].left)
                || (a.order - b.order);
        });
    }

    function textRunForFinger(root) {
        var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        var text = '';
        var segments = [];
        var node;
        while ((node = walker.nextNode())) {
            var value = node.nodeValue || '';
            if (!value) continue;
            var start = text.length;
            text += value;
            segments.push({ node: node, start: start, end: text.length });
        }
        return segments.length ? { text: text, segments: segments } : null;
    }

    function collectFingerCandidatesForRun(run, scopeId, order, viewport, out) {
        FINGER_PATTERNS.forEach(function (pat) {
            pat.re.lastIndex = 0;
            var m;
            while ((m = pat.re.exec(run.text))) {
                if (!m[0]) {
                    pat.re.lastIndex += 1;
                    continue;
                }
                var bounds = cleanFingerBounds(run.text, m.index, m.index + m[0].length, pat.kind);
                if (bounds.end <= bounds.start) continue;
                var range = rangeForFingerRun(run, bounds.start, bounds.end);
                if (!range) continue;
                var rects = visibleFingerRects(range, viewport);
                if (!rects.length) continue;
                out.push({
                    kind: pat.kind,
                    priority: pat.priority,
                    text: run.text.slice(bounds.start, bounds.end),
                    range: range,
                    rects: rects,
                    scopeId: scopeId,
                    start: bounds.start,
                    end: bounds.end,
                    order: order,
                });
            }
        });
    }

    function cleanFingerBounds(text, start, end, kind) {
        while (end > start && /[.,;:]$/.test(text.slice(start, end))) end -= 1;
        if (kind === 'url') {
            while (end > start && /[)\]}]$/.test(text.slice(start, end))
                   && !hasMatchingFingerOpener(text.slice(start, end))) {
                end -= 1;
            }
        }
        return { start: start, end: end };
    }

    function hasMatchingFingerOpener(s) {
        var close = s.charAt(s.length - 1);
        var open = close === ')' ? '(' : (close === ']' ? '[' : '{');
        return s.indexOf(open) !== -1;
    }

    function rangeForFingerRun(run, start, end) {
        var a = fingerPositionForOffset(run, start, false);
        var b = fingerPositionForOffset(run, end, true);
        if (!a || !b) return null;
        var range = document.createRange();
        try {
            range.setStart(a.node, a.offset);
            range.setEnd(b.node, b.offset);
            return range;
        } catch (e) {
            return null;
        }
    }

    function fingerPositionForOffset(run, offset, isEnd) {
        if (!run.segments.length) return null;
        for (var i = 0; i < run.segments.length; i++) {
            var seg = run.segments[i];
            if (isEnd) {
                if (offset >= seg.start && offset <= seg.end) {
                    return { node: seg.node, offset: offset - seg.start };
                }
            } else if (offset >= seg.start && offset < seg.end) {
                return { node: seg.node, offset: offset - seg.start };
            }
        }
        var last = run.segments[run.segments.length - 1];
        if (isEnd && offset === last.end) {
            return { node: last.node, offset: last.end - last.start };
        }
        return null;
    }

    function visibleFingerRects(range, viewport) {
        var out = [];
        var rects = range.getClientRects();
        for (var i = 0; i < rects.length; i++) {
            var r = rects[i];
            var left = Math.max(r.left, viewport.left);
            var top = Math.max(r.top, viewport.top);
            var right = Math.min(r.right, viewport.right);
            var bottom = Math.min(r.bottom, viewport.bottom);
            var width = right - left;
            var height = bottom - top;
            if (width < 1 || height < 1) continue;
            out.push({ left: left, top: top, width: width, height: height });
        }
        return out;
    }

    function suppressFingerOverlaps(candidates) {
        candidates.sort(function (a, b) {
            return (a.priority - b.priority)
                || (a.scopeId - b.scopeId)
                || (a.start - b.start)
                || (a.end - b.end);
        });
        var accepted = [];
        candidates.forEach(function (cand) {
            for (var i = 0; i < accepted.length; i++) {
                var prev = accepted[i];
                if (prev.scopeId !== cand.scopeId) continue;
                if (cand.start < prev.end && cand.end > prev.start) return;
            }
            accepted.push(cand);
        });
        return accepted;
    }

    function assignFingerHints(targets) {
        var hints = generateFingerHints(targets.length);
        for (var i = 0; i < targets.length; i++) targets[i].hint = hints[i];
    }

    function generateFingerHints(n) {
        var base = FINGER_ALPHABET.length;
        var len = 1;
        var cap = base;
        while (cap < n) {
            len += 1;
            cap *= base;
        }
        var out = [];
        for (var i = 0; i < n; i++) out.push(fingerHintForIndex(i, len));
        return out;
    }

    function fingerHintForIndex(index, len) {
        var base = FINGER_ALPHABET.length;
        var chars = new Array(len);
        for (var pos = len - 1; pos >= 0; pos--) {
            chars[pos] = FINGER_ALPHABET[index % base];
            index = Math.floor(index / base);
        }
        return chars.join('');
    }

    function registerPaletteHandler() {
        document.addEventListener('keydown', function (e) {
            if (e.key !== ':') return;
            if (isInputTarget(e.target)) return;
            e.preventDefault(); e.stopPropagation();
            openPalette();
        }, true);
    }

    function registerFingerShortcutHandler() {
        window.addEventListener('keydown', function (e) {
            if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
            if (String(e.key || '').toLowerCase() !== 'f') return;
            if (isInputTarget(e.target)) return;
            if (fingerShortcutBlockedByOverlay()) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            openFingerMode();
        }, true);
    }

    function fingerShortcutBlockedByOverlay() {
        return !!(document.getElementById('pdf2html-palette')
            || document.getElementById('pdf2html-finder')
            || document.getElementById('pdf2html-settings')
            || document.getElementById('pdf2html-cheatsheet'));
    }

    // ------------------------------------------------------------------------
    // Cmd-K Finder — centered, pretty quick-jump dropdown. Groups candidates
    // from the current document's outline, the cached library, and the
    // palette COMMANDS into one searchable list. Sibling to openPalette()
    // (:) rather than replacing it: : stays vim ex-bar; ⌘K opens this.
    // ------------------------------------------------------------------------

    function closeFinder() {
        var ex = document.getElementById('pdf2html-finder');
        if (ex) ex.remove();
    }

    // SVG atoms — trimmed to just what the row icons need.
    function finderSvg(kind) {
        var attrs = 'width="12" height="12" viewBox="0 0 24 24" fill="none" '
                  + 'stroke="currentColor" stroke-width="1.75" '
                  + 'stroke-linecap="round" stroke-linejoin="round"';
        if (kind === 'doc') {
            return '<svg ' + attrs + '>'
                + '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/>'
                + '<path d="M14 3v6h6"/></svg>';
        }
        if (kind === 'book') {
            return '<svg ' + attrs + '>'
                + '<rect x="3" y="5" width="4" height="14"/>'
                + '<rect x="9" y="3" width="4" height="16"/>'
                + '<path d="M15 7l3.5-1 3 11-3.5 1z"/></svg>';
        }
        if (kind === 'cmd') {
            return '<svg ' + attrs + '>'
                + '<path d="M5 8l4 4-4 4M12 16h7"/></svg>';
        }
        return '';
    }

    // Try to split a chapter label into a leading section number and title.
    // "3.2 Self-organization" → { num: "3.2", title: "Self-organization" }
    // If there's no number, returns { num: "", title: label }.
    function finderParseChapter(label) {
        var m = String(label || '').match(/^\s*([0-9]+(?:\.[0-9]+)*|[A-Z])\s+(.*)$/);
        if (m) return { num: m[1], title: m[2].trim() };
        return { num: '', title: String(label || '').trim() };
    }

    // Derive a human title from a path/URL when the daemon didn't supply
    // a name. Strips the extension so "/Users/x/Foo-Bar.pdf" → "Foo-Bar".
    // URL-decodes percent-encoded segments so %20 doesn't leak into the UI.
    function finderDeriveTitle(ref) {
        var s = String(ref || '').trim();
        if (!s) return '';
        // Drop query string + trailing slashes.
        s = s.replace(/[?#].*$/, '').replace(/\/+$/, '');
        var tail = s.split('/').pop() || s;
        try { tail = decodeURIComponent(tail); } catch (_) {}
        return tail.replace(/\.(pdf|html?|xml)$/i, '');
    }

    // Middle-ellipsis truncation: "/a/really/long/path/to/file.pdf" →
    // "/a/really/…/path/to/file.pdf". Preserves the trailing filename — the
    // most identifying part of a path — and drops the middle directories.
    // Guards against absurd `max` values so we never build a negative slice.
    function finderMiddleEllipsis(s, max) {
        var str = String(s || '');
        var m = Math.max(4, max | 0);
        if (str.length <= m) return str;
        var keep = m - 1; // room for the ellipsis
        var head = Math.max(1, Math.ceil(keep * 0.35));
        var tail = Math.max(1, keep - head);
        return str.slice(0, head) + '…' + str.slice(str.length - tail);
    }

    // Build the full flat-with-groups candidate list once per open. Each
    // candidate is { group, icon, label, meta, searchText, run }.
    function buildFinderCandidates() {
        var out = [];

        // --- Outline (this document) ---
        var chaps = getChapters();
        for (var i = 0; i < chaps.length; i++) {
            var c = chaps[i];
            var parts = finderParseChapter(c.label);
            var num = parts.num;
            var title = parts.title;
            var metaBits = [];
            if (num) metaBits.push('§ ' + num);
            metaBits.push('p. ' + c.page);
            out.push({
                scope: 'outline',
                group: 'Outline · this document',
                icon: num ? { kind: 'text', text: num } : { kind: 'text', text: '§' },
                label: title,
                meta: metaBits.join('  ·  '),
                searchText: (num + ' ' + title + ' ' + c.label).toLowerCase(),
                run: (function (page) { return function () { gotoPage(page); }; })(c.page),
            });
        }

        // --- Other documents (library) ---
        if (libraryEntries && libraryEntries.length) {
            for (var j = 0; j < libraryEntries.length; j++) {
                var e = libraryEntries[j];
                if (isCurrentLibraryEntry(e)) continue;
                var libLabel = String(e.name || '').trim();
                if (!libLabel) libLabel = finderDeriveTitle(e.source_ref) || '(untitled)';
                var bits = [];
                if (e.source_ref) bits.push(finderMiddleEllipsis(e.source_ref, 44));
                if (e.pages) bits.push(e.pages + ' pp');
                var rec = recencyLabel(e);
                if (rec) bits.push(rec);
                out.push({
                    scope: 'files',
                    group: 'Other documents',
                    icon: { kind: 'svg', svg: finderSvg('book') },
                    label: libLabel,
                    meta: bits.join('  ·  '),
                    searchText: librarySearchText(e),
                    run: (function (href) { return function () { if (href) location.href = href; }; })(e.href),
                });
            }
        }

        // --- Commands ---
        for (var k = 0; k < COMMANDS.length; k++) {
            var cmd = COMMANDS[k];
            var desc = typeof cmd.desc === 'function' ? cmd.desc() : (cmd.desc || '');
            var alias = cmd.aliases && cmd.aliases[0] ? cmd.aliases[0] : '';
            out.push({
                scope: 'commands',
                group: 'Commands',
                icon: { kind: 'svg', svg: finderSvg('cmd') },
                label: ':' + cmd.name + (alias ? '  ' : ''),
                labelAlias: alias ? ':' + alias : '',
                meta: desc,
                searchText: (cmd.name + ' ' + (cmd.aliases || []).join(' ') + ' ' + desc).toLowerCase(),
                // Commands that take args shouldn't fire bare — expand into the
                // ex-bar palette so the user can supply an argument. Zero-arg
                // commands run straight through.
                run: (function (c) {
                    return function () {
                        if (commandTakesArg(c)) {
                            openPalette();
                            var inp = document.getElementById('pdf2html-palette-input');
                            if (inp) {
                                inp.value = c.name + ' ';
                                inp.dispatchEvent(new Event('input'));
                                inp.selectionStart = inp.selectionEnd = inp.value.length;
                            }
                        } else {
                            c.handler();
                        }
                    };
                })(cmd),
            });
        }

        return out;
    }

    // Case-insensitive substring filter; also builds match highlight ranges
    // over the label so we can show which chars hit.
    function finderFilter(candidates, query) {
        var q = String(query || '').trim().toLowerCase();
        if (!q) return candidates.map(function (c) { return { cand: c, hit: null }; });
        var out = [];
        for (var i = 0; i < candidates.length; i++) {
            var c = candidates[i];
            if (c.searchText.indexOf(q) === -1) continue;
            var labelLc = String(c.label || '').toLowerCase();
            var idx = labelLc.indexOf(q);
            out.push({ cand: c, hit: idx >= 0 ? { start: idx, end: idx + q.length } : null });
        }
        return out;
    }

    function escapeFinderHtml(s) {
        return String(s || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function renderFinderLabel(cand, hit) {
        var label = String(cand.label || '');
        var html;
        if (hit) {
            html = escapeFinderHtml(label.slice(0, hit.start))
                 + '<span class="match">' + escapeFinderHtml(label.slice(hit.start, hit.end)) + '</span>'
                 + escapeFinderHtml(label.slice(hit.end));
        } else {
            html = escapeFinderHtml(label);
        }
        if (cand.labelAlias) {
            html += '<span class="dim">' + escapeFinderHtml(cand.labelAlias) + '</span>';
        }
        return html;
    }

    function renderFinderIcon(icon) {
        if (!icon) return '';
        if (icon.kind === 'text') {
            return '<span class="icon icon-text">' + escapeFinderHtml(icon.text) + '</span>';
        }
        return '<span class="icon">' + (icon.svg || '') + '</span>';
    }

    function openFinder() {
        // Toggle: re-press ⌘K closes.
        var existing = document.getElementById('pdf2html-finder');
        if (existing) { existing.remove(); return; }

        // Kick off library fetch if we don't have it yet — first ⌘K on a
        // fresh tab would otherwise render an empty "Other documents" group.
        loadLibrary();

        // Scope cycle: Tab advances, Shift+Tab reverses. 'all' includes the
        // command palette too; the narrower scopes drop it so the user can
        // focus on navigation without noise.
        var SCOPES = [
            { id: 'all',      label: 'All',           placeholder: 'Jump to anything — section, document, command…  ·  tab to cycle' },
            { id: 'outline',  label: 'This document', placeholder: 'Search this document…' },
            { id: 'files',    label: 'Files',         placeholder: 'Search files…' },
        ];
        var scopeIdx = 0;

        var bg = document.createElement('div');
        bg.id = 'pdf2html-finder';
        bg.innerHTML =
            '<div class="pdf2html-finder" role="dialog" aria-label="Quick finder">'
          +   '<div class="pdf2html-finder-input-row">'
          +     '<button type="button" class="pdf2html-finder-scope" id="pdf2html-finder-scope" '
          +       'title="Cycle scope (Tab / Shift+Tab)" hidden>'
          +       '<span class="scope-label"></span>'
          +     '</button>'
          +     '<input type="text" class="pdf2html-finder-input" id="pdf2html-finder-input" '
          +       'autocomplete="off" spellcheck="false" autocapitalize="off" '
          +       'placeholder="Jump to anything — section, document, command…  ·  tab to cycle">'
          +     '<button type="button" class="pdf2html-finder-close" aria-label="Close">'
          +       '<span class="pdf2html-kbd sm">Esc</span>'
          +     '</button>'
          +   '</div>'
          +   '<div class="pdf2html-finder-list" id="pdf2html-finder-list"></div>'
          +   '<div class="pdf2html-finder-foot">'
          +     '<div class="foot-group">'
          +       '<span class="foot-item"><span class="pdf2html-kbd">↑</span><span class="pdf2html-kbd">↓</span><span class="tip">navigate</span></span>'
          +       '<span class="foot-item"><span class="pdf2html-kbd">Tab</span><span class="tip">scope</span></span>'
          +       '<span class="foot-item"><span class="pdf2html-kbd">↵</span><span class="tip">go</span></span>'
          +       '<span class="foot-item"><span class="pdf2html-kbd">Esc</span><span class="tip">close</span></span>'
          +     '</div>'
          +     '<div class="foot-group"><span class="foot-item tip" id="pdf2html-finder-count">—</span></div>'
          +   '</div>'
          + '</div>';

        document.body.appendChild(bg);

        var listEl = bg.querySelector('#pdf2html-finder-list');
        var inputEl = bg.querySelector('#pdf2html-finder-input');
        var countEl = bg.querySelector('#pdf2html-finder-count');
        var closeBtn = bg.querySelector('.pdf2html-finder-close');
        var scopeBtn = bg.querySelector('#pdf2html-finder-scope');
        var scopeLabelEl = scopeBtn.querySelector('.scope-label');

        function currentScope() { return SCOPES[scopeIdx].id; }
        function cycleScope(delta) {
            scopeIdx = (scopeIdx + delta + SCOPES.length) % SCOPES.length;
            var scope = SCOPES[scopeIdx];
            var isDefault = scopeIdx === 0;
            // All mode: hide the pill entirely, fold the cue into the input
            // placeholder. Narrower scopes: materialize the pill.
            scopeBtn.hidden = isDefault;
            scopeLabelEl.textContent = isDefault ? '' : scope.label;
            scopeBtn.classList.toggle('accent', !isDefault);
            inputEl.placeholder = scope.placeholder;
            render();
        }
        scopeBtn.addEventListener('click', function () { cycleScope(1); inputEl.focus(); });

        // Click outside (on the backdrop, not the modal) closes.
        bg.addEventListener('mousedown', function (ev) {
            if (ev.target === bg) { ev.preventDefault(); closeFinder(); }
        });
        closeBtn.addEventListener('click', function () { closeFinder(); });

        var allCandidates = buildFinderCandidates();
        var state = { visible: [], idx: 0 };

        // Expose the active element-lookup fn to scroll-into-view after render.
        function scrollActiveIntoView() {
            var active = listEl.querySelector('.pdf2html-finder-row.active');
            if (active && active.scrollIntoView) {
                active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
            }
        }

        function render() {
            // Bail if the modal was ripped out from under us (poll callback,
            // async library fetch, etc. — the listEl would be orphaned).
            if (!bg.isConnected) return;
            var q = inputEl.value;
            // Cap bareNum to an int that can't roll into Infinity/NaN — the
            // gotoPage() lookup silently fails for missing pages, but we
            // still want a sane upper bound on the synthetic "Go to" row.
            var bareNumMatch = /^\s*(\d{1,7})\s*$/.exec(q);
            var bareNum = bareNumMatch ? parseInt(bareNumMatch[1], 10) : 0;

            var scope = currentScope();
            var scoped = scope === 'all'
                ? allCandidates
                : allCandidates.filter(function (c) { return c.scope === scope; });
            var filtered = finderFilter(scoped, q);

            // Prepend a synthetic "Go to page N" entry when the user types a
            // bare number — mirrors the : palette's `:42` shortcut.
            // Only in scopes that include in-document navigation.
            if (bareNum > 0 && (scope === 'all' || scope === 'outline')) {
                filtered.unshift({
                    cand: {
                        group: 'Go to',
                        icon: { kind: 'svg', svg: finderSvg('doc') },
                        label: 'Page ' + bareNum,
                        meta: 'jump',
                        run: (function (n) { return function () { gotoPage(n); }; })(bareNum),
                    },
                    hit: null,
                });
            }

            state.visible = filtered;
            if (state.idx >= filtered.length) state.idx = 0;
            if (state.idx < 0) state.idx = 0;

            listEl.innerHTML = '';
            if (!filtered.length) {
                var empty = document.createElement('div');
                empty.className = 'pdf2html-finder-empty';
                empty.textContent = q ? 'No matches for "' + q + '"' : 'Nothing here yet.';
                listEl.appendChild(empty);
                countEl.textContent = '0 results';
                return;
            }

            var lastGroup = null;
            // Group counts for the group-label tail count chip.
            var counts = {};
            for (var gi = 0; gi < filtered.length; gi++) {
                var g = filtered[gi].cand.group;
                counts[g] = (counts[g] || 0) + 1;
            }

            for (var i = 0; i < filtered.length; i++) {
                var entry = filtered[i];
                var cand = entry.cand;
                if (cand.group !== lastGroup) {
                    lastGroup = cand.group;
                    var gLabel = document.createElement('div');
                    gLabel.className = 'pdf2html-finder-group';
                    gLabel.innerHTML =
                        escapeFinderHtml(cand.group)
                      + '<span class="count">' + counts[cand.group] + '</span>';
                    listEl.appendChild(gLabel);
                }
                var row = document.createElement('div');
                row.className = 'pdf2html-finder-row' + (i === state.idx ? ' active' : '');
                row.dataset.idx = String(i);
                row.innerHTML =
                    renderFinderIcon(cand.icon)
                  + '<span class="label">' + renderFinderLabel(cand, entry.hit) + '</span>'
                  + '<span class="meta">' + escapeFinderHtml(cand.meta || '') + '</span>';
                row.addEventListener('mousemove', (function (idx) {
                    return function () {
                        if (state.idx !== idx) {
                            state.idx = idx;
                            // Light-touch re-render: just toggle the `active`
                            // class instead of redrawing the whole list on
                            // every mouse pixel.
                            var rows = listEl.querySelectorAll('.pdf2html-finder-row');
                            for (var r = 0; r < rows.length; r++) {
                                rows[r].classList.toggle('active', Number(rows[r].dataset.idx) === idx);
                            }
                        }
                    };
                })(i));
                row.addEventListener('mousedown', (function (runFn) {
                    return function (ev) {
                        ev.preventDefault();
                        closeFinder();
                        if (typeof runFn === 'function') {
                            setTimeout(function () {
                                try { runFn(); }
                                catch (err) { console.warn('[finder] run failed:', err); }
                            }, 0);
                        }
                    };
                })(cand.run));
                listEl.appendChild(row);
            }

            countEl.textContent = filtered.length + (filtered.length === 1 ? ' result' : ' results');
            scrollActiveIntoView();
        }

        function move(delta) {
            if (!state.visible.length) return;
            state.idx = (state.idx + delta + state.visible.length) % state.visible.length;
            var rows = listEl.querySelectorAll('.pdf2html-finder-row');
            for (var r = 0; r < rows.length; r++) {
                rows[r].classList.toggle('active', Number(rows[r].dataset.idx) === state.idx);
            }
            scrollActiveIntoView();
        }

        inputEl.addEventListener('input', render);
        inputEl.addEventListener('keydown', function (ev) {
            if (ev.key === 'Escape') {
                ev.stopPropagation(); ev.preventDefault();
                closeFinder();
            } else if (ev.key === 'Tab') {
                ev.preventDefault();
                state.idx = 0;
                cycleScope(ev.shiftKey ? -1 : 1);
            } else if (ev.key === 'Enter') {
                ev.preventDefault();
                var pick = state.visible[state.idx];
                if (pick && pick.cand && typeof pick.cand.run === 'function') {
                    closeFinder();
                    setTimeout(function () {
                        try { pick.cand.run(); }
                        catch (err) { console.warn('[finder] run failed:', err); }
                    }, 0);
                }
            } else if (ev.key === 'ArrowDown' || (ev.ctrlKey && !ev.metaKey && !ev.altKey && (ev.key === 'j' || ev.key === 'J'))) {
                ev.preventDefault(); move(1);
            } else if (ev.key === 'ArrowUp' || (ev.ctrlKey && !ev.metaKey && !ev.altKey && (ev.key === 'k' || ev.key === 'K'))) {
                ev.preventDefault(); move(-1);
            }
        });

        // Library might not have loaded yet; re-render once it lands so the
        // "Other documents" group fills in. Bail early if the user closed the
        // finder while we were waiting — no point mutating an orphaned DOM.
        if (!libraryEntries) {
            var retries = 0;
            var poll = setInterval(function () {
                if (!bg.isConnected) { clearInterval(poll); return; }
                if (libraryEntries || retries++ > 20) {
                    clearInterval(poll);
                    if (!bg.isConnected) return;
                    allCandidates = buildFinderCandidates();
                    render();
                }
            }, 150);
        }

        inputEl.focus();
        render();
    }

    // ⌘K — open the finder dropdown. Bypasses isInputTarget so it works
    // from any focus state (Raycast-style quick-open expectation).
    function registerQuickOpenHandler() {
        document.addEventListener('keydown', function (e) {
            if (!e.metaKey || e.ctrlKey || e.altKey) return;
            if (e.key !== 'k' && e.key !== 'K') return;
            e.preventDefault(); e.stopPropagation();
            // If the : palette happens to be open, close it first — ⌘K is a
            // distinct UI.
            var existing = document.getElementById('pdf2html-palette');
            if (existing) existing.remove();
            openFinder();
        }, true);
    }


    // ⌘, — open settings, intercepting the browser's own preferences shortcut.
    // Capture-phase preventDefault is what keeps Comet from opening its
    // settings page; Chromium only reserves ⌘T/W/Q/N hard, so ⌘, is ours to
    // take. Bypasses isInputTarget like ⌘K — chord shortcuts should work from
    // any focus state. openSettings() toggles, so pressing again closes.
    function registerSettingsHandler() {
        document.addEventListener('keydown', function (e) {
            if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
            if (e.key !== ',' && e.code !== 'Comma') return;
            e.preventDefault(); e.stopPropagation();
            openSettings();
        }, true);
    }

    // ------------------------------------------------------------------------
    // Render-all quick toggle (A key) — fires change on the sidebar checkbox
    // so all persistence and rendering logic happens via the normal path.
    // ------------------------------------------------------------------------
    function registerRenderAllHandler() {
        document.addEventListener('keydown', function (e) {
            if (e.key !== 'A') return;
            if (isInputTarget(e.target)) return;
            var cb = document.getElementById('pdf2html-all-input');
            if (!cb) return;
            e.preventDefault();
            cb.checked = !cb.checked;
            cb.dispatchEvent(new Event('change'));
        });
    }


    // ------------------------------------------------------------------------
    // Count-prefix motion handler — the overlay's only count-prefix binding.
    //   e / q / E : +1 / -1 / -1 page (10e = +10 pages, 10q = -10 pages)
    //   c / C : ±1 chapter (10c = +10 chapters, 10C = -10 chapters)
    // Bare keys = ±1. Digits buffer until a motion fires, 1.5 s elapses, or
    // any other key cancels. Requires Vimium passthrough for `e q E c C 0-9`
    // on localhost:7435, else Vimium swallows the digits or letters. When the
    // page receives the key and a browser Selection is active, e/q/E extend
    // the focus end pagewise instead of jumping the viewport, and bare `c`
    // promotes that selection to the full chapter containing its focus page.
    // ------------------------------------------------------------------------
    function registerPageJumpHandler() {
        var buf = '';
        var timer = null;
        function clearBuf() {
            buf = '';
            if (timer) { clearTimeout(timer); timer = null; }
        }
        document.addEventListener('keydown', function (e) {
            if (isInputTarget(e.target)) { clearBuf(); return; }
            if (e.metaKey || e.ctrlKey || e.altKey) { clearBuf(); return; }
            if (e.key >= '0' && e.key <= '9') {
                buf = (buf + e.key).slice(-6);
                e.preventDefault(); e.stopPropagation();
                if (timer) clearTimeout(timer);
                timer = setTimeout(clearBuf, 1500);
                return;
            }
            var k = e.key;
            if (k !== 'e' && k !== 'q' && k !== 'E' && k !== 'c' && k !== 'C') {
                clearBuf();
                return;
            }
            var count = parseInt(buf, 10) || 1;
            clearBuf();
            e.preventDefault(); e.stopPropagation();
            if (k === 'e' || k === 'q' || k === 'E') {
                var delta = k === 'e' ? count : -count;
                if (!extendSelectionByPage(delta)) {
                    var total = document.querySelectorAll('.pf').length || 1;
                    snapToPage(Math.min(total, Math.max(1, currentPage + delta)));
                }
            } else {
                if (k === 'c' && selectCurrentChapterFromSelection()) return;
                gotoChapterBy(k === 'c' ? count : -count);
            }
        }, true);
    }


    // ------------------------------------------------------------------------
    // Cursor pin / scrolloff — CSS scroll-padding on #page-container is the
    // single source of truth. Setting --pdf2html-scrolloff as a percentage
    // defines the reserved band at top and bottom; every native scroll-into-
    // view path (caret on keyboard input, shift+arrow selection extend, click
    // to place caret, Vimium caret mode, hash navigation, outline clicks,
    // :gg/:G, search next) honors it without JS.
    //
    //   pinned=false → padding = scrollOffFraction × 100%  (0% = off, 25% =
    //                  keep caret in middle half, etc.)
    //   pinned=true  → padding = 50% both sides. The "safe" region collapses
    //                  to a single line at center, so any caret movement
    //                  recenters (Vim `scrolloff=999`).
    // ------------------------------------------------------------------------
    var scrollOffFraction = clampScrollOff(parseFloat(localStorage.getItem('pdf2html-scrolloff') || '0.25'));
    var pinned = localStorage.getItem('pdf2html-pinned') !== '0';

    function clampScrollOff(f) {
        if (isNaN(f) || f < 0) return 0;
        if (f > 0.5) return 0.5;
        return f;
    }

    function applyScrollOffStyle() {
        var pct = (pinned ? 50 : scrollOffFraction * 100) + '%';
        var pc = document.getElementById('page-container');
        if (pc) pc.style.setProperty('--pdf2html-scrolloff', pct);
    }

    // The CSS path covers everything the browser scrolls natively (mouse drag,
    // keyboard shift+arrow, click-to-place, scrollIntoView calls). Vimium's
    // caret/visual mode moves the selection via Selection.modify() — a
    // programmatic API that Chrome does NOT auto-scroll for. This handler
    // fills that gap: read the focus range's *visual* rect (which correctly
    // reflects pdf2htmlEX's transformed text; Element.scrollIntoView uses
    // layout rects and lands in the wrong place here), compute the delta
    // against the same band the CSS enforces, and smooth-scroll.
    //
    // Suppressed during a mouse drag so Chrome's native drag-past-edge
    // auto-scroll (the mouse behavior that already "feels right") is left
    // alone.
    function mountCursorPin() {
        applyScrollOffStyle();
        var raf = null;
        var dragging = false;
        var lastScrollTs = 0;
        // Smooth scroll animates ~300ms. A second scroll inside that window
        // cancels the in-flight animation and restarts — so held `j` in
        // Vimium, which fires selection updates every ~30ms, never lets the
        // animation finish and the caret outruns the viewport (worst at
        // page boundaries where delta includes the inter-page margin).
        // Fall back to instant for rapid-fire; keep smooth for isolated
        // moves where the animation has time to complete.
        var RAPID_WINDOW_MS = 180;

        document.addEventListener('mousedown', function () { dragging = true; });
        document.addEventListener('mouseup',   function () { dragging = false; });

        document.addEventListener('selectionchange', function () {
            if (dragging || raf) return;
            if (performance.now() < searchSuppressPinUntil) return;
            raf = requestAnimationFrame(function () {
                raf = null;
                var sel = document.getSelection();
                if (!sel || sel.rangeCount === 0 || !sel.focusNode) return;
                var pc = document.getElementById('page-container');
                if (!pc) return;
                var r = document.createRange();
                try { r.setStart(sel.focusNode, sel.focusOffset); r.collapse(true); }
                catch (e) { return; }
                var rect = r.getBoundingClientRect();
                // Collapsed ranges sometimes return (0,0,0,0) at DOM edges —
                // no reliable caret position, bail.
                if (rect.top === 0 && rect.bottom === 0 && rect.left === 0) return;

                var h = pc.clientHeight;
                var y = rect.top - pc.getBoundingClientRect().top;
                var frac = pinned ? 0.5 : scrollOffFraction;
                var margin = h * frac;
                var delta = 0;
                if (pinned)              delta = y - h * 0.5;
                else if (y < margin)     delta = y - margin;
                else if (y > h - margin) delta = y - (h - margin);
                if (Math.abs(delta) >= 1) {
                    var now = performance.now();
                    var behavior = (now - lastScrollTs < RAPID_WINDOW_MS) ? 'auto' : 'smooth';
                    pc.scrollBy({ top: delta, behavior: behavior });
                    lastScrollTs = now;
                }
            });
        });

        window.__pdf2htmlSetScrollOff = function (f) {
            scrollOffFraction = clampScrollOff(f);
            applyScrollOffStyle();
        };
        window.__pdf2htmlSetPinned = function (on) {
            pinned = !!on;
            applyScrollOffStyle();
        };
    }


    // ------------------------------------------------------------------------
    // Rolling render window — uses IntersectionObserver, so it's zoom-robust
    // (browser manages root geometry itself, no cached page offsets to go stale).
    //
    // Also owns the sidebar config panel (Render all / buffer / scrolloff / pin).
    // ------------------------------------------------------------------------
    function mountRenderWindow() {
        var container = document.getElementById('page-container');
        if (!container) return;
        var pages = Array.prototype.slice.call(container.querySelectorAll('.pf'));
        if (!pages.length) return;

        var buffer = parseInt(localStorage.getItem('pdf2html-buffer') || '10', 10);
        if (isNaN(buffer) || buffer < 0) buffer = 10;
        var renderAll = localStorage.getItem('pdf2html-render-all') === '1';

        var idx = new Map();
        pages.forEach(function (p, i) { idx.set(p, i); });
        var visible = new Set();
        var selectionSpan = null;
        var raf = null;
        var allForced = false;

        function apply() {
            // Render-all: force every page once, then short-circuit — avoids
            // touching the DOM 797 times per observer callback during scroll.
            if (renderAll) {
                if (allForced) return;
                for (var i = 0; i < pages.length; i++) setPageForceRendered(pages[i], true);
                allForced = true;
                return;
            }
            allForced = false;

            var from, to;
            if (visible.size === 0) {
                from = 0;
                to = Math.min(pages.length - 1, buffer);
            } else {
                var first = Infinity, last = -1;
                visible.forEach(function (i) {
                    if (i < first) first = i;
                    if (i > last) last = i;
                });
                from = Math.max(0, first - buffer);
                to = Math.min(pages.length - 1, last + buffer);
            }
            if (selectionSpan) {
                from = Math.min(from, selectionSpan.start - 1);
                to = Math.max(to, selectionSpan.end - 1);
            }
            for (var j = 0; j < pages.length; j++) {
                var want = j >= from && j <= to;
                if (want !== pages[j].classList.contains('pdf2html-force')) {
                    setPageForceRendered(pages[j], want);
                }
            }
        }

        function syncSelectionSpan() {
            var next = selectionPageSpan(document.getSelection());
            var changed = !selectionSpan !== !next
                || (selectionSpan && next
                    && (selectionSpan.start !== next.start || selectionSpan.end !== next.end));
            if (!changed) return;
            selectionSpan = next;
            sched();
        }

        function sched() {
            if (raf) return;
            raf = requestAnimationFrame(function () { raf = null; apply(); });
        }

        var observer = new IntersectionObserver(function (entries) {
            for (var i = 0; i < entries.length; i++) {
                var n = idx.get(entries[i].target);
                if (n === undefined) continue;
                if (entries[i].isIntersecting) visible.add(n);
                else visible.delete(n);
            }
            sched();
        }, {
            root: container,
            rootMargin: '-20px 0px',  // discount slivers of pages peeking at edges
            threshold: 0,
        });
        pages.forEach(function (p) { observer.observe(p); });
        document.addEventListener('selectionchange', syncSelectionSpan);

        mountConfigPanel(buffer, renderAll, function (newBuffer) {
            buffer = newBuffer;
            sched();
        }, function (newAll) {
            renderAll = newAll;
            sched();
        });
        syncSelectionSpan();
    }

    // The settings modal and palette commands talk to state through these
    // three hidden inputs — they persist changes and fan out to the live
    // render window / pin system via the `change` event. Keeping them as
    // DOM elements (rather than pure variables) preserves the existing
    // setInputValueAndFire / toggleCheckboxAndFire plumbing the palette
    // already uses.
    function mountConfigPanel(initialBuffer, initialRenderAll, onBuffer, onAll) {
        var host = document.createElement('div');
        host.id = 'pdf2html-hidden-controls';
        host.setAttribute('aria-hidden', 'true');
        host.innerHTML =
            '<input type="checkbox" id="pdf2html-all-input">' +
            '<input type="number" id="pdf2html-buffer-input" min="0" max="2000">' +
            '<input type="number" id="pdf2html-scrolloff-input" min="0" max="50" step="1">' +
            '<input type="checkbox" id="pdf2html-pinned-input">';
        document.body.appendChild(host);

        var bufferInput = document.getElementById('pdf2html-buffer-input');
        bufferInput.value = initialBuffer;
        bufferInput.disabled = initialRenderAll;
        bufferInput.addEventListener('change', function () {
            var n = parseInt(bufferInput.value, 10);
            if (isNaN(n) || n < 0) n = 10;
            localStorage.setItem('pdf2html-buffer', String(n));
            onBuffer(n);
        });

        var allInput = document.getElementById('pdf2html-all-input');
        allInput.checked = initialRenderAll;
        allInput.addEventListener('change', function () {
            var on = allInput.checked;
            localStorage.setItem('pdf2html-render-all', on ? '1' : '0');
            bufferInput.disabled = on;
            onAll(on);
        });

        var scrollOffInput = document.getElementById('pdf2html-scrolloff-input');
        scrollOffInput.value = Math.round(scrollOffFraction * 100);
        scrollOffInput.addEventListener('change', function () {
            var p = parseInt(scrollOffInput.value, 10);
            if (isNaN(p)) p = 25;
            p = Math.max(0, Math.min(50, p));
            scrollOffFraction = p / 100;
            localStorage.setItem('pdf2html-scrolloff', String(scrollOffFraction));
            applyScrollOffStyle();
        });

        var pinnedInput = document.getElementById('pdf2html-pinned-input');
        pinnedInput.checked = pinned;
        pinnedInput.addEventListener('change', function () {
            pinned = pinnedInput.checked;
            localStorage.setItem('pdf2html-pinned', pinned ? '1' : '0');
            applyScrollOffStyle();
        });
    }


    // ------------------------------------------------------------------------
    // Outline active tracker — highlights the outline entry whose target page
    // is the deepest one still ≤ current page. Updates on scroll.
    // ------------------------------------------------------------------------
    function mountOutlineActiveTracker() {
        var outline = document.getElementById('outline');
        var pc = document.getElementById('page-container');
        if (!outline || !pc) return;

        var links = Array.prototype.slice.call(outline.querySelectorAll('a[href^="#pf"]'));
        if (!links.length) return;

        var targets = links.map(function (a) {
            var m = (a.getAttribute('href') || '').match(/#pf([0-9a-f]+)/i);
            return m ? parseInt(m[1], 16) : NaN;
        });

        var pages = document.querySelectorAll('.pf');
        // NOTE: cached offsets. If layout changes (e.g. zoom) these go stale.
        // Acceptable for outline highlight — worst case is slightly wrong
        // highlight until next scroll reset. Not worth an IntersectionObserver here.
        var offs = Array.prototype.map.call(pages, function (p) {
            return { t: p.offsetTop, b: p.offsetTop + p.offsetHeight };
        });
        var lastActive = -1;

        function setActive(active) {
            if (active === lastActive) return;
            if (lastActive >= 0) links[lastActive].classList.remove('pdf2html-active');
            if (active >= 0) {
                links[active].classList.add('pdf2html-active');
                try { links[active].scrollIntoView({ block: 'nearest' }); } catch (e) {}
            }
            lastActive = active;
        }

        function update() {
            var st = pc.scrollTop, sb = st + pc.clientHeight, bestIdx = 0, bestO = -1;
            for (var i = 0; i < offs.length; i++) {
                var o = Math.min(offs[i].b, sb) - Math.max(offs[i].t, st);
                if (o > bestO) { bestO = o; bestIdx = i; }
            }
            var cur = bestIdx + 1, active = -1;
            for (var j = 0; j < targets.length; j++) {
                if (!isNaN(targets[j]) && targets[j] <= cur) active = j;
            }
            setActive(active);
        }

        var raf = null;
        function sched() {
            if (raf) return;
            raf = requestAnimationFrame(function () { raf = null; update(); });
        }
        for (var k = 0; k < links.length; k++) (function (idx) {
            links[idx].addEventListener('click', function () { setActive(idx); });
        })(k);
        pc.addEventListener('scroll', sched, { passive: true });
        update();
    }


    // ------------------------------------------------------------------------
    // Page counter — small "N / total" pill at top-center, updates on scroll.
    // Tracks the current page by live viewport overlap against the currently
    // intersecting .pf frames, so it stays correct even when the page itself
    // doesn't happen to cover the viewport's exact center point.
    // ------------------------------------------------------------------------
    function mountPageCounter() {
        var container = document.getElementById('page-container');
        if (!container) return;
        var pages = Array.prototype.slice.call(container.querySelectorAll('.pf'));
        var total = pages.length;
        if (!total) return;

        var el = document.createElement('div');
        el.id = 'pdf2html-pageno';
        // Three zones: .side.left holds a chapter reference (e.g. "Ch. 3.8"),
        // .center holds the page numerals, .side.right holds a chapter/section
        // title. When only one of the two is available, it falls back to the
        // left. The pill's translateX is live-adjusted via --pageno-shift so
        // .center always lands on the viewport's exact horizontal middle,
        // regardless of side widths.
        el.innerHTML =
            '<span class="side left" hidden>' +
                '<span class="text"></span>' +
                '<span class="sep">·</span>' +
            '</span>' +
            '<span class="center">' +
                '<span class="cur" id="pdf2html-pageno-current">1</span>' +
                '<span class="sep">/</span>' +
                '<span class="tot">' + total + '</span>' +
            '</span>' +
            '<span class="side right" hidden>' +
                '<span class="sep">·</span>' +
                '<span class="text"></span>' +
            '</span>';
        document.body.appendChild(el);

        // Default: hidden. Only show if the user has explicitly enabled it
        // via ⌘⇧. or the `:counter` palette command (which writes '0').
        if (localStorage.getItem('pdf2html-pageno-hidden') !== '0') {
            document.body.classList.add('pageno-hidden');
        }
        var cur       = document.getElementById('pdf2html-pageno-current');
        var leftEl    = el.querySelector('.side.left');
        var rightEl   = el.querySelector('.side.right');
        var leftText  = leftEl.querySelector('.text');
        var rightText = rightEl.querySelector('.text');

        function recenterCenter() {
            // Two modes:
            //   (a) both sides visible → pin .center's midpoint to viewport
            //       midpoint by shifting the pill by half the side-width
            //       imbalance. Prevents the numerals from drifting when one
            //       title is much longer than the other.
            //   (b) zero or one side visible → leave the pill centered as a
            //       whole (shift=0). A single-sided pill pinned to viewport
            //       center looks lopsided because nothing visually balances
            //       the other side.
            if (leftEl.hidden || rightEl.hidden) {
                el.style.setProperty('--pageno-shift', '0px');
                return;
            }
            var pillGap = 8;
            var L = leftEl.offsetWidth  + pillGap;
            var R = rightEl.offsetWidth + pillGap;
            el.style.setProperty('--pageno-shift', ((R - L) / 2) + 'px');
        }
        // One observer handles both content changes (chapter update) and
        // viewport resizes that trip the pill's max-width clamp.
        try { new ResizeObserver(recenterCenter).observe(el); } catch (_) {}

        function updateChapter() {
            // Split active outline label into "Ch. N" + sub-title if it fits
            // the pdf2htmlEX common pattern "1.2 Title" or "Chapter 3: Title".
            var active = document.querySelector('#outline a.pdf2html-active');
            var label = active ? (active.textContent || '').trim() : '';
            var chapPart = '', subPart = '';
            if (label) {
                var m = label.match(/^\s*((?:\d+)(?:\.\d+)*)\s+(.*)$/);
                if (m) {
                    chapPart = 'Ch. ' + m[1];
                    subPart  = m[2];
                } else {
                    subPart  = label;
                }
            }
            // Chapter reference goes left, title goes right. If only one is
            // available, put it on the left so the pill stays compact rather
            // than awkwardly listing to one side.
            var lt = '', rt = '', leftKind = 'sub', rightKind = 'sub';
            if (chapPart && subPart) {
                lt = chapPart; rt = subPart; leftKind = 'muted'; rightKind = 'muted';
            } else if (chapPart) {
                lt = chapPart; leftKind = 'chap';
            } else if (subPart) {
                lt = subPart;
            }
            leftText.className   = 'text ' + leftKind;
            leftText.textContent = lt;
            rightText.className   = 'text ' + rightKind;
            rightText.textContent = rt;
            leftEl.hidden  = !lt;
            rightEl.hidden = !rt;
            recenterCenter();
        }

        var lastPageNum = -1;
        var visible = new Set();

        function pageNumFor(pf, fallback) {
            var m = (pf && pf.id || '').match(/pf([0-9a-f]+)/i);
            return m ? parseInt(m[1], 16) : fallback;
        }

        function bestVisiblePage() {
            var box = container.getBoundingClientRect();
            var candidates = visible.size ? Array.from(visible) : pages;
            var best = null;
            var bestOverlap = -1;
            for (var i = 0; i < candidates.length; i++) {
                var pf = candidates[i];
                var rect = pf.getBoundingClientRect();
                var overlap = Math.min(rect.bottom, box.bottom) - Math.max(rect.top, box.top);
                if (overlap > bestOverlap) {
                    bestOverlap = overlap;
                    best = pf;
                }
            }
            if (!best || bestOverlap <= 0) return null;
            return pageNumFor(best, 1);
        }

        function update() {
            // Always run — consumers like the thumbnails grid listen for
            // pdf2html-page-change regardless of whether the pageno pill
            // itself is visible. Text-content update is still guarded
            // behind the visibility class.
            var n = bestVisiblePage();
            if (!n) return;
            if (n !== lastPageNum) {
                lastPageNum = n;
                if (!document.body.classList.contains('pageno-hidden')) {
                    if (cur.textContent !== String(n)) cur.textContent = String(n);
                }
                updateChapter();
                document.dispatchEvent(new CustomEvent(
                    'pdf2html-page-change', { detail: { page: n } }));
            }
        }

        var observer = new IntersectionObserver(function (entries) {
            for (var i = 0; i < entries.length; i++) {
                if (entries[i].isIntersecting) visible.add(entries[i].target);
                else visible.delete(entries[i].target);
            }
            sched();
        }, {
            root: container,
            rootMargin: '-20px 0px',
            threshold: 0,
        });
        pages.forEach(function (p) { observer.observe(p); });

        var raf = null;
        function sched() {
            if (raf) return;
            raf = requestAnimationFrame(function () { raf = null; update(); });
        }
        container.addEventListener('scroll', function () {
            sched();
        }, { passive: true });
        setTimeout(update, 80);

        window.__pdf2htmlTogglePageno = function () {
            var hide = !document.body.classList.contains('pageno-hidden');
            document.body.classList.toggle('pageno-hidden', hide);
            localStorage.setItem('pdf2html-pageno-hidden', hide ? '1' : '0');
            if (!hide) update();
        };
    }

    // ------------------------------------------------------------------------
    // Resume position — jump back to the last-visited page on reopen.
    //
    // Key: `pdf2html-position:<hash>` → JSON {page, ts}. Written on every
    // pdf2html-page-change (debounced 400ms); read once at init. Skipped if
    // the URL already carries a `#pfXX` anchor (outline/bookmark deep-link
    // wins). Saved page 1 is treated as "nothing to resume."
    // ------------------------------------------------------------------------
    function mountResumePosition() {
        var hash = entryHash();
        if (!hash) return;
        var key = 'pdf2html-position:' + hash;

        if (!location.hash) {
            var saved = null;
            try { saved = JSON.parse(localStorage.getItem(key) || 'null'); } catch (_) {}
            if (saved && saved.page > 1) {
                var target = saved.page;
                var tries = 0;
                var restore = function () {
                    var pel = document.getElementById('pf' + target.toString(16));
                    if (pel && pel.offsetHeight > 0) {
                        pel.scrollIntoView({ block: 'start' });
                        return;
                    }
                    if (tries++ < 60) requestAnimationFrame(restore);
                };
                requestAnimationFrame(restore);
            }
        }

        var writeTimer = null;
        document.addEventListener('pdf2html-page-change', function (e) {
            var p = e.detail && e.detail.page;
            if (!p || p < 1) return;
            if (writeTimer) clearTimeout(writeTimer);
            writeTimer = setTimeout(function () {
                try {
                    localStorage.setItem(key, JSON.stringify({ page: p, ts: Date.now() }));
                } catch (_) {}
            }, 400);
        });
    }

    // ------------------------------------------------------------------------
    // Sidebar header — title + author/pages block at the top of #sidebar.
    //
    // Pulls from /<hash>/meta.json (written by scripts/extract-pdf-meta.sh).
    // Falls back to <title> if meta is missing or the fetch fails. Non-fatal:
    // the sidebar is fully usable without a header; this is chrome.
    // ------------------------------------------------------------------------
    function mountSidebarHeader() {
        var sidebar = document.getElementById('sidebar');
        if (!sidebar) return;

        var titleEl = el('div', { class: 'doc-title' }, document.title || 'Document');
        var metaEl  = el('div', { class: 'doc-meta' });
        var head = el('div', { id: 'pdf2html-sidebar-head' }, [
            el('div', { class: 'doc-text' }, [titleEl, metaEl]),
            el('button', {
                class: 'pdf2html-sidebar-close',
                title: 'Close sidebar (⌘. or ⌘B)',
                onClick: function () {
                    document.body.classList.remove('sidebar-shown');
                },
                html: svgIcon(ICONS.sidebar, 15),
            }),
        ]);
        sidebar.insertBefore(head, sidebar.firstChild);

        var hash = entryHash();
        if (!hash) return;
        var metaUrl = '/' + hash + '/meta.json';
        fetch(metaUrl, { cache: 'force-cache' }).then(function (r) {
            return r.ok ? r.json() : null;
        }).then(function (m) {
            if (!m) return;
            if (m.title) titleEl.textContent = String(m.title);
            var parts = [];
            if (m.author) parts.push(String(m.author));
            if (m.pages)  parts.push(String(m.pages) + ' pages');
            metaEl.textContent = parts.join(' · ');
        }).catch(function () { /* non-fatal */ });
    }


    function registerPagenoToggleHandler() {
        // ⌘⇧.
        document.addEventListener('keydown', function (e) {
            if (!(e.metaKey && e.shiftKey && e.code === 'Period')) return;
            if (isInputTarget(e.target)) return;
            e.preventDefault();
            if (window.__pdf2htmlTogglePageno) window.__pdf2htmlTogglePageno();
        });
    }


    // ------------------------------------------------------------------------
    // Scoped search (/) — find-in-visible-pages.
    //
    // Distinct from Vimium's / and from ⌘F: scope is the pages currently
    // intersecting the viewport at the moment of typing, and the viewport
    // never moves while typing. The reader refines the query without the
    // page jumping around; Enter is the explicit "take me there" action.
    //
    //   /        open the bar (stolen from Vimium via capture-phase handler)
    //   typing   live highlight across visible .pf frames — no scroll
    //   Enter    activate the hit closest to the cursor pin, scroll to it,
    //            then hide the bar (highlights persist — nvim hlsearch)
    //   n / N    next / prev hit (global after Enter, while highlights live)
    //   Esc      clear highlights; if bar is still open, closes that too
    //
    // Highlights use the CSS Custom Highlight API so we don't wrap nodes
    // inside pdf2htmlEX's positioned .t spans (which have utility classes
    // for letter- and word-spacing that DOM surgery would visibly break).
    // ------------------------------------------------------------------------
    var searchState = { hits: [], activeIdx: -1, entered: false };
    // When Enter promotes a hit to a browser Selection, the cursor-pin handler
    // (mountCursorPin) would see the resulting selectionchange and issue its
    // own competing scroll. Suppress it until our own smooth-scroll settles.
    var searchSuppressPinUntil = 0;

    // Single capture-phase handler owns every key that matters to search.
    // Listen on WINDOW at capture so we fire before any document- or
    // input-level listener (Vimium and friends hook those and can otherwise
    // swallow Enter / Esc before we see them).
    function mountSearch() {
        window.addEventListener('keydown', function (e) {
            // Finger mode owns its alphabet while active. Search is also a
            // window-capture listener registered earlier, so it must yield
            // explicitly for overlapping keys like `s`.
            if (fingerState) return;

            var bar = document.getElementById('pdf2html-search');
            var inSearchInput = e.target && e.target.id === 'pdf2html-search-input';

            // --- Bar open ------------------------------------------------
            // Esc closes the bar regardless of where focus has drifted to;
            // other keys only respond when the caret is actually in the
            // search input so we don't eat the reader's j/k/etc.
            if (bar) {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    closeSearch();
                    return;
                }
                if (!inSearchInput) return;
                if (e.key === 'Enter') {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    if (!searchState.hits.length) return;
                    searchState.entered = true;
                    searchState.activeIdx = indexOfClosestHitToViewport();
                    focusActiveHit();
                    dismissSearchBar();
                    return;
                }
                // Typing, arrows, backspace fall through to the input.
                return;
            }

            // --- Bar closed, no persistent hits: `/` or `s` opens search --
            if (!searchState.entered) {
                var opener = e.key === '/' || (e.key === 's' && !e.metaKey && !e.ctrlKey && !e.altKey);
                if (!opener) return;
                if (isInputTarget(e.target)) return;
                e.preventDefault();
                e.stopImmediatePropagation();
                openSearch();
                return;
            }

            // --- Bar closed, highlights persist (nvim hlsearch) ----------
            if (isInputTarget(e.target)) return;
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopImmediatePropagation();
                closeSearch();
                return;
            }
            if (e.key === 'n' || e.key === 'N') {
                e.preventDefault();
                e.stopImmediatePropagation();
                var n = searchState.hits.length;
                if (!n) return;
                var dir = e.key === 'n' ? 1 : -1;
                searchState.activeIdx = (searchState.activeIdx + dir + n) % n;
                focusActiveHit();
                return;
            }
            // `/` or `s` reopens for a fresh query — drops the existing state.
            if (e.key === '/' || (e.key === 's' && !e.metaKey && !e.ctrlKey && !e.altKey)) {
                e.preventDefault();
                e.stopImmediatePropagation();
                closeSearch();
                openSearch();
                return;
            }
            // Any other key: fall through. We keep nvim-style hlsearch —
            // highlights + n/N persist until explicit Esc. The
            // ::selection-hiding body class is dropped separately by the
            // selectionchange listener below, the moment the Selection
            // diverges from the active hit (Vimium V extending, mouse
            // drag, anything).
        }, true);

        // ::selection is transparent while body.pdf2html-search-entered is
        // set so the orange active-hit paint shows through. As soon as the
        // Selection is modified by anything that isn't our own n/N (Vimium
        // V extending via Selection.modify, click, mouse drag, …), flip
        // ::selection back to the default blue so the user can actually see
        // what's being selected. Range identity, not event source, is the
        // cleanest signal.
        document.addEventListener('selectionchange', function () {
            if (!document.body.classList.contains('pdf2html-search-entered')) return;
            var sel = window.getSelection();
            if (!sel || !sel.rangeCount) {
                document.body.classList.remove('pdf2html-search-entered');
                return;
            }
            var activeR = searchState.hits[searchState.activeIdx];
            if (!activeR) {
                document.body.classList.remove('pdf2html-search-entered');
                return;
            }
            var selR = sel.getRangeAt(0);
            try {
                if (selR.compareBoundaryPoints(Range.START_TO_START, activeR) !== 0
                 || selR.compareBoundaryPoints(Range.END_TO_END, activeR) !== 0) {
                    document.body.classList.remove('pdf2html-search-entered');
                }
            } catch (e) {
                // Detached / cross-document range — drop the class to be safe.
                document.body.classList.remove('pdf2html-search-entered');
            }
        });
    }

    function openSearch() {
        var ex = document.getElementById('pdf2html-search');
        // Re-pressing `/` while the bar is open toggles it closed, matching
        // how other overlay keys here behave.
        if (ex) { closeSearch(); return; }

        searchState = { hits: [], activeIdx: -1, entered: false };

        var input = el('input', {
            type: 'text',
            id: 'pdf2html-search-input',
            autocomplete: 'off',
            spellcheck: 'false',
            autocapitalize: 'off',
            placeholder: 'find in visible pages · Enter to jump · n/N next/prev',
        });
        var countEl = el('span', {
            class: 'pdf2html-search-count',
            id: 'pdf2html-search-count',
        });
        var wrap = el('div', { id: 'pdf2html-search' }, [
            el('div', { id: 'pdf2html-search-line' }, [
                el('span', { id: 'pdf2html-search-prompt' }, '/'),
                input,
                countEl,
                el('span', {
                    class: 'pdf2html-search-hint',
                    html:
                        '<span class="pdf2html-kbd sm">Enter</span> jump · ' +
                        '<span class="pdf2html-kbd sm">n</span>/' +
                        '<span class="pdf2html-kbd sm">N</span> nav · ' +
                        '<span class="pdf2html-kbd sm">Esc</span> close',
                }),
            ]),
        ]);
        document.body.appendChild(wrap);
        input.focus();

        // Live-update on typing. Enter / Esc / n / N are all handled by the
        // document capture-phase listener in mountSearch so they fire even
        // if something else (Vimium, extensions) has hooked this input.
        input.addEventListener('input', function () {
            searchState.entered = false;
            searchState.activeIdx = -1;
            updateSearchHits(input.value);
            updateSearchCount();
        });
    }

    function dismissSearchBar() {
        var ex = document.getElementById('pdf2html-search');
        if (ex) ex.remove();
    }

    function closeSearch() {
        // Selection was already promoted on Enter by focusActiveHit, so Vimium
        // V / ⌘C already work. Esc just tears down the visual affordances and
        // leaves whatever Selection is current alone. Drop the body class so
        // the ::selection color reverts from orange back to the default blue.
        var ex = document.getElementById('pdf2html-search');
        if (ex) ex.remove();
        clearSearchHighlights();
        document.body.classList.remove('pdf2html-search-entered');
        searchState = { hits: [], activeIdx: -1, entered: false };
    }

    function clearSearchHighlights() {
        try {
            if (window.CSS && CSS.highlights) {
                CSS.highlights.delete('pdf2html-search-hit');
                CSS.highlights.delete('pdf2html-search-active');
            }
        } catch (e) { /* Highlight API unsupported — nothing to clear */ }
    }

    // Scope rule: only pages currently intersecting the viewport AND actually
    // rendered (.pdf2html-force). Collapsed .pc elements contain no selectable
    // text anyway, so skipping them is free.
    function visiblePageFrames() {
        var pc = document.getElementById('page-container');
        if (!pc) return [];
        var pcRect = pc.getBoundingClientRect();
        var out = [];
        var pages = pc.querySelectorAll('.pf');
        for (var i = 0; i < pages.length; i++) {
            var pf = pages[i];
            if (!pf.classList.contains('pdf2html-force')) continue;
            var r = pf.getBoundingClientRect();
            if (r.bottom < pcRect.top || r.top > pcRect.bottom) continue;
            out.push(pf);
        }
        return out;
    }

    function updateSearchHits(raw) {
        clearSearchHighlights();
        searchState.hits = [];

        var q = (raw || '').trim();
        if (!q) return;
        if (!window.CSS || !CSS.highlights || typeof Highlight === 'undefined') {
            // No Highlight API support → bar still works but nothing paints.
            // Acceptable degradation; Comet is Chromium so this shouldn't fire.
            return;
        }

        var cs = isSearchCaseSensitive();
        var needle = cs ? q : q.toLowerCase();
        var pages = visiblePageFrames();
        var inactive = new Highlight();

        pages.forEach(function (pf) {
            var pc = pf.querySelector('.pc');
            if (!pc) return;
            var walker = document.createTreeWalker(pc, NodeFilter.SHOW_TEXT);
            var node;
            while ((node = walker.nextNode())) {
                var text = node.nodeValue;
                if (!text) continue;
                var hay = cs ? text : text.toLowerCase();
                var cursor = 0, idx;
                while ((idx = hay.indexOf(needle, cursor)) !== -1) {
                    var r = document.createRange();
                    try {
                        r.setStart(node, idx);
                        r.setEnd(node, idx + needle.length);
                        searchState.hits.push(r);
                        inactive.add(r);
                    } catch (e) { /* degenerate range, skip */ }
                    cursor = idx + needle.length;
                }
            }
        });

        if (searchState.hits.length) {
            CSS.highlights.set('pdf2html-search-hit', inactive);
        }
    }

    // Minimal-scroll rule, mirroring the cursor-pin scrolloff semantics:
    //   pinned=true                → cursor must sit at center; any offset
    //                                from 0.5·h is the scroll delta.
    //   pinned=false, margin = scrollOffFraction·h
    //                              → if the match's top lies inside
    //                                [margin, h - margin] the viewport does
    //                                NOT move. Outside that band, scroll the
    //                                minimum amount to pull it just inside
    //                                the nearest edge.
    //
    // Returns the delta to add to pc.scrollTop (0 when no scroll is needed).
    function scrollDeltaForRect(pc, rect) {
        var pcRect = pc.getBoundingClientRect();
        var h = pc.clientHeight;
        var y = rect.top - pcRect.top;
        if (pinned) return y - h * 0.5;
        var margin = h * scrollOffFraction;
        if (y < margin) return y - margin;
        if (y > h - margin) return y - (h - margin);
        return 0;
    }

    // Enter's first pick: the match that needs the smallest scroll. If any
    // matches are already inside the safe band their delta is 0, so the
    // first-in-DOM such match wins — "select what's already on screen"
    // rather than "teleport to the nearest one above center".
    function indexOfClosestHitToViewport() {
        if (!searchState.hits.length) return 0;
        var pc = document.getElementById('page-container');
        if (!pc) return 0;
        var bestIdx = 0, bestDist = Infinity;
        for (var i = 0; i < searchState.hits.length; i++) {
            var d = Math.abs(scrollDeltaForRect(pc, searchState.hits[i].getBoundingClientRect()));
            if (d < bestDist) { bestDist = d; bestIdx = i; }
        }
        return bestIdx;
    }

    function focusActiveHit() {
        var range = searchState.hits[searchState.activeIdx];
        if (!range) { updateSearchCount(); return; }

        // Rebuild the two highlight groups so the active range moves between
        // them. The CSS Highlight API has no per-range style — we partition.
        // active.priority > 0 keeps the orange paint on top of the browser's
        // built-in ::selection paint that we set below (custom-highlight
        // priority can outrank ::selection in Chromium).
        try {
            if (window.CSS && CSS.highlights) {
                var inactive = new Highlight();
                for (var i = 0; i < searchState.hits.length; i++) {
                    if (i !== searchState.activeIdx) inactive.add(searchState.hits[i]);
                }
                var active = new Highlight();
                active.add(range);
                active.priority = 10;
                CSS.highlights.set('pdf2html-search-hit', inactive);
                CSS.highlights.set('pdf2html-search-active', active);
            }
        } catch (e) { /* no highlight API → skip re-paint */ }

        var pc = document.getElementById('page-container');
        if (pc) {
            var delta = scrollDeltaForRect(pc, range.getBoundingClientRect());
            if (Math.abs(delta) >= 1) pc.scrollBy({ top: delta, behavior: 'smooth' });
        }

        // Promote the active range to a real browser Selection so Vimium's V
        // and ⌘C work immediately after Enter — no Esc-to-promote detour.
        // Suppress the cursor-pin selectionchange reaction briefly so its
        // scroll doesn't fight our own smooth-scroll above. The body class
        // recolors ::selection to orange so the native selection paint
        // doesn't cover our custom active highlight (Chromium paints
        // built-in pseudos on top of custom highlights regardless of
        // Highlight.priority).
        searchSuppressPinUntil = performance.now() + 500;
        try {
            var sel = window.getSelection();
            if (sel) {
                sel.removeAllRanges();
                sel.addRange(range);
            }
            document.body.classList.add('pdf2html-search-entered');
        } catch (e) { /* detached / cross-origin range — ignore */ }

        updateSearchCount();
    }

    function updateSearchCount() {
        var cEl = document.getElementById('pdf2html-search-count');
        if (!cEl) return;
        var n = searchState.hits.length;
        if (!n) { cEl.textContent = ''; return; }
        // "· / N" while still typing; "K / N" once Enter has activated a hit.
        var cur = searchState.activeIdx >= 0
            ? String(searchState.activeIdx + 1)
            : '·';
        cEl.textContent = cur + ' / ' + n;
    }


    // ------------------------------------------------------------------------
    // Native browser find shadow layer — Cmd-F across the full document without
    // render-all.
    //
    // Chromium's native find skips text under display:none. Our render window
    // deliberately hides non-buffered `.pc` elements that way, so Cmd-F only
    // sees the current render buffer. Conversion/cache-upgrade writes
    // <hash>/text.json with one plain-text blob per page; this mounts those
    // blobs as clipped 1px nodes under non-rendered `.pf` wrappers. They stay
    // in layout for browser-find indexing, but they do not paint or affect the
    // pdf2htmlEX visible layer.
    //
    // The strict invariant is one searchable source per page: rendered pages
    // have real `.pc` text and no shadow node; non-rendered pages have shadow
    // text and hidden `.pc` content. Selection bridging below promotes shadow
    // hits to real `.t` ranges after native find has used the shadow layer to
    // discover the page.
    // ------------------------------------------------------------------------
    function mountNativeFindShadowLayer() {
        var hash = entryHash();
        var container = document.getElementById('page-container');
        if (!hash || !container) return;
        mountNativeFindSelectionBridge();

        fetch('/' + hash + '/text.json', { cache: 'no-store' }).then(function (r) {
            return r.ok ? r.json() : null;
        }).then(function (payload) {
            if (!payload || payload.version !== 1 || !Array.isArray(payload.pages)) return;
            mountFindShadowPages(payload.pages);
        }).catch(function () { /* Missing text.json is non-fatal for old cache entries. */ });
    }

    var nativeFindShadowTextByPage = new Map();

    function mountFindShadowPages(pages) {
        var queue = [];
        for (var i = 0; i < pages.length; i++) {
            var page = parseInt(pages[i] && pages[i].page, 10);
            var text = pages[i] && pages[i].text;
            if (!page || typeof text !== 'string' || !text.trim()) continue;
            nativeFindShadowTextByPage.set(page, text);
            queue.push(page);
        }
        if (!queue.length) return;

        var idx = 0;
        function work(deadline) {
            var start = performance.now();
            while (idx < queue.length) {
                ensureFindShadowPage(queue[idx]);
                idx += 1;

                // Keep startup responsive on large textbooks. requestIdleCallback
                // gives us a real budget; the timeout fallback caps each slice.
                if (deadline && deadline.timeRemaining && deadline.timeRemaining() < 2) break;
                if (!deadline && performance.now() - start > 8) break;
            }
            if (idx < queue.length) scheduleIdle(work);
            else document.body.classList.add('pdf2html-find-shadow-ready');
        }
        scheduleIdle(work);
    }

    function setPageForceRendered(pf, forced) {
        if (!pf) return;
        if (forced) {
            removeFindShadowElement(pf);
            pf.classList.add('pdf2html-force');
        } else {
            pf.classList.remove('pdf2html-force');
            ensureFindShadowPage(pageNumberFromElement(pf));
        }
    }

    function ensureFindShadowPage(page) {
        if (!page) return;
        var pf = pageElement(page);
        if (!pf) return;
        if (pf.classList.contains('pdf2html-force')) {
            removeFindShadowElement(pf);
            return;
        }
        var existing = pf.querySelector('.pdf2html-find-shadow');
        if (existing && existing.parentElement === pf) return;

        var text = nativeFindShadowTextByPage.get(page);
        if (typeof text !== 'string' || !text.trim()) return;

        var shadow = document.createElement('div');
        shadow.className = 'pdf2html-find-shadow';
        shadow.setAttribute('aria-hidden', 'true');
        shadow.dataset.pageNo = String(page);
        shadow.textContent = text;
        pf.appendChild(shadow);
    }

    function removeFindShadowElement(pf) {
        var nodes = pf.querySelectorAll('.pdf2html-find-shadow');
        for (var i = 0; i < nodes.length; i++) nodes[i].remove();
    }

    var nativeFindBridgeMounted = false;
    var nativeFindBridgeActive = false;
    var nativeFindBridgeSeq = 0;
    var nativeFindPageIndexCache = new WeakMap();

    function mountNativeFindSelectionBridge() {
        if (nativeFindBridgeMounted) return;
        nativeFindBridgeMounted = true;

        document.addEventListener('selectionchange', function () {
            if (nativeFindBridgeActive) return;
            var sel = window.getSelection();
            if (!sel || !sel.rangeCount || !sel.anchorNode) return;

            var range = sel.getRangeAt(0);
            var shadow = shadowElementForRange(range);
            if (!shadow) return;

            var selectedText = sel.toString();
            if (!selectedText) return;

            var startOffset = rangeOffsetInside(shadow, range);
            if (startOffset == null) return;

            var page = parseInt(shadow.dataset.pageNo || '', 10);
            if (!page) return;

            var seq = ++nativeFindBridgeSeq;
            requestAnimationFrame(function () {
                if (seq !== nativeFindBridgeSeq) return;
                promoteNativeFindShadowSelection(page, selectedText, startOffset);
            });
        });
    }

    function shadowElementForRange(range) {
        var a = nodeElement(range.startContainer);
        var b = nodeElement(range.endContainer);
        var sa = a && a.closest ? a.closest('.pdf2html-find-shadow') : null;
        var sb = b && b.closest ? b.closest('.pdf2html-find-shadow') : null;
        return sa && sa === sb ? sa : null;
    }

    function nodeElement(node) {
        if (!node) return null;
        return node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    }

    function rangeOffsetInside(root, range) {
        try {
            var pre = document.createRange();
            pre.selectNodeContents(root);
            pre.setEnd(range.startContainer, range.startOffset);
            return pre.toString().length;
        } catch (e) {
            return null;
        }
    }

    function promoteNativeFindShadowSelection(page, selectedText, shadowStartOffset) {
        var pf = pageElement(page);
        if (!pf) return;
        var pc = pf.querySelector('.pc');
        var shadow = pf.querySelector('.pdf2html-find-shadow');
        if (!pc || !shadow) return;

        var occurrence = occurrenceIndexBefore(
            shadow.textContent || '', selectedText, shadowStartOffset);

        var index = buildRealPageTextIndex(pc);
        var start = nthIndexOf(index.text, selectedText, occurrence);
        if (start < 0) start = index.text.indexOf(selectedText);
        if (start < 0) return;

        var realRange = realRangeFromIndex(index, start, selectedText.length);
        if (!realRange) return;

        nativeFindBridgeActive = true;
        searchSuppressPinUntil = performance.now() + 500;
        try {
            // Mapping is complete, so it is now safe to remove the shadow node
            // that native find selected and expose the real text instead.
            setPageForceRendered(pf, true);

            var sel = window.getSelection();
            if (sel) {
                sel.removeAllRanges();
                sel.addRange(realRange);
            }
            scrollRealRangeIntoView(realRange);
        } catch (e) {
            // Leave the browser's native shadow selection alone if the real
            // page range detached while rendering settled.
        } finally {
            setTimeout(function () { nativeFindBridgeActive = false; }, 0);
        }
    }

    function occurrenceIndexBefore(text, needle, offset) {
        if (!needle) return 0;
        var n = 0;
        var cursor = 0;
        var idx;
        while ((idx = text.indexOf(needle, cursor)) !== -1 && idx < offset) {
            n += 1;
            cursor = idx + needle.length;
        }
        return n;
    }

    function nthIndexOf(text, needle, occurrence) {
        if (!needle) return -1;
        var cursor = 0;
        var idx = -1;
        for (var i = 0; i <= occurrence; i++) {
            idx = text.indexOf(needle, cursor);
            if (idx === -1) return -1;
            cursor = idx + needle.length;
        }
        return idx;
    }

    function buildRealPageTextIndex(pc) {
        var cached = nativeFindPageIndexCache.get(pc);
        if (cached) return cached;

        var text = '';
        var map = [];
        var lines = pc.querySelectorAll('.t');

        function appendMapped(raw, nodes) {
            var start = raw.search(/\S/);
            if (start === -1) return;
            var end = raw.length;
            while (end > start && /\s/.test(raw.charAt(end - 1))) end--;
            if (text) {
                text += '\n';
                map.push(null);
            }
            for (var i = start; i < end; i++) {
                text += raw.charAt(i);
                map.push(nodes[i] || null);
            }
        }

        for (var i = 0; i < lines.length; i++) {
            var raw = '';
            var nodes = [];
            var walker = document.createTreeWalker(lines[i], NodeFilter.SHOW_TEXT);
            var node;
            while ((node = walker.nextNode())) {
                for (var j = 0; j < node.nodeValue.length; j++) {
                    raw += node.nodeValue.charAt(j);
                    nodes.push({ node: node, offset: j });
                }
            }
            appendMapped(raw, nodes);
        }

        if (!lines.length) {
            var fallback = document.createTreeWalker(pc, NodeFilter.SHOW_TEXT);
            var fnode;
            while ((fnode = fallback.nextNode())) {
                for (var k = 0; k < fnode.nodeValue.length; k++) {
                    text += fnode.nodeValue.charAt(k);
                    map.push({ node: fnode, offset: k });
                }
            }
        }

        var out = { text: text, map: map };
        nativeFindPageIndexCache.set(pc, out);
        return out;
    }

    function realRangeFromIndex(index, start, length) {
        var map = index.map;
        var end = start + length - 1;
        if (start < 0 || end >= map.length) return null;

        var first = null;
        var last = null;
        for (var i = start; i <= end; i++) {
            if (!first && map[i]) first = map[i];
            if (map[i]) last = map[i];
        }
        if (!first || !last) return null;

        var r = document.createRange();
        try {
            r.setStart(first.node, first.offset);
            r.setEnd(last.node, last.offset + 1);
            return r;
        } catch (e) {
            return null;
        }
    }

    function scrollRealRangeIntoView(range) {
        var pc = document.getElementById('page-container');
        if (!pc) return;
        var rect = range.getBoundingClientRect();
        if (rect.top === 0 && rect.bottom === 0 && rect.left === 0) return;
        var delta = scrollDeltaForRect(pc, rect);
        if (Math.abs(delta) >= 1) pc.scrollBy({ top: delta, behavior: 'smooth' });
    }

    function scheduleIdle(fn) {
        if (window.requestIdleCallback) {
            window.requestIdleCallback(fn, { timeout: 500 });
        } else {
            setTimeout(function () { fn(null); }, 0);
        }
    }


    // ------------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------------
    function isInputTarget(t) {
        return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
    }
})();

// Page counter — the "Ch. 3 · 12 / 340 · Title" pill at top-center.
//
// Hidden by default; ⌘⇧. or `:counter` toggles the pageCounterVisible
// preference. It only displays the reading position that navigation
// tracks (pdf2html-page-change / pdf2html-chapter-change).
export function createPageCounter(core) {
    var document = core.document;
    var prefs = core.prefs;
    var navigation = core.navigation;
    var documentModel = core.documentModel;
    var isInputTarget = core.isInputTarget;

    var pill, cur, leftEl, rightEl, leftText, rightText;
    // The first page-change event is the load itself, not a move.
    var seenFirstPage = false;

    var flashTimer = null;

    function applyVisibility() {
        var visible = prefs.get('pageCounterVisible');
        document.body.classList.toggle('pageno-hidden', !visible);
        if (visible) render();
    }
    // Brief mode: the hidden counter appears for a moment on a page change.
    function flash() {
        if (prefs.get('pageCounterVisible') || !prefs.get('pageCounterBrief')) return;
        document.body.classList.add('pageno-flash');
        render();
        if (flashTimer) clearTimeout(flashTimer);
        flashTimer = setTimeout(function () {
            flashTimer = null;
            document.body.classList.remove('pageno-flash');
        }, 1400);
    }

    function render() {
        if (!pill) return;
        cur.textContent = String(navigation.page());
        renderChapter(navigation.chapter());
    }

    // Split the active outline label into "Ch. N" + title when it follows the
    // common "1.2 Title" pattern. The chapter reference goes left and the
    // title right; with only one part, it goes left so the pill stays compact.
    function renderChapter(entry) {
        var deep = entry;
        if (entry) {
            var list = navigation.entries();
            var rootLi = entry.link.closest('li');
            while (rootLi && rootLi.parentElement && rootLi.parentElement.closest('li')) rootLi = rootLi.parentElement.closest('li');
            entry = list.find(function (e) { return e.link.closest('li') === rootLi; }) || entry;
        }
        pill.title = deep && deep !== entry ? entry.label + ' · ' + deep.label : (entry ? entry.label : '');
        var label = entry ? entry.label : '';
        var chap = '', sub = '';
        var m = label.match(/^\s*((?:\d+)(?:\.\d+)*)\s+(.*)$/);
        if (m) { chap = 'Ch. ' + m[1]; sub = m[2]; } else sub = label;
        var lt = '', rt = '', leftKind = 'sub', rightKind = 'sub';
        if (chap && sub) { lt = chap; rt = sub; leftKind = rightKind = 'muted'; }
        else if (chap) { lt = chap; leftKind = 'chap'; }
        else if (sub) lt = sub;
        leftText.className = 'text ' + leftKind;
        leftText.textContent = lt;
        rightText.className = 'text ' + rightKind;
        rightText.textContent = rt;
        leftEl.hidden = !lt;
        rightEl.hidden = !rt;
        recenter();
    }

    // With both sides visible, shift the pill by half the side-width
    // imbalance so the numerals sit on the viewport's exact middle. With zero
    // or one side, centre the pill as a whole: a single-sided pill pinned to
    // the middle looks lopsided.
    function recenter() {
        if (leftEl.hidden || rightEl.hidden) {
            pill.style.setProperty('--pageno-shift', '0px');
            return;
        }
        var gap = 8;
        var L = leftEl.offsetWidth + gap;
        var R = rightEl.offsetWidth + gap;
        pill.style.setProperty('--pageno-shift', ((R - L) / 2) + 'px');
    }

    function mount() {
        var total = documentModel.totalPages();
        if (!total) return;
        pill = document.createElement('button');
        pill.type = 'button';
        pill.setAttribute('aria-label', 'Open pages');
        pill.addEventListener('click', function () { document.querySelector('[data-tab="thumbs"]').click(); document.body.classList.add('sidebar-shown'); });
        pill.id = 'pdf2html-pageno';
        pill.innerHTML =
            '<span class="side left" hidden><span class="text"></span><span class="sep">·</span></span>' +
            '<span class="center">' +
                '<span class="cur" id="pdf2html-pageno-current">1</span>' +
                '<span class="sep">/</span><span class="tot">' + total + '</span>' +
            '</span>' +
            '<span class="side right" hidden><span class="sep">·</span><span class="text"></span></span>';
        document.body.appendChild(pill);
        cur = document.getElementById('pdf2html-pageno-current');
        leftEl = pill.querySelector('.side.left');
        rightEl = pill.querySelector('.side.right');
        leftText = leftEl.querySelector('.text');
        rightText = rightEl.querySelector('.text');
        // Content changes and viewport resizes can trip the max-width clamp.
        try { new ResizeObserver(recenter).observe(pill); } catch (_) {}

        document.addEventListener('pdf2html-page-change', function (e) {
            if (e.detail && e.detail.page) cur.textContent = String(e.detail.page);
            if (seenFirstPage) flash();
            seenFirstPage = true;
        });
        document.addEventListener('pdf2html-chapter-change', function (e) {
            renderChapter(e.detail && e.detail.entry);
        });
        prefs.onChange('pageCounterVisible', applyVisibility);
        applyVisibility();

        document.addEventListener('keydown', function (e) {
            if (!(e.metaKey && e.shiftKey && e.code === 'Period')) return;
            if (isInputTarget(e.target)) return;
            e.preventDefault();
            prefs.toggle('pageCounterVisible');
        });
    }

    return { mount: mount };
}

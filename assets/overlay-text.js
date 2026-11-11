// Text: page-wise selection reshaping, text extraction (`:yank`) and the
// clipboard.
export function createTextInteraction(core) {
    var document = core.document;
    var window = core.window;
    var navigator = core.navigator;
    var navigation = core.navigation;
    var documentModel = core.documentModel;
    var scrollOff = core.scrollOff;
    var readerText = core.readerText;

    // ---------------------------------------------------------------- selection
    function selectionPageSpan(sel) {
        if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
        var anchorPage = documentModel.pageNumberFromNode(sel.anchorNode);
        var focusPage = documentModel.pageNumberFromNode(sel.focusNode);
        if (!anchorPage || !focusPage) return null;
        return {
            start: Math.min(anchorPage, focusPage),
            end: Math.max(anchorPage, focusPage),
            anchor: anchorPage,
            focus: focusPage,
        };
    }

    // e/q/E with an active selection: move its focus end by pages, anchor
    // fixed. Forward lands at the start of the target page, backward at its
    // end. False when there is no selection to extend.
    function extendSelectionByPage(delta) {
        var sel = window.getSelection();
        var span = selectionPageSpan(sel);
        if (!span || typeof sel.extend !== 'function') return false;
        var total = documentModel.totalPages();
        if (!total) return false;
        var targetPage = Math.max(1, Math.min(total, span.focus + delta));
        if (targetPage === span.focus) return true;
        var pos = documentModel.pageTextBoundaryPosition(targetPage, delta > 0);
        if (!pos) return false;
        document.body.classList.remove('pdf2html-search-entered');
        try {
            sel.extend(pos.node, pos.offset);
            return true;
        } catch (e) {
            return false;
        }
    }

    // `c` with an active selection: select the whole outline chapter that
    // contains the selection's focus.
    function selectCurrentChapterFromSelection() {
        var sel = window.getSelection();
        var span = selectionPageSpan(sel);
        if (!span) return false;
        var chapter = navigation.chapterRange(span.focus);
        if (!chapter) return false;
        var startPos = documentModel.pageTextBoundaryPosition(chapter.start, true);
        var endPos = documentModel.pageTextBoundaryPosition(chapter.end - 1, false);
        if (!startPos || !endPos) return false;
        document.body.classList.remove('pdf2html-search-entered');
        try {
            // A selection reshape: let the browser's own selection scroll
            // carry the viewport, and keep caret follow from adding a second,
            // competing scroll.
            scrollOff.suppressFollow(500);
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

    // --------------------------------------------------------------- extraction
    // Each pdf2htmlEX visual line is a `.t`; documentModel.pageText joins them
    // with '\n' to keep the line structure that textContent would collapse.
    // Offscreen pages keep their DOM (content-visibility), so this reads the
    // whole document. A reader document may still be loading text: wait for
    // the pages first, and name any whose text could not be loaded rather
    // than copy a partial document silently.
    function pageRangeText(startPage, endPageExcl) {
        return readerText.whenLoaded(startPage, endPageExcl).then(function (loaded) {
            var missing = loaded.missing || [];
            var out = [];
            for (var p = startPage; p < endPageExcl; p++) {
                var t = missing.indexOf(p) >= 0 ? '[text of page ' + p + ' could not be loaded]'
                    : documentModel.pageText(p);
                if (t) out.push(t);
            }
            return out.join('\n\n');
        });
    }

    function yankRef() {
        var page = navigation.page();
        var chapter = navigation.chapterLabel();
        writeClip((chapter ? chapter + ' · ' : '') + 'p. ' + page);
    }
    function yankPage() {
        var page = navigation.page();
        pageRangeText(page, page + 1).then(writeClip);
    }
    function yankChapter() {
        var r = navigation.chapterRange(navigation.page());
        if (!r) return;
        pageRangeText(r.start, r.end).then(function (body) {
            writeClip((r.label ? r.label + '\n\n' : '') + body);
        });
    }
    function yankDocument() {
        pageRangeText(1, documentModel.totalPages() + 1).then(function (body) {
            if (!body) return;
            writeClip((document.title || 'Document').trim() + '\n\n' + body);
        });
    }
    function dispatchYank(kind) {
        var k = (kind || '').toLowerCase().trim();
        if (k === 'page') yankPage();
        else if (k === 'chapter' || k === 'ch') yankChapter();
        else if (k === 'document' || k === 'doc') yankDocument();
        else yankRef();
    }

    // ---------------------------------------------------------------- clipboard
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

    // execCommand('copy') through a temporary textarea, restoring the
    // reader's selection and focus afterwards.
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

    return {
        extendSelectionByPage: extendSelectionByPage,
        selectCurrentChapterFromSelection: selectCurrentChapterFromSelection,
        dispatchYank: dispatchYank,
        writeClip: writeClip,
    };
}

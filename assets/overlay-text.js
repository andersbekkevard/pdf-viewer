// Text: page-wise selection reshaping, text extraction (`:yank`) and the
// clipboard.
export function createTextInteraction(core) {
    var document = core.document;
    var window = core.window;
    var navigator = core.navigator;
    var navigation = core.navigation;
    var documentModel = core.documentModel;
    var scrollOff = core.scrollOff;
    var notify = core.notify || function () {};
    var sourceRef = core.sourceRef || function () { return ''; };
    var location = core.location;

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
    // whole document.
    function pageRangeText(startPage, endPageExcl) {
        var out = [];
        for (var p = startPage; p < endPageExcl; p++) {
            var t = documentModel.pageText(p);
            if (t) out.push(t);
        }
        return out.join('\n\n');
    }

    // Copy, then say what was copied (or that nothing was).
    function copy(value, what) {
        if (!value) { notify('Nothing to copy', { error: true }); return; }
        writeClip(value).then(function (ok) {
            if (ok) notify('Copied ' + what);
            else notify('Could not copy to the clipboard', { error: true });
        });
    }
    function plural(n, word) { return n.toLocaleString() + ' ' + word + (n === 1 ? '' : 's'); }

    // "Title, Chapter, p. 12" for a page, and the same with where the
    // document came from, as the last line of a quote.
    function reference(page) {
        var entry = navigation.chapterAt(page);
        var parts = [(document.title || 'Document').trim()];
        if (entry && entry.label) parts.push(entry.label);
        parts.push('p. ' + page);
        return parts.join(', ');
    }
    function yankRef() {
        var page = navigation.page();
        var chapter = navigation.chapterLabel();
        copy((chapter ? chapter + ' · ' : '') + 'p. ' + page, 'reference');
    }
    function yankPage() {
        var page = navigation.page();
        copy(documentModel.pageText(page), 'page ' + page);
    }
    function yankChapter() {
        var r = navigation.chapterRange(navigation.page());
        if (!r) { notify('This document has no chapters', { error: true }); return; }
        copy((r.label ? r.label + '\n\n' : '') + pageRangeText(r.start, r.end),
            'chapter (' + plural(r.end - r.start, 'page') + ')');
    }
    function yankDocument() {
        var total = documentModel.totalPages();
        var body = pageRangeText(1, total + 1);
        copy(body ? (document.title || 'Document').trim() + '\n\n' + body : '', 'document (' + plural(total, 'page') + ')');
    }
    // The selection as a quote that says where it is from, for pasting into
    // notes or a model's context:
    //
    //   > the selected text, lines rejoined
    //
    //   Title, Chapter, p. 12
    //   <source path or URL>
    //   <link that reopens the document at that page>
    function yankQuote() {
        var sel = window.getSelection();
        var span = selectionPageSpan(sel);
        var raw = sel ? sel.toString() : '';
        if (!span || !raw.trim()) { notify('Select some text first', { error: true }); return; }
        // A line break inside a paragraph is layout; a word hyphenated across
        // it is one word.
        var quote = raw.replace(/\r/g, '').replace(/([A-Za-z\u00C0-\u024F])-\n(?=[a-z\u00DF-\u024F])/g, '$1')
            .replace(/\n{2,}/g, '\u0000').replace(/\s*\n\s*/g, ' ').replace(/\u0000/g, '\n\n').trim();
        var pages = span.start === span.end ? 'p. ' + span.start : 'pp. ' + span.start + '–' + span.end;
        var lines = ['> ' + quote.replace(/\n\n/g, '\n>\n> '), '', reference(span.start).replace(/p\. \d+$/, pages)];
        var source = sourceRef();
        if (source) lines.push(source);
        if (location) lines.push(location.origin + location.pathname + '#page=' + span.start);
        copy(lines.join('\n'), 'quote with reference (' + pages + ')');
    }
    function dispatchYank(kind) {
        var k = (kind || '').toLowerCase().trim();
        if (k === 'page') yankPage();
        else if (k === 'chapter' || k === 'ch') yankChapter();
        else if (k === 'document' || k === 'doc') yankDocument();
        else if (k === 'quote' || k === 'q' || k === 'selection') yankQuote();
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

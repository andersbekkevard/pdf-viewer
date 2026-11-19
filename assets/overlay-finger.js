// ============================================================================
// pdf_viewer overlay — finger ("hint") mode.
//
// Extracted verbatim from overlay.js. Hint-to-copy mode for
// visible URL / DOI / ISBN / long-ID tokens, using only keys in the Vimium
// pass-through alphabet. The cluster owns its own `fingerState`; the entry
// module observes activeness via the returned `isActive()` accessor.
//
// Interface (passed in `core`):
//   - closeSearch()        — dismiss the find bar before opening hints
//   - visiblePages()       — .pf frames intersecting the viewport, to scan
//   - writeClip(text)      — copy a matched token to the clipboard
//
// Returns: { openFingerMode, closeFingerMode, isActive }
// ============================================================================
export function createFinger(core) {
    var closeSearch = core.closeSearch;
    var visiblePages = core.visiblePages;
    var writeClip = core.writeClip;

    // Owned here; the entry module observes activeness via isActive().
    var fingerState = null;

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
        var pages = visiblePages();
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

    function isActive() { return !!fingerState; }

    return {
        openFingerMode: openFingerMode,
        closeFingerMode: closeFingerMode,
        isActive: isActive,
    };
}

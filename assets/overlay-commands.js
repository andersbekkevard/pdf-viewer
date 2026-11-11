// Command surfaces: the `:` palette, quick open (⌘O / ⌘P / ⌘K, in
// overlay-quickopen.js) and the `?` cheatsheet, all driven by one COMMANDS table.
import { escapeHtml, middleEllipsis, removeOverlay } from './overlay-dom.js';
import { createQuickOpen } from './overlay-quickopen.js';

export function createCommandSurface(core) {
    var document = core.document;
    var window = core.window;
    var location = core.location;
    var prefs = core.prefs;
    var zoom = core.zoom;
    var navigation = core.navigation;
    var text = core.text;
    var library = core.library;
    var finger = core.finger;
    var settings = core.settings;
    var isInputTarget = core.isInputTarget;
    var notify = core.notify || function () {};

    // ------------------------------------------------------------------------
    // Cheatsheet — `?` toggles, `:help` opens. Two columns: viewer keys on the
    // left, the command reference (generated from COMMANDS) on the right.
    // ------------------------------------------------------------------------
    var KEY_SECTIONS = [
        { title: 'Viewer', rows: [
            [[['⌘', '.'], ['⌘', 'B']], 'Toggle sidebar'],
            [[['Ctrl', 'J'], ['Ctrl', 'K'], ['↓'], ['↑']], 'Sidebar: move Outline / Pages / Pins selector; Enter jumps'],
            [[['←', 'h'], ['→', 'l']], 'Outline: collapse / expand branch; Ctrl-←/→ switches tabs'],
            [[['e'], ['q'], ['E']], 'Next / prev page (count prefix: 10e); a selection extends pagewise'],
            [[['→'], ['←']], 'Next / prev page (sidebar closed)'],
            [[['↓'], ['↑']], 'Scroll'],
            [[['c'], ['C']], 'Next / prev chapter (count prefix: 3c); a selection + c selects the chapter'],
            [[['⌘', '+'], ['⌘', '−'], ['⌘', '0']], 'Zoom in / out / back to fit-width'],
            [[['⌘', 'Z'], ['⌘', '⇧', 'Z']], 'Back to before the last jump / forward again'],
            [[['Space'], ['⇧', 'Space']], 'Scroll one screen down / up'],
            [[['Ctrl', '⇧', 'P'], ['Ctrl', '⇧', 'O']], 'Drop pin / return to latest pin'],
            [[['⌘', '⇧', '.']], 'Toggle page counter'],
        ] },
        { title: 'Modes', rows: [
            [[[':']], 'Command palette (Tab / ^J / ^K to cycle)'],
            [[['⌘', 'O']], 'Go to a section or page of this document'],
            [[['⌘', 'P']], 'Open a document; Enter alone goes back to the previous one'],
            [[['⌘', 'K']], 'Search sections, documents and commands together'],
            [[['⌘', ',']], 'Settings'],
            [[['/'], ['s']], 'Find in visible pages (Enter jumps, n / N cycle)'],
            [[['Ctrl', 'f']], 'Finger visible URL / DOI / ISBN / ID tokens; hint copies'],
            [[['?']], 'Toggle this cheatsheet'],
            [[['Esc']], 'Close overlay / clear selection'],
        ] },
        { title: 'Vimium (external)', rows: [
            [[['j'], ['k'], ['d'], ['u']], 'Scroll'],
            [[['v']], 'Visual mode (extend with j/k/w/b)'],
            [[['m', '{a-z}'], ["'", '{a-z}']], 'Set / jump to Vimium mark'],
            [[['g', 'g'], ['G']], 'Top / bottom of document'],
        ] },
    ];

    function toggleCheatsheet() {
        if (closeHelp()) return;
        var bg = document.createElement('div');
        bg.id = 'pdf2html-cheatsheet';
        bg.innerHTML = cheatsheetHTML();
        bg.querySelector('.close').addEventListener('click', closeHelp);
        bg.addEventListener('click', function (ev) { if (ev.target === bg) bg.remove(); });
        document.body.appendChild(bg);
    }

    function cheatsheetHTML() {
        function keysHtml(groups) {
            return groups.map(function (group, gi) {
                return (gi > 0 ? '<span class="sep-or">or</span>' : '') + group.map(function (k) {
                    return '<span class="pdf2html-kbd">' + escapeHtml(k) + '</span>';
                }).join('');
            }).join('');
        }
        function keyRow(row) {
            return '<div class="pdf2html-cheatsheet-row"><span class="keys">' + keysHtml(row[0])
                + '</span><span class="desc">' + escapeHtml(row[1]) + '</span></div>';
        }
        function commandRow(cmd) {
            var alias = cmd.aliases[0] ? '<span class="alias">:' + escapeHtml(cmd.aliases[0]) + '</span>' : '';
            return '<div class="pdf2html-cheatsheet-row"><span class="cmd">' + escapeHtml(':' + cmd.usage)
                + alias + '</span><span class="desc">' + escapeHtml(cmd.help) + '</span></div>';
        }
        var keys = KEY_SECTIONS.map(function (s) {
            return '<h3>' + escapeHtml(s.title) + '</h3>' + s.rows.map(keyRow).join('');
        }).join('');
        var commands = '<div class="pdf2html-cheatsheet-row"><span class="cmd">:42</span>'
            + '<span class="desc">Go to page 42 (bare number)</span></div>'
            + COMMANDS.map(commandRow).join('');
        return '<div id="pdf2html-cheatsheet-panel">'
            + '<div class="pdf2html-cheatsheet-head">'
            +   '<div><div class="title">Keyboard reference</div><div class="subtitle">pdf_viewer</div></div>'
            +   '<button type="button" class="close" aria-label="Close keyboard reference"><span class="pdf2html-kbd sm">?</span> or '
            +     '<span class="pdf2html-kbd sm">Esc</span> to close</button>'
            + '</div>'
            + '<div class="pdf2html-cheatsheet-body" tabindex="-1">'
            +   '<div class="pdf2html-cheatsheet-section">' + keys + '</div>'
            +   '<div class="pdf2html-cheatsheet-section"><h3>Commands · type : to begin</h3>' + commands + '</div>'
            + '</div>'
            + '</div>';
    }

    // ------------------------------------------------------------------------
    // Command palette — : opens a vim-like ex-bar at the bottom, with
    // nvim wildmenu-style autocomplete: Tab cycles matches, Shift+Tab
    // reverses, commands + arguments are both completable.
    //
    // COMMANDS is the single source of truth for the dispatcher, the
    // completer, quick open (⌘K) and the cheatsheet. Each entry:
    //   name, aliases     what the palette matches
    //   usage, help       the cheatsheet row
    //   desc              the wildmenu hint (string or function for state)
    //   argCompleter      completions for the argument, if it takes one
    //   requiresArg       takes an argument without completions
    //   handler(arg)      runs the command
    // ------------------------------------------------------------------------
    // Prefix filter used by numeric arg completers. Case-insensitive.
    // Completers own their filtering (empty tail = return everything) so the
    // `chapter` completer can substring-match without the outer filter
    // fighting it.
    function prefixFilter(list, tail) {
        var lt = String(tail || '').toLowerCase();
        return list.filter(function (a) { return String(a).toLowerCase().indexOf(lt) === 0; });
    }
    // Presets for a numeric argument, plus the number as typed. Enter runs
    // the last row, so a typed `2` must be there itself: without it `:zoom 2`
    // would run the preset `2.5` and `:so 2` the preset `25`.
    function numericChoices(presets, tail) {
        var typed = String(tail || '').trim();
        var out = prefixFilter(presets, typed);
        if (typed && isFinite(Number(typed)) && out.indexOf(typed) === -1) out.push(typed);
        return out;
    }
    function onOff(on) { return on ? 'OFF' : 'ON'; }
    function markRows(command, tail) {
        // Most recently set mark last (bottom = closest to the caret).
        var marks = navigation.marks();
        var lt = navigation.markLetter(tail);
        var letters = Object.keys(marks).sort(function (a, b) { return (marks[a].ts || 0) - (marks[b].ts || 0); });
        if (lt) letters = letters.filter(function (L) { return L === lt; });
        return letters.map(function (L) {
            var m = marks[L];
            return {
                value: command + ' ' + L,
                display: L + '  ·  p. ' + m.page + (m.label ? ' · ' + m.label : ''),
                alias: '',
                rawDisplay: true,
            };
        });
    }

    var COMMANDS = [
        { name: 'pin', aliases: [], usage: 'pin [1-9]', help: 'Drop a return pin, or jump to its number',
          requiresArg: true, handler: function (a) { if (a) core.pins.jump(a.trim()); else core.pins.drop(); } },
        { name: 'unpin', aliases: [], usage: 'unpin N', help: 'Remove a return pin',
          requiresArg: true, handler: function (a) { core.pins.remove(a); } },
        { name: 'pins', aliases: [], usage: 'pins', help: 'Open the Pins sidebar', handler: function () { core.showPins(); } },
        { name: 'livereload', aliases: [], usage: 'livereload [on|off]', help: 'Toggle local PDF live reload',
          handler: function (a) {
              var on = a === 'on' ? prefs.set('liveReload', true) : a === 'off' ? prefs.set('liveReload', false) : prefs.toggle('liveReload');
              notify('Local PDF live reload ' + (on ? 'on' : 'off'));
          } },
        { name: 'page', aliases: ['p'], usage: 'page N', help: 'Go to page N',
          desc: 'goto page N', requiresArg: true,
          handler: function (a) { if (a) navigation.gotoPage(parseInt(a, 10), true); } },
        { name: 'chapter', aliases: [], usage: 'chapter <name>', help: 'Jump to a chapter by name (Tab to pick)',
          desc: 'goto chapter by name',
          argCompleter: function (tail) {
              var lt = String(tail || '').toLowerCase().trim();
              return navigation.entries().filter(function (c) {
                  return !lt || c.label.toLowerCase().indexOf(lt) !== -1;
              }).map(function (c) {
                  return { value: 'chapter ' + c.label, display: c.label, alias: 'p. ' + c.page, desc: '', rawDisplay: true };
              });
          },
          handler: function (a) { navigation.gotoChapter(a); } },
        { name: 'mark', aliases: [], usage: 'mark <a-z>', help: 'Bookmark the current page (persists across reloads)',
          desc: 'bookmark current page as <letter>',
          argCompleter: function (tail) {
              var marks = navigation.marks();
              var lt = navigation.markLetter(tail) || '';
              // z → a so the most-reached letter ('a' on a home-row hand)
              // sits at the bottom of the wildmenu, closest to the caret.
              var letters = lt ? [lt] : 'zyxwvutsrqponmlkjihgfedcba'.split('');
              return letters.map(function (L) {
                  var m = marks[L];
                  return {
                      value: 'mark ' + L,
                      display: L + '  ·  ' + (m ? 'p. ' + m.page + (m.label ? ' · ' + m.label : '') : '—'),
                      alias: m ? 'set' : '',
                      rawDisplay: true,
                  };
              });
          },
          handler: function (a) {
              var mark = navigation.setMark(a);
              notify(mark ? 'Mark ' + mark.letter + ' set on p. ' + mark.page : 'A mark is a letter a–z', { error: !mark });
          } },
        { name: 'jump', aliases: [], usage: 'jump <a-z>', help: 'Jump to a bookmark',
          desc: 'jump to mark <letter>',
          argCompleter: function (tail) { return markRows('jump', tail); },
          handler: function (a) { if (!navigation.gotoMark(a)) notify('No such mark', { error: true }); } },
        { name: 'clear', aliases: [], usage: 'clear <a-z>', help: 'Delete a bookmark',
          desc: 'delete mark <letter>',
          argCompleter: function (tail) { return markRows('clear', tail); },
          handler: function (a) {
              var mark = navigation.clearMark(a);
              notify(mark ? 'Mark ' + mark.letter + ' cleared' : 'No such mark', { error: !mark });
          } },
        { name: 'cursorpin', aliases: [], usage: 'cursorpin', help: 'Toggle cursor pin-to-center',
          desc: function () { return 'turn pin-to-center ' + onOff(prefs.get('pinned')); },
          handler: function () { prefs.toggle('pinned'); } },
        { name: 'scrolloff', aliases: ['so'], usage: 'scrolloff N', help: 'Scrolloff band at N% (0–50)',
          desc: 'scrolloff N% (0-50)',
          argCompleter: function (tail) { return numericChoices(['0', '10', '25', '33', '50'], tail); },
          handler: function (a) {
              var n = parseInt(a, 10);
              if (!isNaN(n)) prefs.set('scrollOff', Math.max(0, Math.min(50, n)) / 100);
          } },
        { name: 'yank', aliases: ['y'], usage: 'yank <kind>', help: 'Copy ref / quote / page / chapter / document',
          desc: 'copy content (ref/quote/page/chapter/doc)',
          argCompleter: function (tail) {
              // `page` (the narrowest, most frequent) sits last, nearest the
              // caret, so `:y<space><Enter>` yanks the current page.
              var options = [
                  { value: 'yank ref', display: 'ref', desc: 'chapter · p. N (meta)' },
                  { value: 'yank quote', display: 'quote', desc: 'the selection, with document, page and source' },
                  { value: 'yank document', display: 'document', desc: 'full document text' },
                  { value: 'yank chapter', display: 'chapter', desc: 'current chapter text' },
                  { value: 'yank page', display: 'page', desc: 'current page text' },
              ];
              var lt = String(tail || '').toLowerCase().trim();
              return lt ? options.filter(function (o) { return o.display.indexOf(lt) === 0; }) : options;
          },
          handler: function (a) { text.dispatchYank(a); } },
        { name: 'finger', aliases: ['f'], usage: 'finger', help: 'Hint visible URL / DOI / ISBN / ID tokens',
          desc: 'hint visible URL/DOI/ISBN/ID tokens',
          handler: function () { finger.openFingerMode(); } },
        { name: 'counter', aliases: ['num'], usage: 'counter [brief]', help: 'Toggle the page counter; brief shows it on page change',
          desc: function () { return (prefs.get('pageCounterVisible') ? 'hide' : 'show') + ' page counter'; },
          handler: function (a) {
              if ((a || '').toLowerCase().trim() === 'brief') {
                  var brief = prefs.toggle('pageCounterBrief');
                  if (brief) prefs.set('pageCounterVisible', false);
                  notify('Page counter on page change: ' + (brief ? 'on' : 'off'));
              } else prefs.toggle('pageCounterVisible');
          } },
        { name: 'dark', aliases: [], usage: 'dark', help: 'Toggle dark pages',
          desc: function () { return 'turn dark pages ' + onOff(prefs.get('darkPages')); },
          handler: function () { prefs.toggle('darkPages'); } },
        { name: 'back', aliases: [], usage: 'back', help: 'Go back to before the last jump (⌘Z)',
          desc: 'undo the last jump',
          handler: function () { core.jumpBack(); } },
        { name: 'forward', aliases: [], usage: 'forward', help: 'Redo a jump undone with back (⌘⇧Z)',
          desc: 'redo the jump',
          handler: function () { core.jumpForward(); } },
        { name: 'case', aliases: [], usage: 'case', help: 'Toggle case-sensitive / search',
          desc: function () { return 'turn case-sensitive search ' + onOff(prefs.get('searchCaseSensitive')); },
          handler: function () { prefs.toggle('searchCaseSensitive'); } },
        // `next`/`prev` are ordered AFTER `counter` so that `:n<Enter>` —
        // which prefix-matches both `counter` (via alias `num`) and `next` —
        // auto-selects `next` (state.idx = last match in COMMANDS order).
        // Same logic puts `prev` after `pin` so `:p<Enter>` lands on prev.
        { name: 'next', aliases: [], usage: 'next', help: 'Next chapter',
          desc: 'next chapter',
          handler: function () { navigation.gotoChapterBy(1); } },
        { name: 'prev', aliases: [], usage: 'prev', help: 'Previous chapter (or chapter start if mid-chapter)',
          desc: 'prev chapter (or chapter start)',
          handler: function () { navigation.gotoChapterBy(-1); } },
        { name: 'zoom', aliases: [], usage: 'zoom N | auto', help: 'Set page zoom (auto = fit to width)',
          desc: 'set zoom N (or auto)',
          argCompleter: function (tail) { return numericChoices(['auto', '1.0', '1.2', '1.4', '1.6', '1.8', '2.0', '2.5'], tail); },
          handler: function (a) { if (a) zoom.set(a === 'auto' ? 'auto' : parseFloat(a)); } },
        { name: 'open', aliases: ['o'], usage: 'open <doc>', help: 'Open another cached document',
          desc: 'open another cached doc',
          argCompleter: function (tail) {
              return library.complete(tail).map(function (e) {
                  return { value: 'open ' + e.name, display: e.name, alias: library.recencyLabel(e), rawDisplay: true };
              });
          },
          handler: function (a) { library.open(a); } },
        { name: 'help', aliases: ['h'], usage: 'help', help: 'Open this cheatsheet',
          desc: 'show cheatsheet',
          handler: function () { toggleCheatsheet(); } },
        { name: 'set', aliases: [], usage: 'set', help: 'Open settings',
          desc: 'open settings',
          handler: function () { settings.toggle(); } },
        { name: 'path', aliases: [], usage: 'path', help: "Copy this PDF's source path / URL",
          desc: function () {
              var ref = library.currentSourceRef();
              return ref ? middleEllipsis(ref, 60) : 'copy source path / URL';
          },
          handler: function () {
              var ref = library.currentSourceRef();
              if (!ref) { notify('No source recorded for this document', { error: true }); return; }
              text.writeClip(ref).then(function (ok) {
                  notify(ok ? 'Copied ' + middleEllipsis(ref, 48) : 'Could not copy to the clipboard', { error: !ok });
              });
          } },
        { name: 'print', aliases: [], usage: 'print', help: "Open the PDF in the browser's viewer to print it",
          desc: "open the PDF in the browser's viewer to print",
          handler: function () {
              var hash = core.entryHash && core.entryHash();
              if (!hash) { notify('No PDF recorded for this document', { error: true }); return; }
              window.open('/native?hash=' + encodeURIComponent(hash), '_blank');
          } },
        { name: 'disable', aliases: ['native'], usage: 'disable', help: 'Open the native PDF and stop redirecting this file',
          desc: 'open native PDF and disable viewer for this file',
          handler: function () { library.disableCurrent(); } },
        { name: 'rename', aliases: ['rn'], usage: 'rename <name>', help: 'Rename this PDF (Tab fills the current name)',
          desc: function () {
              var current = library.currentName();
              return current ? 'rename "' + current + '"' : 'rename this PDF';
          },
          argCompleter: function (tail) {
              var current = library.currentName();
              // Seed the current name only while the argument is empty —
              // `:rename<Tab>` autofills, then the user edits freely.
              if (!current || String(tail || '').length > 0) return [];
              return [{
                  value: 'rename ' + current, display: current, alias: '(current)',
                  desc: 'Tab to fill · edit · Enter to rename', rawDisplay: true,
              }];
          },
          handler: function (a) { library.renameCurrent(a); } },
        // Destructive, but recoverable (re-convert). The `confirm` argument is
        // mandatory so `:d<Enter>` expands to `delete ` instead of wiping the
        // cache entry on a stray keystroke.
        { name: 'delete', aliases: [], usage: 'delete confirm', help: 'Wipe this PDF from the cache and open the source',
          desc: 'wipe this PDF from cache + go to source',
          argCompleter: function (tail) {
              var lt = String(tail || '').toLowerCase().trim();
              var opts = [{ value: 'delete confirm', display: 'confirm', desc: 'wipe cache entry, redirect to original' }];
              return lt ? opts.filter(function (o) { return o.display.indexOf(lt) === 0; }) : opts;
          },
          handler: function (a) { if ((a || '').toLowerCase().trim() === 'confirm') library.deleteCurrent(); } },
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

    // Focusing a command input takes the selection away from the document.
    // Commands such as `:yank quote` act on what was selected, so remember
    // it when a command surface opens and put it back before a command runs.
    function saveSelection() {
        var sel = window.getSelection();
        var ranges = [];
        if (sel && !sel.isCollapsed) {
            for (var i = 0; i < sel.rangeCount; i++) ranges.push(sel.getRangeAt(i).cloneRange());
        }
        return ranges;
    }
    function restoreSelection(ranges) {
        if (!ranges || !ranges.length) return;
        var sel = window.getSelection();
        if (!sel) return;
        try {
            sel.removeAllRanges();
            ranges.forEach(function (r) { sel.addRange(r); });
        } catch (_) {}
    }

    // With Vimium installed, Escape in a text field never reaches the page:
    // Vimium's insert mode takes it and only blurs the field, so closing a
    // command surface took two presses. Losing focus to the page while the
    // window is still focused means the reader pressed Escape or clicked
    // away; close then. Switching to another app (the window loses focus)
    // leaves it open.
    function closeWhenFocusLeaves(input, overlay) {
        input.addEventListener('blur', function () {
            window.setTimeout(function () {
                if (!overlay.isConnected || !document.hasFocus()) return;
                if (document.activeElement === input || overlay.contains(document.activeElement)) return;
                removeOverlay(overlay);
            }, 0);
        });
    }

    function openPalette(keptSelection) {
        var ex = document.getElementById('pdf2html-palette');
        if (ex) { removeOverlay(ex); return; }
        var selection = keptSelection || saveSelection();

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
            // Empty input → no suggestions: the palette opens clean and
            // starts suggesting on the first keystroke.
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
            computeMatches();
            // If the arg completer offers exactly one suggestion, fill it
            // directly so e.g. `:re<Tab>` lands at `:rename <current>` in
            // one keystroke instead of two. Multi-suggestion completers
            // (chapter, open, mark) still expand to `:cmd ` and let the
            // user cycle — they have nothing single to commit to.
            if (state.matches.length === 1 && state.matches[0].value) {
                input.value = state.matches[0].value;
            }
            renderMatches();
            return true;
        }

        function acceptMatchOrRun(match) {
            if (expandCommandMatch(match)) return;
            input.value = match && match.value != null ? match.value : input.value;
            // Close first, so the command runs against the document's own
            // focus and selection rather than the palette's.
            var command = input.value;
            removeOverlay(wrap);
            restoreSelection(selection);
            runCommand(command);
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
        closeWhenFocusLeaves(input, wrap);
        input.addEventListener('input', function () { computeMatches(); renderMatches(); });
        input.addEventListener('keydown', function (ev) {
            if (ev.key === 'Escape') {
                ev.stopPropagation(); ev.preventDefault(); removeOverlay(wrap);
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

        computeMatches();
        renderMatches();
    }

    function runCommand(raw) {
        var trimmed = raw.trim();
        if (!trimmed) return;
        // Bare number: `:42` = goto page 42
        if (/^\d+$/.test(trimmed)) { navigation.gotoPage(parseInt(trimmed, 10), true); return; }
        var firstSpace = trimmed.indexOf(' ');
        var head = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
        var tail = firstSpace === -1 ? '' : trimmed.slice(firstSpace + 1).trim();
        var cmd = findCommand(head);
        if (cmd) cmd.handler(tail || undefined);
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
            finger.openFingerMode();
        }, true);
    }

    function fingerShortcutBlockedByOverlay() {
        return !!(document.getElementById('pdf2html-palette')
            || document.getElementById('pdf2html-finder')
            || document.getElementById('pdf2html-settings')
            || document.getElementById('pdf2html-cheatsheet'));
    }

    // ------------------------------------------------------------------------
    // Quick open (overlay-quickopen.js): ⌘O sections of this document, ⌘P
    // documents, ⌘K everything including COMMANDS. All three are taken in the
    // capture phase from any focus state, like ⌘, below: printing the viewer
    // would print the overlay (`:print` prints the PDF), and the browser's
    // open-file dialog has no use here.
    // ------------------------------------------------------------------------
    var quickOpen = createQuickOpen({
        document: document, window: window, location: location, navigation: navigation,
        documentModel: core.documentModel, library: library, notify: notify, pins: core.pins,
        saveSelection: saveSelection, restoreSelection: restoreSelection,
        commands: function () { return COMMANDS; },
        runCommand: function (cmd, selection) {
            restoreSelection(selection);
            if (!commandTakesArg(cmd)) { cmd.handler(); return; }
            // A command that takes an argument continues in the : palette.
            openPalette(selection);
            var inp = document.getElementById('pdf2html-palette-input');
            if (inp) {
                inp.value = cmd.name + ' ';
                inp.dispatchEvent(new Event('input'));
                inp.selectionStart = inp.selectionEnd = inp.value.length;
            }
        },
        find: findInDocument,
    });

    // The `/` search marks hits on the visible pages. When the text is not on
    // screen, the browser's own find (which sees every page: offscreen text
    // stays in layout) jumps to the next occurrence from here, and the bar
    // then marks the hits around it.
    function findInDocument(text) {
        var search = core.search;
        if (!search || !text) return;
        if (search.find(text) > 0) return;
        search.close();
        var sel = window.getSelection();
        var visible = core.documentModel.visiblePages();
        var start = visible.length && core.documentModel.pageTextBoundaryPosition(
            core.documentModel.pageNumber(visible[0]), true);
        try {
            if (sel && start) sel.collapse(start.node, start.offset);
        } catch (_) {}
        var found = false;
        try { found = window.find(text, false, false, true, false, false, false); } catch (_) {}
        var range = found && sel && sel.rangeCount ? sel.getRangeAt(0) : null;
        var root = core.documentModel.container();
        if (!range || !root) {
            if (sel) sel.removeAllRanges();
            notify('No \u201c' + text + '\u201d in this document', { error: true });
            return;
        }
        // The browser's find selects the match but leaves the page scroller
        // where it was: bring the match to the upper third, as a jump ⌘Z undoes.
        var box = range.getBoundingClientRect(), rootBox = root.getBoundingClientRect();
        navigation.remember();
        root.scrollTop += box.top - rootBox.top - root.clientHeight / 3;
        sel.removeAllRanges();
        window.requestAnimationFrame(function () { search.find(text); });
    }

    var QUICK_KEYS = { k: 'all', o: 'sections', p: 'documents' };
    function registerQuickOpenHandler() {
        document.addEventListener('keydown', function (e) {
            if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
            var key = String(e.key || '').toLowerCase();
            if (!/^[a-z]$/.test(key) && /^Key[KOP]$/.test(e.code || '')) key = e.code.slice(3).toLowerCase();
            var mode = QUICK_KEYS[key];
            if (!mode) return;
            e.preventDefault(); e.stopPropagation();
            var palette = document.getElementById('pdf2html-palette');
            if (palette) removeOverlay(palette);
            quickOpen.toggle(mode);
        }, true);
    }


    // ⌘, — open settings, intercepting the browser's own preferences shortcut.
    // Capture-phase preventDefault is what keeps the browser from opening its
    // settings page; Chromium only reserves ⌘T/W/Q/N hard, so ⌘, is ours to
    // take. Bypasses isInputTarget like ⌘K — chord shortcuts should work from
    // any focus state. settings.toggle() closes it again on a second press.
    function registerSettingsHandler() {
        document.addEventListener('keydown', function (e) {
            if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
            if (e.key !== ',' && e.code !== 'Comma') return;
            e.preventDefault(); e.stopPropagation();
            settings.toggle();
        }, true);
    }

    function closeFinderOrPalette() {
        if (quickOpen.close()) return true;
        var palette = document.getElementById('pdf2html-palette');
        if (palette) return removeOverlay(palette);
        return false;
    }
    function closeHelp() {
        var help = document.getElementById('pdf2html-cheatsheet');
        if (help) { help.remove(); return true; }
        return false;
    }
    function registerQuestionHandler() {
        document.addEventListener('keydown', function (e) {
            if (e.key !== '?') return;
            if (isInputTarget(e.target)) return;
            e.preventDefault(); e.stopPropagation();
            toggleCheatsheet();
        }, true);
    }

    return {
        init: function () {
            registerQuestionHandler();
            registerPaletteHandler();
            registerFingerShortcutHandler();
            registerQuickOpenHandler();
            registerSettingsHandler();
        },
        closeFinderOrPalette: closeFinderOrPalette,
        closeHelp: closeHelp,
        toggleCheatsheet: toggleCheatsheet,
        openPalette: openPalette,
        quickOpen: quickOpen.toggle,
    };
}

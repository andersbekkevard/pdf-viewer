# Keybindings

The overlay's full key + palette contract. The `?` cheatsheet in the
viewer is the live reference (its command list is generated from the
palette's `COMMANDS` table in `assets/overlay-commands.js`); this doc adds
the rationale — especially *what we deliberately don't bind* and why.

For the rationale on the overall keyboard strategy, see
[ADR 0003](adr/0003-keyboard-shortcuts-vimium-coexistence.md).

## Direct keys

| Key                    | Action                                                        |
|------------------------|---------------------------------------------------------------|
| `⌘.` · `⌘B`            | Toggle sidebar                                                |
| `Ctrl-j` / `Ctrl-k` · `↓` / `↑` | When the sidebar Outline or Pages tab is open, move the temporary selector; `Enter` jumps to it |
| `Ctrl-f`               | Finger visible URL / DOI / ISBN / long-ID tokens              |
| `/` · `s`              | Find in visible pages (Enter jump, `n` / `N` cycle)           |
| `←` / `→` · `h` / `l`  | Switch sidebar tab (Outline / Pages) — only when sidebar open |
| `→` / `←`              | Next / prev page, like `e` / `q` (when the sidebar is closed; with it open they switch its tab) |
| `↓` / `↑`              | Scroll the document by 60 px (the sidebar selector when the sidebar has focus) |
| `Space` / `Shift-Space` · `PageDown` / `PageUp` | Scroll one screen down / up |
| `Home` / `End`         | Top / bottom of the document |
| `e` / `q` / `E`        | Next / prev page; active text selection extends pagewise instead; `q` aliases `E`; count-prefixed (`10e` = +10, `10q` = `10E` = −10) |
| `c` / `C`              | Next / prev chapter; active browser selection + `c` selects the whole chapter; count-prefixed (`3c` = +3, `3C` = −3)    |
| `⌘+` / `⌘−` / `⌘0`     | Zoom in / out (manual, per document) / back to fit-width      |
| `⌘Z` / `⌘⇧Z`           | Back to where you were before the last jump / forward again (outline, links, `:42`, `gg`/`G`, a find match, `Home`/`End`) |
| `⌘⇧.`                  | Toggle page counter                                           |
| `:`                    | Open command palette                                          |
| `⌘O`                   | Quick open: sections (or pages) and marks of this document    |
| `⌘P`                   | Quick open: documents; the previous one is selected, so `⌘P` `Enter` goes back to it |
| `⌘K`                   | Quick open: sections, documents and commands together         |
| `⌘,`                   | Open settings (intercepts browser preferences shortcut)       |
| `?`                    | Toggle cheatsheet (needs Vimium `?` disabled for `localhost:7435`) |
| `Esc`                  | Close quick open / palette → finger mode → settings → cheatsheet → sidebar → clear selection |

Jumps land consistently. Page jumps (`:42`, `e` / `q`, marks, thumbnails,
resume) put the page top 8 px below the viewport top. Chapter jumps
(outline clicks and `Enter`, `:chapter`, `c` / `C`, quick-open sections) go to the
outline entry's destination, so its heading sits at the viewport top.

Bare `Tab` is not a viewer command. On the PDF document surface it is
intentionally ignored so browser focus traversal does not jump between pages;
the `:` palette still uses Tab to complete, and quick open uses Tab and
Shift-Tab to move its selection.

## Quick open

A reader asks one of three things: where in this document, which document,
or what to do. Each has a key, and `⌘K` answers all three. They are one
panel (`assets/overlay-quickopen.js`): pressing the same key again closes
it, and pressing another of the three switches it in place, keeping what was
typed.

- `⌘O` opens on the current section with its neighbours visible, the outline
  hierarchy indented and page numbers on the right. Saved marks come first
  under their own heading. Digits alone offer "Go to page N" first, only when
  that page exists. A document without an outline lists its pages, labelled
  with each page's first line of text.
- `⌘P` opens on the previous document (the most recently read one other than
  this), then the rest by frecency: each session counts, halving every seven
  days (`daemon/visits.py`). Rows show the title (a `:rename`d name, else the
  PDF's metadata title, else the file name), the author or source host, and
  the saved page or page count with when it was last read. `Enter` opens it in
  this tab at its saved page; `⌘Enter` opens a new tab. This document is not
  listed.
- `⌘K` with nothing typed lists the previous document, the next sections from
  where the reader is, recent documents and the commands. Typing ranks
  sections, documents and commands together. Prefixes narrow it: `@`
  sections, `#` pages (`#42` or a bare number goes to that page), `>`
  commands. When no section matches, the last row offers "Find … in this
  document": the `/` search with that text, or, when the text is not on
  screen, a jump to its next occurrence (the browser's find, which sees every
  page) and the `/` search there.

Typing is fuzzy: each word is matched as a subsequence, ignoring case and
diacritics, ranked higher at word starts and for consecutive letters, and
the matched characters are tinted. Section rows also match their parent
sections' titles.

In the panel: `↓` / `↑`, `Ctrl-j` / `Ctrl-k`, `Ctrl-n` / `Ctrl-p` and
`Tab` / `Shift-Tab` move; `Enter` commits; `⌘Enter` opens a document, or this
document at a section or page, in a new tab; `Esc`, a click outside or focus
leaving the field (Vimium's `Esc`) closes. The footer shows only the keys that
apply.

Moving the selection to a section, page or mark previews it: the document
behind the panel scrolls so the target sits just below the panel (reader
destinations land their heading there; pdf2htmlEX ones their page top). A
preview records no history. Closing without a commit returns to the exact
scroll position; `Enter` returns there first and then jumps, so the jump is
one `⌘Z` entry like any other.

`⌘O` and `⌘P` are the browser's open-file and print shortcuts; the overlay
takes them in the capture phase from any focus, as it does `⌘K` and `⌘,`.
Printing the viewer page would print the overlay; `:print` prints the PDF.
`⌘` chords are not Vimium keys, so none of this needs an exclusion rule.

## Home page

`localhost:7435/` is the library: every cached document, recent and frequent
first, with a search field focused on load (same all-terms rule as `:open`).
Pasting an http(s) URL or an absolute/`~` path offers to open it in the reader.
In the field: `↓` / `↑` · `Ctrl-j` / `Ctrl-k` move, `Enter` opens, `⌘Enter`
(or `Ctrl-Enter`) opens in a new tab, `Esc` clears, then blurs. Outside the
field the page binds only `/` (focus search), the arrows, `Ctrl-j` / `Ctrl-k`
and `Enter`; every row, copy button and "Original" link is a real element, so
Vimium's `f` hints reach them. No overlay key leads here; use the address bar.

## Command palette

| Command                      | Action                                                                           |
|------------------------------|----------------------------------------------------------------------------------|
| `:42`                        | Goto page 42                                                                     |
| `:page 42` / `:p 42`         | Same as `:42`                                                                    |
| `:chapter <name>`            | Jump to outline chapter; Tab completes against sidebar (case-insensitive substring) |
| `:next` / `:prev`            | Next / previous chapter (or reset to current-chapter start if deep into it)      |
| `:mark <a-z>`                | Persistent bookmark of current page (stored by the daemon per document)                     |
| `:jump <a-z>`                | Jump to a saved mark                                                             |
| `:clear <a-z>`               | Delete a saved mark                                                              |
| `:open <doc>` / `:o`         | Switch to another cached doc; completes against `/library` (visits-sorted)       |
| `:rename <name>` / `:rn`     | Rename this PDF (the name `:open` and quick open show and match). Tab fills current |
| `:path`                      | Copy this PDF's source path / URL (from `mappings.tsv`) to clipboard             |
| `:print`                     | Open the source PDF in a new tab, in the browser's own viewer, to print it (`⌘P` is quick open) |
| `:disable` / `:native`       | Open this PDF in the native browser PDF viewer and disable custom-viewer redirects for this entry |
| `:pin`                       | Toggle pin-to-center                                                             |
| `:scrolloff 25` / `:so 25`   | Set scrolloff band to 25 % (0–50)                                                |
| `:case`                      | Toggle case-sensitive `/` search                                                 |
| `:zoom N` / `:zoom auto`     | Manual page zoom for this document, or back to fit-width                         |
| `:delete confirm`            | Wipe this PDF's cache entry and open the original                                |
| `:yank <kind>` / `:y <kind>` | `ref` (default, "Chapter · p. N") · `quote` (the selection with document, page, source and a link back) · `page` · `chapter` · `document` |
| `:back` / `:forward`         | Undo / redo the last jump (`⌘Z` / `⌘⇧Z`)                                         |
| `:dark`                      | Toggle dark pages (also in Settings)                                             |
| `:finger` / `:f`             | Hint visible URL / DOI / ISBN / long-ID tokens; exact hint copies token          |
| `:counter` / `:num`          | Toggle page counter; `:counter brief` shows it for a moment on each page change while hidden |
| `:set`                       | Open Settings modal                                                              |
| `:help` / `:h`               | Open cheatsheet                                                                  |

Count-prefix bindings are `e` / `q` / `E` (page step) and `c` / `C` (chapter
step). Digits buffer for 1.5 s or until a non-digit/non-motion key
cancels. Bare `C` preserves the prev-chapter threshold (mid-section
`C` backtracks to the section start); multi-step `NC` skips that rule.
Every other numeric-argument command lives in the palette — no general
`[N]<key>` parser.

When the browser has a non-collapsed text selection, `e` / `q` / `E`
stop being viewport jumps and instead move the selection's focus end by
pages while leaving the anchor fixed. Forward motion lands at the start
of the target page; backward motion lands at the end.

With a non-collapsed browser text selection, bare `c` selects the entire
outline chapter containing the selection focus. `C` keeps its existing
previous-chapter navigation behavior.

Finger mode uses only keys already in the Vimium pass-through list:
`e s q c h l n`. If more than seven visible targets exist, hints become
two or more letters from that same alphabet. `Backspace` edits the typed
prefix; `Esc` exits without copying.

Actions that change nothing visible (a copy, a mark, a rename, a jump back, a
failure) confirm themselves with a one-line toast at the bottom of the page.

## Permanently rejected (Vimium conflicts)

These keys are reserved by Vimium bindings we use daily. They must
never become overlay shortcuts.

- `n`, `p`, `o`, `]]`, `[[`, `m`, `'`, `gs`, `ge`, `gg`, `G`, `H`, `L`,
  `gt`, `gT`, `zi` / `zo` / `z0`, `r` / `R`
- `gp` — contains `p`
- `gn` — contains `n`
- `go` — contains `o`
- `g?` — `?` is handled by our listener; Vimium's `?` is disabled via
  exclusion rule
- `g<letter>` for toggles — "wrong letter family"; toggles live in the
  palette instead

When tempted to add a new keybinding, add a palette command instead.
That's the escape hatch.

## Proposed (not implemented)

- `}` / `{` — next / previous chapter (outline walk). Currently in the
  palette as `:next` / `:prev`; the unshifted bracket keys are free.
- `zz` — recenter selection on pin.

## Vimium setup

In Vimium's options, add an exclusion rule with the pattern
`https?://localhost:7435/*` and the keys
`? s / n N h l e q E c C 0 1 2 3 4 5 6 7 8 9`. Without this, Vimium
swallows them before the overlay's handlers see them — in particular,
Vimium's own count buffer eats the digits in `10e` / `10q`.

Two details that `scripts/verify-vimium.sh` checks with the real extension:

- The pattern needs the scheme and the trailing `/*`. Vimium matches the
  whole URL, so a bare `localhost:7435` matches nothing.
- Do not list `<c-f>`. Vimium reads the keys as single characters, so
  `<c-f>` passes `<`, `c`, `-`, `f` and `>` through, and plain `f` stops
  opening link hints. Vimium does not bind Ctrl-f, so the overlay's finger
  mode gets it without a rule.

Vimium's own marks (`m` / `'`) do nothing here: they store the window's scroll
position, and the viewer scrolls `#page-container`. Use `:mark` / `:jump`.

### Local-file live reload

`:livereload` toggles watching local PDF saves; `:livereload on` and
`:livereload off` set it explicitly. This is a global overlay preference
(default on), stored through `overlay-prefs.js`. It introduces no direct key
binding and does not claim any Vimium key.

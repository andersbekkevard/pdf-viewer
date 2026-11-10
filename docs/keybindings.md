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
| `e` / `q` / `E`        | Next / prev page; active text selection extends pagewise instead; `q` aliases `E`; count-prefixed (`10e` = +10, `10q` = `10E` = −10) |
| `c` / `C`              | Next / prev chapter; active browser selection + `c` selects the whole chapter; count-prefixed (`3c` = +3, `3C` = −3)    |
| `⌘+` / `⌘−` / `⌘0`     | Zoom in / out (manual, per document) / back to fit-width      |
| `⌘⇧.`                  | Toggle page counter                                           |
| `:`                    | Open command palette                                          |
| `⌘K`                   | Quick-open: outline sections, other cached documents, commands |
| `⌘,`                   | Open settings (intercepts browser preferences shortcut)       |
| `?`                    | Toggle cheatsheet (needs Vimium `?` disabled for `localhost:7435`) |
| `Esc`                  | Close finder / palette → finger mode → settings → cheatsheet → sidebar → clear selection |

Jumps land consistently. Page jumps (`:42`, `e` / `q`, marks, thumbnails,
resume) put the page top 8 px below the viewport top. Chapter jumps
(outline clicks and `Enter`, `:chapter`, `c` / `C`, ⌘K sections) go to the
outline entry's destination, so its heading sits at the viewport top.

Bare `Tab` is not a viewer command. On the PDF document surface it is
intentionally ignored so browser focus traversal does not jump between pages;
overlay inputs such as `:` and `⌘K` still use Tab for local completion/scope
cycling.

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
| `:rename <name>` / `:rn`     | Rename this PDF (changes the search name used by `:open` / ⌘K). Tab fills current |
| `:path`                      | Copy this PDF's source path / URL (from `mappings.tsv`) to clipboard             |
| `:disable` / `:native`       | Open this PDF in the native browser PDF viewer and disable custom-viewer redirects for this entry |
| `:pin`                       | Toggle pin-to-center                                                             |
| `:scrolloff 25` / `:so 25`   | Set scrolloff band to 25 % (0–50)                                                |
| `:case`                      | Toggle case-sensitive `/` search                                                 |
| `:zoom N` / `:zoom auto`     | Manual page zoom for this document, or back to fit-width                         |
| `:delete confirm`            | Wipe this PDF's cache entry and open the original                                |
| `:yank <kind>` / `:y <kind>` | `ref` (default, "Chapter · p. N") · `page` · `chapter` · `document`              |
| `:finger` / `:f`             | Hint visible URL / DOI / ISBN / long-ID tokens; exact hint copies token          |
| `:counter` / `:num`          | Toggle page counter                                                              |
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
- `Ctrl-o` / `Ctrl-i` — doc-local jumplist.
- `zz` — recenter selection on pin.

## Vimium setup

Add `localhost:7435` to Vimium's "Keys to pass through" with the keys
`? s / n N h l e q E c C <c-f> 0 1 2 3 4 5 6 7 8 9`. Without this, Vimium
swallows them before the overlay's handlers see them — in particular,
Vimium's own count buffer eats the digits in `10e` / `10q`. One-time
setup in the Vimium options page.

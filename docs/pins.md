# Pins

A pin is a persistent return point in one document: page, normalized viewport
anchor (including horizontal position), title, section and creation time. Pins
live through `overlay-state.js` in the daemon's `state.db`. Rewritten local
files inherit pins with page numbers clamped to the new page count.

`:pin` or **Ctrl-Shift-P** drops a pin. Selected text supplies the title, folded
to one line and capped at 160 characters. Otherwise the current section and the
first twelve words of the first visible text line supply it. A toast confirms
its number and title. Nine pins fit in a document; when full, remove one first.
Numbers use the lowest free slot 1–9. Existing pins never renumber; the overview
stays in creation order. There are no named sets or letter pins.

`:pin 3` jumps to pin 3; **Ctrl-Shift-O** returns to the most recently created
remaining pin. These chords avoid Vimium's unmodified letter commands and need
no exclusion-rule change. Each jump records the old viewport once, so ⌘Z returns.
`:unpin 3` removes a pin. Existing `:mark a` / `:jump a` remain independent.

`:pins` opens the third sidebar tab. Rows show number, title, section, page and
same-source page thumbnail, plus a remove button. Ctrl-J/Ctrl-K or ↑/↓ select;
Enter jumps. Numbered buttons in the page's outside margin also jump and are
Vimium-hintable. Pins never paint over the PDF text layer.

The previous `:pin` cursor-centering preference is now `:cursorpin`; Settings
still exposes it. Pins do not change that preference.

## Module contract

`createPins` in `assets/overlay-pins.js` exposes `list()`, `drop()`, `jump(n)`,
`remove(n)`, `onChange(fn)` (plus composition-only `mount()`). `list()` returns
copies in creation order. Omit `n` to jump to the newest remaining pin. The
composition root passes `pins` to the command surface for quick-open consumers.

## Remaining questions

Should pins support editing titles, exporting, or cross-document lists? These
remain future decisions. Multi-browser simultaneous edits currently use the
state store's last-writer-wins rule for the complete pins list.

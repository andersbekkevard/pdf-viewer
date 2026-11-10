# pdf2htmlEX output — DOM structure reference

A quick reference for the HTML our overlay lives on top of. Written so a
future session can modify a selector or event target without trial-and-error.

All examples are real, sampled from actual cached conversions (arbitrary
whitespace trimmed).

## High-level skeleton

```html
<html>
<head>
  <title>…</title>
  <style>…</style>            <!-- pdf2htmlEX's own CSS: utility classes, positioning -->
  <script>…</script>          <!-- pdf2htmlEX's runtime (we kill it, see ADR 0002) -->
  <!-- our injection lives here: overlay.css link + overlay.js script -->
</head>
<body>
  <div id="sidebar">
    <div id="outline">…</div>
  </div>
  <div id="page-container">
    <div id="pf1" class="pf w0 h0" data-page-no="1">…</div>
    <div id="pf2" class="pf w0 h0" data-page-no="2">…</div>
    <!-- one .pf per page, in page order -->
  </div>
  <div class="loading-indicator" />  <!-- unused after we kill the runtime -->
</body>
</html>
```

## IDs of note (unique on the page)

| Selector | What it is |
|---|---|
| `#page-container` | The scrollable root. All `.pf` pages are its direct children. Its `scrollTop` is what we manipulate for cursor pin. Its `getBoundingClientRect()` defines the visible viewport. |
| `#sidebar` | Container for the outline (TOC). We hide/show by toggling `body.sidebar-shown`. |
| `#outline` | The TOC itself — nested `<ul><li><a class="l">`. |
| `#pfN` | The Nth page (1-based, **hex**). Page 1 = `#pf1`, page 10 = `#pfa`, page 213 = `#pfd5`. |

## Page numbering (the hex gotcha)

pdf2htmlEX uses **hex** for page IDs and, in the pinned engine output we use,
also stores that same unprefixed hex value in `data-page-no`. Older notes in
this repo assumed `data-page-no` was decimal; that is false for pages like
`#pf140` (`data-page-no="140"`, decimal page 320). Treat the `#pf...` ID as
authoritative. `a.l[data-dest-detail]` values are PDF-native decimal page
targets.

| Page (decimal) | Element ID | `data-page-no` attr |
|---|---|---|
| 1 | `#pf1` | `1` |
| 9 | `#pf9` | `9` |
| 10 | `#pfa` | `a` |
| 21 | `#pf15` | `15` |
| 213 | `#pfd5` | `d5` |
| 797 | `#pf31d` | `31d` |

So to resolve "user typed `:42`" → the element:
```js
document.getElementById('pf' + (42).toString(16))  // "#pf2a"
```

And to get the page number of an element back:
```js
parseInt(el.id.match(/pf([0-9a-f]+)/i)[1], 16)
```

## `.pf` — page frame (outer page wrapper)

```html
<div id="pf1" class="pf w0 h0" data-page-no="1">
  <div class="pc pc1 w0 h0">
    <!-- page content here -->
  </div>
</div>
```

- Always direct child of `#page-container`
- `w0 h0` reference size classes (see "Utility classes" below) — width/height
  of this specific page. Some docs mix page sizes; `w1 h1` etc. may appear.
- The `.pf` itself is always laid out and takes full page space.
- Carries `content-visibility: auto` (overlay.css) — the browser skips
  paint+layout for offscreen pages but keeps their text in the DOM so
  native Cmd-F can index it. See ADR 0009.

## `.pc` — page content (inner content wrapper)

```html
<div class="pc pc1 w0 h0">
  <img class="bi x0 y0 w1 h1" src="…bg1.png" />        <!-- background raster of page -->
  <div class="c x0 y0 w1 h1">                          <!-- canvas wrapper for text -->
    <div class="t m0 x5 h6 y20 ff4 fs3 fc0 sc0 ls3 ws8">EIGHTH EDITION</div>
    <!-- many .t lines per page -->
  </div>
</div>
```

- Contains everything that actually paints: background image (`.bi`),
  canvas group (`.c`), and the text lines (`.t`).
- We no longer gate `.pc` visibility per page — `content-visibility: auto`
  on the parent `.pf` (overlay.css) lets the browser handle paint
  skipping while keeping text findable. ADR 0009 supersedes the old
  `.pf > .pc { display:none }` / `.pf.pdf2html-force > .pc { display:block }`
  contract.
- `pc1` suffix is the page-style index when multiple page sizes coexist.

## `.t` — text line

```html
<div class="t m0 x5 h6 y20 ff4 fs3 fc0 sc0 ls3 ws8">Some text here</div>
```

Every text run. Absolutely positioned inside `.pc`. Text is the `textContent`
of the div (may include `<span>` children for inline style changes).

Inter-word and intra-word gaps may be wrapped in spacer spans. Width-bearing
spacers use a base `._` class plus a utility class such as `._0`, but some PDF
producers emit a literal word gap as `<span class="_"> </span>` with no width
class. Overlay code must not assume every spacer has utility-class geometry or
collapse the literal space in a plain spacer.

The class-word salad is pdf2htmlEX's utility-class system (see below). For
our purposes, `.t` elements are:

- What `window.getSelection()` selects when the user drags or runs Vimium
  visual mode
- What `document.elementFromPoint(x, y)` returns when pointing at text
- What `Selection.focusNode.parentElement` returns (usually; sometimes
  it's a nested `<span>` inside a `.t`)

Geometry: a `.t` box's bottom edge is the PDF baseline and its `h*` height is
the font ascent. The `ff*` class sets `line-height` to ascent − descent, and
the embedded font's own metrics carry the same numbers, so the browser puts
the baseline exactly on the box bottom. The line box is what a selection
highlight paints. Since ADR 0013 the converter derives ascent/descent from the
glyphs the document uses, clamped to 1.0 em / −0.35 em, so a line box stays
text-sized even when a glyph (a TeX delimiter, picture-mode line art) paints
far outside it. Don't use a `.t` rect as a glyph's ink bounds.

A text line can have `visibility:hidden` while a font-class span inside it has
`visibility:visible`, which wins. To hide all HTML text, hide `.t *` too.

Production light-v1 cache variants (`<stem>.light.html`) use
`data-pdf2html-text-mode="paint-safe"`: only `.t` lines proved hidden fallback
text by conservative document-local CSS visibility semantics may be simplified
and receive `data-pdf2html-paint-safe="hidden"`. Visible or ambiguous `.t`
lines are byte-for-byte canonical. `geometry` and `original` modes are
diagnostic experiments, not production DOM contracts; do not depend on their
reduced shapes from overlay code.

## `.bi` — background image

```html
<img class="bi x0 y0 w1 h1" src="…bg1.png" />
```

The rendered raster of the entire page, drawn behind the text spans. In
paint-safe light HTML it is an external `page-images/` asset, lazily mounted
through `data-pdf2html-src`; canonical HTML retains its embedded data URI.
`.t` elements are overlaid on top, positioned so their visible shapes
align with the raster's glyph outlines. Essentially: visual fidelity
comes from the raster; selectable text comes from the overlaid `.t`
elements. The overlay keeps direct `.pc > img.bi` rasters non-draggable so
missed selection drags on page whitespace do not start Chrome image drags.

## `.c` — canvas group

Pure wrapper around all `.t` lines for a page. Rarely useful for overlay
work; mentioned for completeness.

## Outline (TOC) — `#outline > ul > li > a.l`

```html
<div id="outline">
  <ul>
    <li><a class="l" href="#pf15" data-dest-detail='[21,"XYZ",41,781,null]'>Brief Contents</a></li>
    <li><a class="l" href="#pf17" data-dest-detail='[23,"XYZ",41,781,null]'>Table of Contents</a>
      <ul>
        <li><a class="l" href="#pf21" …>Computer Networks and the Internet</a></li>
        <!-- nested sub-chapters -->
      </ul>
    </li>
    …
  </ul>
</div>
```

- Every entry is an `<a class="l">` (class letter L, not I).
- `href="#pfX"` — **hex page ID**. Use the formulae above to convert.
- `data-dest-detail='[page_decimal, "XYZ", x, y, null]'` — the
  PDF-native navigation target. First array element = decimal page
  number (redundant with `href` after conversion but easier to read).
  Format is PDF-internal; we only use array index 0.
- Nesting arbitrary-deep via nested `<ul>`. Top-level entries are
  chapters; nested are sub-sections.
- Our active-chapter highlight adds `.pdf2html-active` to the
  appropriate `a.l`.

## Utility class system (`w0`, `x5`, `ff4`, `fs3`, `fc0`, …)

pdf2htmlEX compresses repeated styles into numbered utility classes
defined at the top of the document's `<style>` block. Common prefixes:

| Prefix | Meaning |
|---|---|
| `w{N}` | width from lookup table (e.g. `w0` might be `816px`) |
| `h{N}` | height |
| `x{N}` | X position |
| `y{N}` | Y position |
| `m{N}` | transform/margin (often `matrix(…)`) |
| `ff{N}` | font-family index |
| `fs{N}` | font-size index |
| `fc{N}` | foreground color |
| `sc{N}` | stroke color |
| `ls{N}` | letter-spacing |
| `ws{N}` | word-spacing |
| `pc{N}` | page-class (on `.pc` — disambiguates docs with mixed page sizes) |

You generally **do not** need to read these. They're pdf2htmlEX's business.
The only time they matter is if you're building a selector like
"all text with font family 7" — then you'd use `.t.ff7`. Rare.

## Runtime globals

| Global | Purpose |
|---|---|
| `window.pdf2htmlEX` | Namespace. We don't touch it. |
| `window.pdf2htmlEX.defaultViewer` | The runtime instance, adapted in `assets/overlay-pdf2htmlex.js`: its render loop (`render`, `schedule_render`, `render_timer`) is neutralized on load (ADR 0002); `view_position`, `scroll_to` and `cur_page_idx` are rebuilt for per-page zoom, and `rescale` (Ctrl/Cmd +/−/0) drives the overlay zoom (ADR 0012); `link_handler` is reused for outline/chapter jumps. Its window `keydown` handler still runs, but keys typed in overlay text fields stop at the document. |

## Zoom and scroll geometry

The overlay's zoom is `--pdf2html-zoom` on `#page-container`, applied as CSS
`zoom` on each `#page-container > .pf` (ADR 0012). The scroller itself is never
zoomed. That gives two coordinate spaces:

- **Scroller coordinates are screen px.** `pc.scrollTop`, `scrollBy`,
  `clientHeight` and every `getBoundingClientRect` agree. Vimium's `j`/`d`
  depend on this.
- **A page's own `offsetTop`/`offsetHeight`/`offsetWidth` are page-local
  units**, i.e. screen px divided by the zoom. They are useful only for a
  page's native size. Never combine them with scroller offsets.

Feature code gets page positions from the document model
(`assets/overlay-document.js`): `pageExtent(pf)` for a page's span in scroller
coordinates, `scrollToPage(pf, lead)` to put a page `lead` px below the
viewport top, `mostVisiblePage()` for the page covering most of the viewport,
and `viewAnchor()`/`restoreViewAnchor()` to keep the reading position across
a rescale. Lengths applied inside a page (e.g. the sidebar shift's
`translateX`) are multiplied by the zoom, so CSS divides them by
`--pdf2html-zoom`.

## Common overlay operations and the selectors they use

| Operation | Selector / API |
|---|---|
| Iterate all pages | `container.querySelectorAll('.pf')` |
| Scroll to a specific page | `documentModel.scrollToPage(documentModel.page(n), lead)` (flush, ignores scroll-padding) or `scrollIntoView({block:'start'})` (honors scroll-padding) |
| Force-show a page | unnecessary — `content-visibility: auto` auto-renders pages near the viewport. |
| Observe page visibility | IntersectionObserver with `root: #page-container`, observing each `.pf` (still useful for outline tracker, page counter, etc.; visibility is no longer JS-controlled) |
| Find current reading page | Follow `pdf2html-page-change` (`assets/overlay-navigation.js` is the one tracker); on demand, `documentModel.mostVisiblePage()`. `document.elementFromPoint(viewport_center)` walked up to `.pf` also works. |
| Iterate outline entries | `outline.querySelectorAll('a[href^="#pf"]')` — captures `a.l` entries cleanly |
| Get selection's current focus | `window.getSelection().focusNode` → walk to `.t` parent if you need the line element |

## What you should NOT do

- **Don't manipulate inline `.pc.style.display`.** pdf2htmlEX's (killed)
  runtime still sets it occasionally. Stick to adding/removing classes
  on `.pf` and letting CSS `!important` win.
- **Don't read `offsetTop`/`offsetHeight` on a `.pf` for positions.**
  They are page-local units under the per-page zoom and go stale on any
  zoom change. Use the document model's rect-based geometry (see "Zoom and
  scroll geometry") or IntersectionObserver.
- **Don't put CSS `zoom` on `#page-container`.** A zoomed scroller makes
  Vimium's steps zoom × too long (ADR 0012).
- **Don't assume hex page IDs are padded.** `pf1` is page 1; `pf01`
  does not exist. Always convert via `.toString(16)` / `parseInt(_,16)`.
- **Don't remove pdf2htmlEX's `<style>` block from the head.** All the
  `w0`/`x5`/`ff4` classes reference rules in there. Our overlay CSS
  is additive.

## Light raster lifecycle and selected fallback paint

The document model caches static page nodes, never their offsets. A page-frame
IntersectionObserver with a 3,500 px vertical preload margin mounts and removes
light raster sources on entry/exit; unchanged scrolling does not scan every
page or rewrite source/state attributes. Page readiness includes all rasters,
and a completion event cannot revive an unloaded page.

Paint-safe lines explicitly marked as hidden fallback text remain transparent
when selected. Their translucent selection background tints the original
raster rather than painting substitute glyphs. Visible/ambiguous canonical
lines and the overlay search-entered highlight path retain their existing
paint. This does not change logical text, reading order or native range metrics.

## Declared page geometry before converter startup

Prepared light HTML carries `data-pdf2html-declared-page-geometry="v1"` and
`data-pdf2html-page-size="width,height,contentHeight"` on every frame. These
are original unzoomed CSS dimensions, not cached scroll offsets. The adapter
validates every record and transform before changing runtime behavior, obtains
the converter's private Page prototype from one visible page, and initializes
the remaining page objects from the declared data before DOMContentLoaded.
This avoids the converter's offscreen `.pc.clientHeight` reads and initial
whole-document render pass. Navigation still measures fresh frame rects.
Missing or malformed records keep the original initialization path.

`prepare-light-runtime.py` externalizes supported embedded font binaries into
content-addressed `page-fonts/` assets without changing font descriptors or text
markup. Canonical HTML stays unchanged. Unsupported font containers retain
original URLs. Idle and selected-page pixels must remain identical for this
preparation step; use the actual browser comparison and startup contract test.

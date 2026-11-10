# The reader

The reader shows a PDF as PDFium page rasters under a transparent text layer.
It is built on demand from the PDF itself; nothing is converted ahead of time.
[ADR 0014](adr/0014-reader-pdfium-rasters-transparent-text.md) records why it
replaces pdf2htmlEX's converted HTML.

## Opening a document

| Route | What it does |
|---|---|
| `GET /read?path=<file>` | Registers the local PDF under its content hash and redirects to `/r/<hash>/`. The file is read in place. |
| `GET /read?url=<url>`, `GET /read-raw?<url>` | Downloads the PDF once into `<hash>/_source/`, registers it and redirects. |
| `GET /r/<hash>/` | The reader shell (HTML). Built on first request, then served from `<hash>/reader/shell.html`. |
| `GET /r/<hash>/p/<page>/<width>.png` | One page rendered `width` device pixels wide. Cached under `<hash>/reader/px/<width>/`. |

`PDF_VIEWER_ENGINE=reader` makes the routes the extension redirects to
(`/view`, `/view-raw`) behave like `/read`, so every PDF opens in the reader.
Unset, or `pdf2htmlex`, keeps converted entries on their HTML and sends a cache
miss to the browser's own viewer; `/read` and `/r/` work either way.

An entry opened on demand has no `mappings.tsv` row. Its name and source live in
`<hash>/entry.json`, and `CacheCatalog.mappings()` merges both
([cache.md](cache.md)).

## Modules

- `daemon/pdfium_doc.py`: every PDFium call. Page sizes, outline, metadata,
  text lines, link annotations and rendering, as plain functions of a PDF path.
  PDFium is not thread-safe, so these only run in worker processes.
- `daemon/reader.py`: the shell markup, the worker pool, and the cache of
  shells and rasters (rasters are evicted least-recently-used above
  `PDF_VIEWER_RASTER_CACHE_MB`, default 1500).
- `daemon/sources.py`: downloading a remote PDF.
- Overlay: `overlay-document.js` (raster lifecycle and geometry),
  `overlay-textfit.js` (text fitting), `overlay-links.js` (link clicks). The
  other overlay modules do not know which engine built the page.

## Units

Everything the daemon emits is in **page px**: origin at the page's top-left
corner, 1 PDF point = 1 px, page rotation and crop box already applied. A `.pf`
frame is that many CSS px wide and high. The overlay's zoom is CSS `zoom` on the
frame (ADR 0012), so page px stay valid inside a page at any zoom.

## DOM contract

The shell uses the names the overlay already used for pdf2htmlEX output, so the
selectors in [pdf2htmlex-dom.md](pdf2htmlex-dom.md) hold. The root carries
`data-pdf2html-representation="raster-v1"`; `documentModel.isReader()` tests it.

```html
<div id="sidebar"><div id="outline">
  <ul><li><a class="l" href="#pf1d" data-reader-dest='[29,"XYZ",70.9,70.9,null]'>Title</a></li></ul>
</div></div>
<div id="page-container">
  <div id="pf1" class="pf" data-page-no="1" style="width:595.28px;height:841.89px">
    <div class="pc">
      <img class="bi" alt="" data-pdf2html-src="/r/<hash>/p/1/1191.png" data-reader-raster="/r/<hash>/p/1/">
      <div class="t" style="left:87.5px;top:78.3px;font-size:11.6px" data-w="419.6">one line of text<br></div>
      <div class="t" style="…"><span data-w="13.2">9.3</span><span class="g" style="padding-left:10.7px"> </span><span data-w="170.4">A heading</span><br></div>
      <a class="l" href="#pfb" style="left:…;top:…;width:…;height:…" data-reader-dest='[11,"XYZ",108,436.9,null]'></a>
    </div>
  </div>
</div>
```

- **Page ids** are hexadecimal, as before: `#pf1d` is page 29.
- **`img.bi`** has no `src` in the markup. The raster lifecycle in
  `overlay-document.js` mounts pages near the viewport and asks for
  `data-reader-raster` + `<css width × zoom × devicePixelRatio>.png`, so the
  image is never resampled. After a zoom or resize it keeps the old image,
  scaled, until the new one has loaded.
- **`.t`** is one line of text, transparent, positioned by its top-left corner.
  Its `font-size` is the line's height on the page. A line is one element so
  that it is one run for native find; a `<br>` ends it so that a copied
  selection has line breaks.
- **Segments.** A line with a wide horizontal gap (table columns, a heading and
  its page number) is split into `<span data-w>` segments separated by a
  `span.g` whose `padding-left` is the gap. `.g` has `font-size: 0`, so its
  space is in the text but takes no room. A line without such a gap carries
  `data-w` itself.
- **`data-w`** is the width the segment occupies on the page. The browser lays
  the text out in a fallback font; `overlay-textfit.js` measures it on a canvas
  and sets the `letter-spacing` that makes it exactly `data-w` wide. That is
  what puts selection and find highlights over the inked glyphs. Visible pages
  are fitted at load, the rest while the browser is idle.
- **Rotated text** has `transform: rotate(…)` about its top-left corner.
  Right-to-left lines carry `dir="rtl"` and are fitted as one segment.
- **Destinations.** `data-reader-dest='[page,"XYZ",x,y,null]'` names a point
  in the target page's px. Outline entries and internal links both use it;
  navigation lands that point 8 px below the viewport top.
- **Links** are empty anchors above the text. External links are limited to
  `http`, `https` and `mailto`. A press that starts on text makes links ignore
  the pointer until release, so a selection can cross a link.

## Rules for overlay code

- Text in a reader page must never get a colour: the raster already shows every
  glyph, and a coloured `.t` would draw fallback-font glyphs on top. Selection,
  search hits and finger hints tint the raster with a background instead (see
  the `raster-v1` block in `overlay.css`).
- Do not read text geometry from `.t` rects before `overlay-textfit.js` has
  fitted the page; use `data-w` and the element's `left`/`top` if you need it
  earlier.
- Derived files under `<hash>/reader/` can be deleted at any time. Bump
  `SHELL_VERSION` in `daemon/reader.py` when the markup changes and
  `TEXT_LAYER_VERSION` in `daemon/pdfium_doc.py` when the text model changes;
  either rebuilds cached shells.

## Measuring it

`bench/reader/` scores the reader against PDFium over the local corpus: opens,
page count, visual difference, copy exactness, find recall and highlight
alignment. See its README.

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
| `GET /r/<hash>/` | The reader shell (HTML). Served from `<hash>/reader/shell.html` once all text has been extracted; before that, built per request with text for a few pages (see [Loading](#loading)). |
| `GET /r/<hash>/text/<k>.json` | Text range `k`: `{"first": 32k+1, "pages": [markup, …], "ocr": [page, …]}`, each page's `.t` lines and links. Cached under `<hash>/reader/text/<k>.json`. |
| `GET /r/<hash>/p/<page>/<width>.png` | One page rendered `width` device pixels wide. Cached under `<hash>/reader/px/<width>/`. |
| `GET /r/<hash>/ocr?pages=1-4&wait=20` | Recognized text of scanned pages as `.t ocr` markup, per page `done`, `pending`, `failed`, `none` or `unavailable`. See "Scanned pages". |

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
  shells, text ranges and rasters (rasters are evicted least-recently-used
  above `PDF_VIEWER_RASTER_CACHE_MB`, default 1500).
- `daemon/sources.py`: downloading a remote PDF.
- `daemon/ocr.py` and `daemon/ocr_vision.swift`: recognition of scanned
  pages (see "Scanned pages").
- Overlay: `overlay-document.js` (raster lifecycle and geometry),
  `overlay-readertext.js` (progressive PDFium text),
  `overlay-textfit.js` (text fitting), `overlay-links.js` (link clicks),
  `overlay-ocr.js` (recognized text for scanned pages). The
  other overlay modules do not know which engine built the page.

## Loading

Extracting the text of every page costs about 3 ms of CPU per page, seconds
for a long book, so the first open does not wait for it:

1. The first request for `/r/<hash>/` gets every page frame (sizes come from
   PDFium in milliseconds), the outline, and text for the first range of 32
   pages plus the range of the reading position the daemon holds for the
   document (`state.db`). Ranges already cached are included too.
2. `overlay-readertext.js` fetches the other ranges, four at a time: first
   any range with a page on screen (also beyond those four), then ranges a
   caller waits for, then outward from the current page, forward first. A
   jump or resume therefore gets its page's text within one range request.
3. Each response is appended to the pages' `.pc`, which leaves the scroll
   position alone: frames carry their size inline and text is absolutely
   positioned. `overlay-textfit.js` fits the new lines at once.
4. When the last range is cached the daemon writes `shell.html`, and later
   opens get the complete shell in one response, as before.

The daemon extracts a range once however many requests ask for it, in tasks
of 8 pages spread over its workers. Page renders and shell work run before
text ranges: the worker pool never holds more tasks than it has workers, and
a queue in front of it orders urgent tasks first. A range that lost a page to
a crashed worker is redone page by page; a page that crashes again is served
without text and the range is not cached, so a later open retries it.

Until the text has arrived, native find and `/` search see only the pages
that have it. `:yank` waits for the pages it copies, and names a page whose
text could not be loaded instead of leaving it out silently.

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
- **Text still loading.** A shell served before all text exists has
  `data-reader-text="loading"`, `data-reader-text-src="/r/<hash>/text/"` and
  `data-reader-text-range="32"` on the root, and `data-reader-pending` on each
  `.pf` without text; that frame's `.pc` holds only the `img.bi`. When a range
  arrives its markup is appended after the image, so a loaded page has exactly
  the complete shell's markup, and `pdf2html-text-ready` (`detail.pages`, page
  numbers) is dispatched on `document`. The root becomes
  `data-reader-text="complete"` when no range is outstanding. The complete
  shell carries `data-reader-text="complete"` and has no pending frames.
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
  are fitted at load, the rest while the browser is idle, and late text as
  soon as it is inserted.
- **Rotated text** has `transform: rotate(…)` about its top-left corner.
  Right-to-left lines carry `dir="rtl"` and are fitted as one segment.
- **Destinations.** `data-reader-dest='[page,"XYZ",x,y,null]'` names a point
  in the target page's px. Outline entries and internal links both use it;
  navigation lands that point 8 px below the viewport top.
- **Links** are empty anchors above the text. External links are limited to
  `http`, `https` and `mailto`. A press that starts on text makes links ignore
  the pointer until release, so a selection can cross a link.

## Scanned pages

A scanned page has no text objects, so PDFium gives it no text layer. The
reader recognizes such pages on this Mac with Apple's Vision framework and
delivers the text afterwards, in the same line format, so selection, copy,
find and Vimium work on them. Nothing leaves the machine.

**Which pages.** `ocr.needs_ocr`: images cover at least half the page and its
PDFium text (segment width × line height, summed) covers less than 1.5 % of
it. A library stamp or page number over a scan does not count as a text
layer; a producer's invisible OCR layer (render mode 3) does, because PDFium
returns that text, so such pages are left alone. Pages with no images (blank
pages, text drawn as outlines) are not recognized. The shell marks recognized
pages `data-reader-ocr="pending"` on the `.pf`. The decision is made only
when that page's PDFium range is extracted. Range caches store the decision;
range responses name scanned pages in `ocr` (1-based), and the overlay marks
them before announcing text ready. The initial response and complete cached
shell derive their markers from the same range metadata. Image coverage is
looked up only for pages that fail the text half of the rule, so born-digital
documents pay nothing.

**How.** `daemon/ocr_vision.swift` is compiled once with `swiftc` into
`~/Library/Caches/pdf_viewer/ocr-tool/pdfv-ocr-<source hash>`
(`PDF_VIEWER_OCR_TOOL_DIR` overrides) and runs as a child process per page:
`VNRecognizeTextRequest`, accurate, language correction on, automatic
language detection (revision 3 reads Norwegian Bokmål and Nynorsk). The page
is rendered in a PDFium worker as a grayscale PNG at 2 px per point, at least
1600 and at most 2600 px wide, 16 MP at most; accuracy was flat from 1.5 to
4 px per point on clean renders. Vision's line and per-word boxes are mapped
to page px, each word's box is shared among its characters along the
direction the text runs, and `pdfium_doc._build_line` groups them, so a wide
gap inside a recognized line becomes segments exactly as for PDFium text and
a skewed baseline breaks into steps. Vision reads text in all four
orientations itself; its corner points give each line's `dir`. Lines below
confidence 0.3 and lines lying on the page's own PDFium text are dropped.
Recognized lines carry the marker class `ocr` (`<div class="t ocr" …>`) and
are otherwise identical to other lines.

**When.** The shell is served without waiting. `overlay-ocr.js` waits for the
visible rasters, then asks `GET /r/<hash>/ocr?pages=…&wait=…` for the visible
pages and then the nearest ones; it inserts the returned lines before the
page's links, has `overlay-textfit.js` fit the page, and marks it `done`. Each request queues newly discovered scanned pages at background priority
(utility QoS, two pages at a time, `PDF_VIEWER_OCR_WORKERS`); pages asked for
with a wait move to the front. Already queued work finishes even after the
tab closes. A small status pill (bottom right) shows while a visible page is
being recognized or the document is incomplete, and when a visible page is a
scan that cannot be recognized.

**Where results live.** `<hash>/reader/ocr/v<OCR_VERSION>/<page>.json`,
written once per page and never redone while `OCR_VERSION` (in `ocr.py`)
stays the same and the source path, mtime, size and TEXT_LAYER_VERSION match;
bump OCR_VERSION when recognition or line building changes. A page
that fails is reported `failed` and not retried until the daemon restarts.

**Limits.** About 0.6 s per page on this Mac (median over 122 scanned corpus
pages, render included; the very first Vision call after boot took 12 s while
its models loaded). Native find sees a page only once its text is in the DOM,
so a long scanned book is fully findable after its background pass. Highlights
follow a skewed line in steps, not along the slope. Handwriting is recognized
roughly. Table columns usually come back as separate lines. Without macOS,
`swiftc` (Xcode Command Line Tools) or with `PDF_VIEWER_OCR=off`, nothing is
recognized and the pages behave as before, apart from the status pill.

**Delivery and completion.** OCR retains its separate endpoint because recognition
is much slower than PDFium extraction and has independent per-page progress.
Progressive ranges and `readerText.whenLoaded` settle on PDFium extraction alone;
`data-reader-text="complete"` never waits for OCR. The OCR module discovers
markers both at mount and on each range insertion, adds lines before links,
and refits them. Yank waits for PDFium ranges, copies the text currently
available, and reports how many scanned pages in its scope are still being
read. It never waits for recognition. The status pill stays below the toast
and uses the same theme tokens.

PDFium work runs in priority order: visible rasters/shell work, text ranges,
then OCR raster preparation. Vision runs in bounded child processes outside
that pool. Entry deletion forgets queued OCR before removing files; a running
recognition may finish, but its final write is locked against deletion and
cannot recreate the entry.

## Rules for overlay code

- Text in a reader page must never get a colour: the raster already shows every
  glyph, and a coloured `.t` would draw fallback-font glyphs on top. Selection,
  search hits and finger hints tint the raster with a background instead (see
  the `raster-v1` block in `overlay.css`).
- Do not read text geometry from `.t` rects before `overlay-textfit.js` has
  fitted the page; use `data-w` and the element's `left`/`top` if you need it
  earlier.
- Code that reads text from the DOM must allow for pages that have none yet
  (`documentModel.isTextPending`), or wait for them with
  `readerText.whenLoaded(from, to)` as `:yank` does.
- Derived files under `<hash>/reader/` can be deleted at any time. Bump
  `SHELL_VERSION` in `daemon/reader.py` when the markup changes and
  `TEXT_LAYER_VERSION` in `daemon/pdfium_doc.py` when the text model changes;
  either rebuilds cached shells and text ranges. Both are also invalidated by
  a change of the source file's mtime or size; the shell also by the title.

## Measuring it

`bench/reader/` scores the reader against PDFium over the local corpus: opens,
page count, visual difference, copy exactness, find recall and highlight
alignment. See its README.

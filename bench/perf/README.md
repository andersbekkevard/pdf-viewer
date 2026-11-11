# Perf bench: reader vs Chrome's native PDF viewer

Time to view, interaction latency and memory (axes A3–A5 of
`docs/plans/hill-climb-week.md`) for the reader (`/read`, `/r/<hash>/`) and for
Chrome's built-in PDF viewer, on the same documents, window, zoom and device
scale factor. Every number is a median over repeated trials in fresh browsers,
reported with its spread, and compared only beyond a noise band.

## Run

The reader needs its own daemon on a scratch cache (ports 7480–7489 only; never
the real cache):

```bash
cd daemon && PDF_VIEWER_ENGINE=reader PDF_VIEWER_CACHE_DIR=/tmp/pdfv-perf/cache \
  PDFV_STATE_DB=/tmp/pdfv-perf/state.db uv run main.py --port 7481
```

Then, with nothing else heavy running:

```bash
uv run bench/perf/run.py --out /tmp/pdfv-perf/results/perf.json            # 8 docs, both engines, 5 trials
uv run bench/perf/run.py --out /tmp/pdfv-perf/results/one.json --docs fa9b7cc99c1e --repeat 1
python3 bench/perf/compare.py /tmp/pdfv-perf/results/perf.json             # table; writes perf.md beside it
```

Options: `--engine reader|native|both`, `--docs SHA,SHA` (manifest sha256
prefixes; default the 8-document set in `run.py`), `--repeat N`, `--base`
(daemon, default `http://127.0.0.1:7481`), `--native-port` (default 7482),
`--headless` (new-headless full Chromium instead of a window; not used for the
reported numbers), `--max-load` (each trial waits up to 2 minutes while the
1-minute load average is above it; default 4), `--keep-frames DIR` (private
content; refused inside the repository).

A trial takes about 30–40 s, so the default run (8 × 2 × 5 = 80 trials) takes
about 45 minutes. Trials run strictly one at a time. Each opens a headed
Chromium for Testing window of 1320×840 at screen position (320, 1100), which
on Anders' desk is the Mac's built-in display below the main one; it never
needs focus.

Files: `run.py` (orchestration, pixel and trace analysis; PEP 723 deps),
`drive.cjs` (one trial in one fresh browser), `compare.py` (stdlib only).

## What one trial does

One fresh browser (Chromium for Testing from the Playwright cache, new
temporary profile), one engine, one document:

| phase | action |
|---|---|
| baseline | `about:blank`, 3 s idle, `footprint` of every browser process (and the daemon tree for the reader) |
| `open_cold` | navigate to the document. Reader: `/read?path=<pdf>` after `DELETE /mapping/<hash>`, so no shell, raster or state exists; the daemon and its worker pool are already running. Native: `http://127.0.0.1:7482/doc.pdf#zoom=125` from a tiny range-capable server in the driver, fresh browser cache |
| `open_warm` | close that tab, open the same URL in a new tab of the same browser (reader: entry and rasters on disk, browser cache warm; reading state reset so it opens at page 1) |
| `scroll10` | wheel events of 100 CSS px every 16 ms at the window centre, enough for 10 pages; traced, no screencast |
| `jump` | type the middle page number and press Enter: reader palette (`:` n Enter), native toolbar page field (click, ⌘A, n, Enter). Timed from Enter |
| `scroll5` | the same wheel input for 5 more pages; timed from the last wheel event |
| memory | screencast off, 3 s idle, `footprint` again |
| `zoom` | one zoom-in step: native toolbar "Zoom in" (125 % → 150 %); reader `:zoom 2.0000` (same factor). Timed from the click / Enter |

Geometry is identical for both engines: window 1320×840 (viewport 1320×753
CSS px), device scale factor 2 (`--force-device-scale-factor=2`, real window,
no viewport emulation), and the same on-screen page size. Native 100 % is 4/3
CSS px per PDF point, the reader's zoom is CSS px per point, so native 125 %
equals reader zoom 1.6667 and native 150 % equals reader 2.0. On the
1677-page and the letter-size documents the trial's recorded page numbers
after each phase agree between engines (e.g. 1 → 11 after `scroll10`, 839 at
the jump, 844 after `scroll5`), which checks that both covered the same
distance.

The reader's ⌘+ has no overlay handler (in Chromium it falls through to
browser zoom), so the reader's zoom step uses the palette's documented `:zoom`
command; the native step uses the toolbar button. Both are one discrete step
of the same factor.

## The visual signal

The native viewer is an embedded plugin in out-of-process frames; there is no
DOM that says "page painted". So every latency is read from pixels, the same
way for both engines:

- CDP `Page.startScreencast` (JPEG q80, full device resolution) delivers
  frames with their compositor timestamps. The screencast only emits a frame
  when the **top-level** document submits one, so a repaint inside the native
  viewer's PDF frame alone can go uncaptured. This was observed: the native
  zoom's re-render never appeared until a forced screenshot. The driver
  therefore adds, in the top-level document of both engines, a 4×4 px
  compositor-only opacity animation in the bottom-right corner, too faint to
  change any pixel value. It makes the top-level document submit a frame on
  every vsync, so every repaint anywhere in the tab is captured. Frames whose
  JPEG is byte-identical to the previous frame are dropped; what remains is
  one frame per visual change. The animation is off during the traced scroll
  and the memory idle.
- A blinking caret (native page field, reader palette) changes the frame
  every 500 ms; the driver makes carets transparent in both engines.
- A phase ends when no changed frame has arrived for 1.5 s (2.5 s for opens)
  and, for the reader, the DOM says the visible pages hold rasters at their
  device width; then a forced `Page.captureScreenshot` is taken.
- Pixel comparison uses a fixed content region, 30–70 % of the width and
  10–97 % of the height (clear of the native toolbar and thumbnail sidebar).
  Two frames match when fewer than 0.2 % of the region's pixels differ in luma
  by more than 40 levels.

**Complete** (the latency reported for open, jump, scroll settle and zoom):
the timestamp of the earliest frame from which every later frame in the phase
matches the phase's final frame, minus the time of the input.

### Signal validation

- Every phase's final screencast frame is compared with the forced
  screenshot (`final_vs_shot` in the JSON). After the frame pump it is 0.0 in
  every checked phase; before it, native zoom was 0.20 and its time (47 ms)
  was wrong.
- For the reader, `dom_crisp_ms` (first poll at which the visible pages are
  `data-pdf2html-raster-state="ready"` with `naturalWidth` equal to the device
  width) is recorded next to the pixel time. They agree within 5–30 ms, the
  pixel time usually later (decode and paint) and sometimes earlier (the DOM is
  polled every 50 ms).
- Thresholds were checked on real frames: the reader's interim, scaled raster
  after a zoom differs from the final in 2 % of region pixels (10× the
  threshold), native's intermediate states in 17–93 %, and frames after
  completion in 0.0 %. Native zoom goes straight to a crisp page in the region
  (no blurry stage), so its zoom time is not hiding a low-resolution interim.
- By eye, one document per metric (contact sheets, deleted afterwards):
  reader open shows a white page and then the whole raster; native open shows
  its frame and thumbnails, then the page; the reader's jump shows a blank
  page for ~30 ms before the raster; the reader's zoom shows the scaled old
  raster until the new one arrives.

Time resolution is one display frame (8.3 ms at 120 Hz) plus JPEG capture
latency, which is the same for both engines.

## Metrics

| metric | definition | trust |
|---|---|---|
| `open_cold_ms` | navigation start → *complete* for the first viewport, reader with no cache entry, native in a fresh profile | trusted; for the reader it includes the shell build (see costs) |
| `open_warm_ms` | the same, second open in a new tab of the same browser | trusted |
| `open_cold_first_content_ms` | first frame whose region is not uniform (anything painted) | informational |
| `scroll_stall_fraction` | during `scroll10`, share of 16 ms input periods in which the display compositor presented no frame (`Display::DrawAndSwap` in the GPU process, trace clock aligned with a `performance.mark`) | trusted for stalls; see below |
| `scroll_long_frames` | `scroll10` swap intervals longer than two input periods (32 ms) | trusted |
| `scroll_fps` | swaps per second during `scroll10` | information only, not a quality measure |
| `scroll_settle_ms` | last wheel event of `scroll5` → *complete* | trusted, documents ≥ 16 pages only |
| `jump_ms` | Enter → *complete* | trusted |
| `zoom_ms` | click / Enter → *complete* at the new zoom | trusted |
| `memory_browser_mb` | sum of `phys_footprint` over the browser process and all its descendants after the journey, minus the same browser's empty-tab baseline; the tracing service process (exists only because the bench traced) is excluded | trusted as a whole-browser number; per-process split is noisy (the GPU process can shrink below its baseline) |
| `memory_total_mb` | reader: browser delta + growth of the daemon tree (daemon and worker processes, `footprint`) during the trial; native: browser delta | partly; see below |
| reader rasters | number and bytes of `/r/<hash>/p/<n>/<w>.png` responses per phase (Playwright `requestfinished`, `responseBodySize`), request time | trusted |

Why the scroll measure is stalls and not dropped vsyncs: the built-in display
runs at 120 Hz while wheel input arrives every 16 ms (62.5 Hz). The native
viewer animates each wheel step across vsyncs and presents ~119 frames per
second; the reader's scroller moves once per wheel event and presents ~80.
Counting missed vsyncs would score that as 35 % dropped frames for the
reader, which is a difference in scroll animation, not jank. A stall (an
input period with no new frame) is a fair comparison: both engines would show
0 when keeping up. `vsync_dropped_fraction` and the interval percentiles stay
in the JSON.

The daemon's footprint is shared by all documents and includes Python
interpreters for the worker pool; the first reader trial after a daemon start
also pays for spawning the workers, so `daemon_delta` is high in rep 0. The
absolute daemon footprint is reported separately in the reader-only table.

### Noise and verdicts

`compare.py` reports median ±MAD over trials. A difference is called only
when |reader − native| > 2·max(MAD_reader, MAD_native) + floor, with a floor
of max(one 60 Hz frame, 5 %) for times, max(10 MB, 5 %) for memory and 0.01
for fractions (plan §5). Inside the band the verdict is *noise*. Engines
alternate order between repetitions so slow drift hits both. Each trial
records the load average at its start.

## Privacy and cleanup

Corpus documents are mostly private. The result JSON holds numbers, sha256
prefixes, page counts and manifest labels only. Frames are written to
`/tmp/pdfv-perf/work/<trial>/` and deleted after the trial is scored. The
reader trial's cache entry is deleted before each cold open and after the
last trial of each document (`DELETE /mapping/<hash>`, which also forgets
reading state).

## Not measured

- Comet, real Vimium, and Vimium `j`/`d` key scrolling (wheel input stands in).
- Native Cmd-F to a far hit and selection drag latency (plan A4).
- CPU time and energy.
- The native viewer's memory for documents it has to download from the web
  (the PDF comes from loopback).
- GPU memory as such: `footprint` of the GPU process includes IOSurfaces, but
  the per-process numbers move by ±50 MB between identical trials.

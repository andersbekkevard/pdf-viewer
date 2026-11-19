# Cold PDF conversion

Time starts at navigation to a new local PDF. Each trial uses a different
content hash and an empty derived cache for that document. The fixtures have
stable modification times, so the previous save debounce contributes zero
to the baseline. Network transfer and OCR are outside this measurement.

The browser records the first visible raster and the first device-width
raster after two animation frames. Conversion is complete when the first
sharp raster and the entire searchable text layer are both ready. The
baseline is the deployed Mac runtime captured locally at `fef79ee`.

Chromium 158.0.8127.18 ran eight trials each on deterministic 12-, 128- and
768-page text PDFs, with one separate warm-up for the browser and workers.
Europa used affinity to eight logical CPUs. The heavier run added eight CPU
burners on the same CPUs. The 12-core Mac ran with its ordinary system load
and with eight added burners. Results are nearest-rank percentiles in ms.

| Host and load | Conversion P50 | Conversion P90 | First sharp P50 | First sharp P90 |
|---|---:|---:|---:|---:|
| Europa, no added load | 416 → 193 | 1,880 → 706 | 169 → 167 | 296 → 246 |
| Europa, eight burners | 1,268 → 545 | 5,511 → 1,992 | 402 → 321 | 627 → 517 |
| Mac, no added load | 246 → 103 | 1,021 → 351 | 109 → 96 | 160 → 136 |
| Mac, eight burners | 319 → 178 | 1,337 → 472 | 141 → 116 | 205 → 171 |

Europa cleared 50% at both percentiles in both conditions. The Mac cleared
50% on both quiet percentiles and the loaded P90. Its loaded median improved
44%. Both first-sharp percentiles improved in all four runs.

## Reproduce

```sh
fixtures=$(mktemp -d)
uv run bench/perf/generate-text.py "$fixtures" --pages 12 128 768 --unique-words --flat
PDFV_COLD_REPEATS=8 taskset -c 0-7 scripts/verify-extension.sh --cold-reader "$fixtures"
PDFV_COLD_REPEATS=8 PDFV_STARTUP_LOAD=8 taskset -c 0-7 scripts/verify-extension.sh --cold-reader "$fixtures"
```

On macOS omit `taskset -c 0-7`. Use the same harness and fixtures in the
baseline checkout. The benchmark emits samples and summaries as JSON.

## Fidelity

The same PDFium wheel produced identical text markup, scan decisions,
geometry, outlines and metadata on 55 synthetic PDFs and 139 sampled
pages. JPEG and PNG matched byte for byte at widths 740 and 2250. Both
builds rejected rendering the same malformed zero-width page. The
10-document browser scorecard against PDFium preserved visual scores,
copy similarity, find recall, highlight overlap and failure classes,
including the baseline transparency and text-selection misses.

`bench/reader/fidelity.py` records hashes for exact comparisons. Use
`bench/reader/run.py` for browser and underlying-PDF comparisons.

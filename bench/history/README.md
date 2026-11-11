# Real-history reader replay

Run `uv run bench/history/run.py --days 60 --port 7445`. Optional flags:
`--browser chrome|comet|all`, `--profile Default` (or `Profile 1`),
`--limit 300`, `--extract-only`. Python uses uv; Chromium uses the cached
Playwright install found by `scripts/lib/playwright.sh`. Nothing is installed.
The runner starts and stops its own daemon, cache and state database. Port 7435
is forbidden. It never operates an owner browser or uses a live profile for
Chromium.

Extraction copies each selected `History` database and its WAL into a temporary
directory, then queries the copy read-only. Counts are visits within the window,
not lifetime URL counts. It recognizes PDF paths, file URLs and viewer URLs on
localhost:7435, resolving cache hashes through read-only mappings and entry
manifests. Viewer redirects and their source visits may both occur in history;
visit counts are navigation frequency, not independent reading sessions.
Fragments are deduplicated, as are local documents with identical bytes.
Missing mappings and missing files are `gone`. A public candidate is an HTTP(S)
PDF URL without a query, userinfo or a recognizable auth/session path. Every
query-bearing URL is conservatively `needs-session` and skipped, even if public.
Other auth gates can only be discovered by the credential-free request. No
cookies or browser credentials are copied or sent.

Documents are replayed in decreasing visit frequency, at most 300, sequentially.
Requests start at most once a second per host, and the remaining documents from
a host are skipped after its first failure. The reader's downloader may follow
redirects; pacing does not independently schedule those hops. A fresh browser
context reaches only the scratch daemon. One host failure does not justify
calling the remaining documents broken.

All per-document artifacts are under `~/.cache/pdf_viewer-bench/history/`,
never this repository. `manifest.json` and `*-spec.json` contain private sources;
the containing directory is mode 0700. Result files contain visit counts,
classification, outcome, failure class, page count, load average, first-raster
and text-completion latency, scanned-page count, observed OCR lines and console
error counts. Their keys are SHA-256 prefixes: local keys hash document bytes;
remote/unresolved keys hash source identity, since bytes may be inaccessible.
They are opaque diagnostic references, not public source attribution.

First raster means a decoded visible raster plus two animation frames. Text
completion is the PDFium layer, independently of OCR. OCR line counts are what
has arrived by observation; a bounded wait for visible scanned pages does not
prove whole-book OCR completion. Copy similarity uses NFKC, removes whitespace
and compares the first DOM page with independent PDFium text. Local first-page
PDFium words (up to eight) are tested with Chromium `window.find`; remote find
recall is unavailable. These cheap samples reuse the reader benchmark's metric
ideas, not its full geometry/highlight scorecard. Scans have no PDFium text
reference and get no copy score. Browser and per-document subprocess timeouts
are bounded. `harness-*` failures do not establish a reader defect.

`aggregate.json` reports the extracted denominator, replay coverage, failure
classes and nearest-observation p50/p95. Visit-weighted success is successful
reader+text visits divided by attempted visits, excluding host-policy skips;
it says nothing about session-dependent and missing sources. `replayed_visits`
and `eligible_visits` expose this coverage. The daemon's live aggregate is
separate: see [observability](../../docs/observability.md).

## Measurement

Results and diagnosis from the 60-day run are recorded below after completion.
This is a reader measurement, not a before/after performance claim. The machine
is shared; load averages accompany each per-document result. Original sources
can change between a historical visit and today's replay. Chromium headless
does not establish Comet, Vimium or extension sign-in integration.

### 60-day run, 2026-11-10 (Boston)

Command: `uv run bench/history/run.py --days 60 --port 7445`.
Four profiles (three Chrome, one Comet). One-minute system load ranged from
9.8 to 57.2: these are shared-machine observations, not stable latency targets.

| Extracted class | Distinct documents |
|---|---:|
| Local files present (deduplicated by bytes) | 126 |
| Public URL candidates | 85 |
| Session-dependent, skipped without credentials | 589 |
| Gone files / unresolved viewer references | 65 |
| Total | 865 |

| Replay measurement | Result |
|---|---:|
| Eligible documents | 211 |
| Attempted | 168 |
| Host-first-failure policy skips | 43 |
| Successful reader + text opens | 162 / 168 (96.4%) |
| Visit-weighted success | 95.33% of 793 attempted visits |
| Eligible visits, including host-policy skips | 957 |
| First page p50 / p95 (nearest rank, successful samples) | 273 / 2,184 ms |
| PDFium text complete p50 / p95 | 279 / 2,250 ms |
| Documents with scanned pages / observed OCR text | 23 / 9 |
| First-page copy similarity median | 1.000 |
| Browser find recall, mean across 116 local samples | 1.000 |

OCR was observed during delivery, not awaited over every page; the 14 scans
without observed OCR text are unverified OCR coverage, not established OCR
failures. No rendering regression is established by this run. The low visit
coverage of session-dependent history remains the largest blind spot.

### Failure investigation

The initial harness mislabeled upstream HTTP failures as PDFium failures when
it examined status before the final route. It now labels a 502 `pdfium-failed`
only on `/r/`; upstream status errors remain source failures. Final aggregates
were reclassified from private daemon evidence, and percentiles recomputed with
nearest rank. `raw-aggregate.json` retains the original output;
`aggregate.json`, `results.json` and `failure-diagnosis.json` retain the diagnosed
result outside this repository. The correction does not change success counts.

| Diagnosed class | Count | Evidence and ownership |
|---|---:|---|
| Not a PDF | 3 | Cookie-free responses failed the PDF signature check; source response, possibly an auth page |
| Needs session | 1 | HTTP authorization rejection; source/session restriction |
| Source/network | 1 | Download failed before any `/r/` shell request; original PDFium label was a harness defect, fixed |
| Source download deadline | 1 | Download took 77.7 s, beyond the 60 s browser navigation bound; source/network plus harness deadline |
| Host-policy skip | 43 | Untested after a host's first failure, not document failures |

Worst failed identities: `eaf98c6b2f2d0aa2`, `20367c490b4f581e` and
`30f0131a16ac928d` returned non-PDF bytes; `7913900fbf3667dc` required a
session; `90b64f2af50c9ae1` failed in download; `44e9a350d3df66d1` exceeded
the navigation deadline. For the last document, independent PDFium found 11
pages; sizes, metadata and outline took at most 2 ms, first-page text 13 ms.
A cached-browser retry was attempted after runner shutdown and could not run;
it provides no additional evidence. The underlying reader did not fail in
these six cases, so no raster or reader-engine changes were made.

Slowest successful remote identities: `876e21001e72216c` (57.30 s),
`7923ba00ade34bf0` (15.29 s), `c5ff2bc0b9187af4` (7.83 s) and
`e1bd4a046535b3b5` (5.79 s). These are download-plus-shell-plus-browser timings;
the run does not isolate reader CPU from network time for these successes.

### Verification and remaining limits

- `uv run --directory daemon python -m unittest discover -s tests`: final run
  passed 181 tests, one skipped. Earlier runs intermittently failed existing
  `TextRangeTest.test_urgent_tasks_run_first`: it checks callback completion
  order after freeing parallel workers, rather than dispatch priority. Reader
  scheduler and raster code were left untouched.
- `uv run --directory daemon python -m unittest tests/test_opens.py tests/test_history.py`:
  10 focused contracts passed.
- Headless fixture through scratch daemon: one page; first raster 367 ms,
  text 370 ms, sampled find recall 1.0, zero console/overlay errors; `/stats`
  received timing samples. Missing source returned 404. This is an initial
  measurement; no before/after performance improvement is claimed.
- `uv run scripts/open-stats.py --daemon http://127.0.0.1:7445 --json`,
  `uv run scripts/inject-overlay.py --print-version`, JS syntax checks and
  `git diff --check` passed.
- The production-cache smoke script was not run. A direct invocation of
  `verify-overlay.cjs` was stopped after discovering its state-reset origin is
  hardcoded to port 7435 despite a scratch URL. It issued a reset for the public
  fixture hash; whether a saved fixture position existed cannot be established.
  It also assumes the pdf2htmlEX runtime and is not a reader proof. No successful
  general-overlay verifier result is claimed.
- An early relay-wrapper test created a default-cache `opens.db` containing nine
  synthetic rows. Every row was verified against the synthetic test hash and the
  newly created database/sidecars were removed. Direct-call tests now bypass
  telemetry, covered by a regression test. No production daemon was restarted.
- Extraction copies are not atomic snapshots of a concurrently active browser;
  newly committed visits can be absent. Remote identity hashes differ from
  content hashes. Session-gated sources, extension relay, actual Comet/Vimium,
  full-document OCR, and visual/highlight fidelity are not proved by this run.

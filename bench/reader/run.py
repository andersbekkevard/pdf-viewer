#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pypdfium2==5.14.0", "numpy>=2", "pillow>=11", "rapidfuzz>=3"]
# ///
"""Reader scorecard: open locally present corpus PDFs in the reader and score them.

For each selected manifest row whose PDF is on disk, the bench opens
`<base>/read?path=<pdf>` in headless Chromium, records whether and how fast
the reader opens it (A6, A3), and for up to --max-pages pages measures visual
equivalence with a direct PDFium render (A1) and text accuracy of the
transparent text layer (A2: copy exactness, find recall, highlight IoU).
Definitions and thresholds: bench/reader/README.md.

Usage:
    uv run bench/reader/run.py --out /tmp/pdfv-bench/reader-t1.json [--tier t1]
        [--limit N] [--sha PREFIX ...] [--base http://127.0.0.1:7436] [--jobs 3]
        [--max-pages 5] [--doc-timeout 300] [--keep-artifacts DIR] [--include-existing]

Privacy: corpus documents may be private. The output JSON holds numbers,
sha256 and manifest labels only; document text stays in memory, and page
screenshots under /tmp/pdfv-bench/work are deleted after scoring unless
--keep-artifacts is given. Cache entries the run creates in the daemon's cache
are deleted through DELETE /mapping/<hash>; entries that existed before the run
are skipped (opening one via /read would rewrite its source reference) unless
--include-existing, which opens them read-only through /r/<hash>/.
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import datetime as dt
import json
import os
import pathlib
import re
import shutil
import signal
import statistics
import subprocess
import sys
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parents[1]
REF = HERE / "pdfium_ref.py"
DRIVE = HERE / "drive.cjs"
sys.dont_write_bytecode = True  # do not leave __pycache__ in bench/corpus/probe
sys.path.insert(0, str(REPO / "bench" / "corpus" / "probe"))
import shared  # noqa: E402  (corpus location, Playwright lookup and thresholds)

BENCH_VERSION = "2"
SCRATCH = pathlib.Path(os.environ.get("PDFV_BENCH_SCRATCH", "/tmp/pdfv-bench"))
CACHE = pathlib.Path(os.environ.get("PDF_VIEWER_CACHE_DIR", str(pathlib.Path.home() / ".cache" / "pdf_viewer")))

# Visual comparison geometry, as the old probe: fit-width 1600 CSS px at DPR 2.
FIT_WIDTH_CSS = shared.FIT_WIDTH_CSS
DPR = shared.DPR
MAX_PAGE_CSS_HEIGHT = shared.MAX_PAGE_CSS_HEIGHT
INK_DARK, INK_RADIUS = shared.INK_DARK, shared.INK_RADIUS
VISUAL, VISUAL_HIGH, BLUR_FAINT = shared.VISUAL, shared.VISUAL_HIGH, shared.BLUR_FAINT
SIZE_DELTA_PX, TEXT_LOSS_RATIO = shared.SIZE_DELTA_PX, shared.TEXT_LOSS_RATIO

# Reader-only text thresholds (no old-engine counterpart; see README).
WORDS_PER_PAGE = 8
COPY_MIN_CHARS = 50          # pages with fewer PDFium characters get no copy class
COPY_SIM_MIN = 0.95          # copy-mismatch below this on any page
IOU_MEDIAN_MIN = 0.5         # highlight-misaligned below this document median
RASTER_UNDERRES_PX = 2       # raster narrower than the device width by more than this

T_INFO, T_TEXT, T_COMPARE = 120, 180, 300


def run(cmd, timeout, env=None):
    t0 = time.monotonic()
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL,
                            env=env, start_new_session=True, text=True, errors="replace")
    try:
        out, err = proc.communicate(timeout=timeout)
        timed_out = False
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        out, err = proc.communicate()
        timed_out = True
    return {"rc": proc.returncode, "out": out, "err": err, "timeout": timed_out,
            "seconds": round(time.monotonic() - t0, 2)}


def last_json(text):
    for line in reversed((text or "").strip().splitlines()):
        try:
            return json.loads(line)
        except json.JSONDecodeError:
            continue
    return None


# ----------------------------------------------------------------- text metrics

def norm_text(s: str) -> str:
    """Whitespace-normalized text: PDFium's hyphen markers as '-', other
    control/format characters dropped, whitespace runs collapsed to one space."""
    s = s.replace("￾", "-").replace("\x02", "-")
    s = "".join(ch for ch in s if ch.isspace() or unicodedata.category(ch) not in ("Cc", "Cf"))
    return re.sub(r"\s+", " ", s).strip()


def similarity(a: str, b: str) -> float:
    """1 − Levenshtein(a, b) / max(len a, len b); 1.0 when both are empty."""
    from rapidfuzz.distance import Levenshtein
    if not a and not b:
        return 1.0
    return Levenshtein.normalized_similarity(a, b)


def iou(rects_a, rects_b, res=4.0) -> float:
    """IoU of two unions of axis-aligned rectangles (page px), rasterized at
    `res` samples per px."""
    import numpy as np
    if not rects_a or not rects_b:
        return 0.0
    allr = rects_a + rects_b
    x0 = min(r[0] for r in allr)
    y0 = min(r[1] for r in allr)
    x1 = max(r[2] for r in allr)
    y1 = max(r[3] for r in allr)
    w = max(1, int((x1 - x0) * res + 1))
    h = max(1, int((y1 - y0) * res + 1))
    if w * h > 4_000_000:  # absurd geometry: fall back to bounding boxes
        res = res * (4_000_000 / (w * h)) ** 0.5
        w = max(1, int((x1 - x0) * res + 1))
        h = max(1, int((y1 - y0) * res + 1))

    def mask(rects):
        m = np.zeros((h, w), dtype=bool)
        for r in rects:
            a0, b0 = int(round((r[0] - x0) * res)), int(round((r[1] - y0) * res))
            a1, b1 = int(round((r[2] - x0) * res)), int(round((r[3] - y0) * res))
            m[max(0, b0):max(0, b1), max(0, a0):max(0, a1)] = True
        return m

    ma, mb = mask(rects_a), mask(rects_b)
    union = int((ma | mb).sum())
    return float((ma & mb).sum()) / union if union else 0.0


def iou_x(rects_a, rects_b) -> float:
    """IoU of the horizontal extents only (bounding x-interval of each set):
    separates horizontal drift from the line box being taller than the glyphs."""
    if not rects_a or not rects_b:
        return 0.0
    a0, a1 = min(r[0] for r in rects_a), max(r[2] for r in rects_a)
    b0, b1 = min(r[0] for r in rects_b), max(r[2] for r in rects_b)
    inter = max(0.0, min(a1, b1) - max(a0, b0))
    union = max(a1, b1) - min(a0, b0)
    return inter / union if union > 0 else 0.0


def pct(values, q):
    """Nearest-rank-free linear percentile (q in 0..100)."""
    v = sorted(values)
    if not v:
        return None
    if len(v) == 1:
        return v[0]
    k = (len(v) - 1) * q / 100
    lo = int(k)
    hi = min(lo + 1, len(v) - 1)
    return v[lo] + (v[hi] - v[lo]) * (k - lo)


def rnd(x, n=4):
    return None if x is None else round(x, n)


# ----------------------------------------------------------------- sampling

def pick_pages(n: int, old_samples: list[int], k: int) -> list[int]:
    """The old probe's sampled pages first (comparability), then evenly spaced
    pages, at most k in all."""
    chosen = [p for p in sorted(set(old_samples)) if 1 <= p <= n][:k]
    if k > 1:
        spread = [1 + round(i * (n - 1) / (k - 1)) for i in range(k)]
    else:
        spread = [1]
    for p in spread:
        if len(chosen) >= k:
            break
        if p not in chosen:
            chosen.append(p)
    return sorted(chosen)


def geometry(sizes, pages):
    dims = [sizes[p - 1] for p in pages if p - 1 < len(sizes) and min(sizes[p - 1]) > 1]
    if not dims:
        return None
    max_w = max(d[0] for d in dims)
    max_h = max(d[1] for d in dims)
    zoom = max(min(FIT_WIDTH_CSS / max_w, MAX_PAGE_CSS_HEIGHT / max_h, 10.0), 0.25)
    vw = int(max_w * zoom) + 100
    vh = int(max_h * zoom + 60 * zoom) + 100
    return zoom, vw, vh


# ----------------------------------------------------------------- the bench

class Bench:
    def __init__(self, args, corpus: pathlib.Path, preexisting: set[str]):
        self.args = args
        self.corpus = corpus
        self.preexisting = preexisting
        self.python = sys.executable
        self.node_path = shared.playwright_node_path()
        self.created: set[str] = set()
        self.deleted: dict[str, str] = {}
        self.lock = threading.Lock()

    def worker(self, mode, pdf, spec, wdir, timeout):
        spec_path = wdir / f"{mode}-spec.json"
        spec_path.write_text(json.dumps(spec))
        r = run([self.python, "-I", "-B", str(REF), mode, str(pdf), str(spec_path)], timeout)
        res = last_json(r["out"]) if not r["timeout"] else None
        if res is None:
            res = {"worker_error": "timeout" if r["timeout"] else f"exit {r['rc']}: {r['err'].strip()[-300:]}"}
        res["seconds"] = r["seconds"]
        return res

    def delete_entry(self, hash_: str) -> None:
        """Remove an entry this run created (never one that existed before)."""
        if hash_ in self.preexisting or not re.fullmatch(r"[0-9a-f]{6,32}", hash_):
            return
        req = urllib.request.Request(f"{self.args.base}/mapping/{hash_}", method="DELETE")
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                status = str(resp.status)
        except urllib.error.HTTPError as exc:
            status = str(exc.code)
        except Exception as exc:
            status = f"error {type(exc).__name__}"
        with self.lock:
            self.deleted[hash_] = status

    def score(self, row: dict) -> dict:
        sha = row["sha256"]
        pdf = self.corpus / "files" / sha[:2] / f"{sha}.pdf"
        wdir = SCRATCH / "work" / sha[:16]
        shutil.rmtree(wdir, ignore_errors=True)
        wdir.mkdir(parents=True)
        t0 = time.monotonic()
        doc = {"sha256": sha, "tier": row.get("tier"), "labels": row.get("labels", []),
               "manifest_pages": row.get("pages"), "classes": [], "notes": []}
        try:
            self._score(row, pdf, wdir, doc)
        except Exception as exc:
            doc["classes"].append("bench-error")
            doc["notes"].append(f"bench: {type(exc).__name__}: {exc}"[:300])
        finally:
            hash_ = doc.get("hash")
            if hash_ and hash_ not in self.preexisting and (CACHE / hash_).exists():
                with self.lock:
                    self.created.add(hash_)
                self.delete_entry(hash_)
            if self.args.keep_artifacts:
                keep = pathlib.Path(self.args.keep_artifacts) / sha[:16]
                keep.mkdir(parents=True, exist_ok=True)
                for f in wdir.glob("shots/*.png"):
                    shutil.move(str(f), keep / f.name)
            shutil.rmtree(wdir, ignore_errors=True)
        doc["classes"] = sorted(set(doc["classes"]))
        doc["seconds"] = round(time.monotonic() - t0, 1)
        return doc

    def _score(self, row, pdf, wdir, doc):
        sha = row["sha256"]
        info = self.worker("info", pdf, {}, wdir, T_INFO)
        if info.get("open_error") or info.get("worker_error"):
            doc["classes"].append("pdfium-error")
            doc["notes"].append("pdfium: " + str(info.get("open_error") or info.get("worker_error"))[:200])
        n = info.get("pages") or 0
        doc["pdfium_pages"] = n or None
        sizes = info.get("page_sizes") or []
        old = self.old_probe(sha)
        old_samples = ((old or {}).get("policy") or {}).get("sample_pages") or []
        pages = pick_pages(n, old_samples, self.args.max_pages) if n else []
        doc["sampled_pages"] = pages
        geo = geometry(sizes, pages) if pages else None
        zoom, vw, vh = geo if geo else (1.0, 1300, 1100)
        doc["zoom"] = round(zoom, 6)
        doc["viewport"] = [vw, vh]

        text = {}
        if pages:
            tres = self.worker("text", pdf, {"pages": pages, "words": WORDS_PER_PAGE}, wdir, T_TEXT)
            if tres.get("worker_error") or tres.get("open_error"):
                doc["notes"].append("pdfium text: " + str(tres.get("worker_error") or tres.get("open_error"))[:200])
            for p in tres.get("pages", []):
                text[p["page"]] = p

        if (CACHE / sha[:16]).exists() and sha[:16] not in self.preexisting:
            # Someone else (another daemon or agent) created this entry after the
            # run started: never re-register or delete it; open it read-only.
            with self.lock:
                self.preexisting.add(sha[:16])
            doc["notes"].append("entry appeared during the run; opened read-only and kept")
        if doc["sha256"][:16] in self.preexisting:
            hash_ = sha[:16]
            url = f"{self.args.base}/r/{hash_}/"
            doc["open_via"] = "existing-entry"
        else:
            url = f"{self.args.base}/read?path={urllib.parse.quote(str(pdf), safe='')}"
            doc["open_via"] = "read"
        spec = {"textOnly": self.args.text_only, "readUrl": url, "zoom": zoom, "viewport": {"width": vw, "height": vh}, "dpr": DPR,
                "outDir": str(wdir / "shots"), "rasterWaitMs": self.args.raster_wait * 1000,
                "openTimeoutMs": self.args.doc_timeout * 1000,
                "pages": [{"page": p, "words": [w["word"] for w in text.get(p, {}).get("words", [])]}
                          for p in pages]}
        spec_path = wdir / "drive-spec.json"
        spec_path.write_text(json.dumps(spec))
        r = run(["node", str(DRIVE), str(spec_path)], self.args.doc_timeout,
                env=dict(os.environ, NODE_PATH=self.node_path or ""))
        spec_path.unlink(missing_ok=True)
        drv = last_json(r["out"]) if not r["timeout"] else None
        doc["drive_seconds"] = r["seconds"]
        if r["timeout"]:
            doc["classes"].append("doc-timeout")
        if drv is None:
            drv = {}
            if not r["timeout"]:
                doc["classes"].append("bench-error")
                doc["notes"].append("drive: " + r["err"].strip()[-300:])
        if drv.get("fatal"):
            doc["classes"].append("bench-error")
            doc["notes"].append("drive fatal: " + drv["fatal"].splitlines()[0][:300])
        m = re.match(r"^/r/([0-9a-f]+)/$", drv.get("finalPath") or "")
        if m:
            doc["hash"] = m.group(1)
        elif doc["open_via"] == "existing-entry":
            doc["hash"] = sha[:16]
        else:
            # The run may still have registered the entry before failing.
            doc["hash"] = sha[:16] if (CACHE / sha[:16]).exists() else None

        o = {"status": drv.get("status"), "redirects": drv.get("redirects"),
             "response_ms": drv.get("responseMs"), "dom_ms": drv.get("domMs"),
             "first_raster_ms": drv.get("firstRasterMs"), "pf_count": drv.get("pfCount"),
             "representation": drv.get("representation"), "zoom_var": drv.get("zoomVar"),
             "console_errors": len(drv.get("consoleErrors") or []),
             "page_errors": len(drv.get("pageErrors") or []),
             "failed_requests": len(drv.get("failedRequests") or [])}
        doc["open"] = o
        # Error strings carry URLs and code locations, not document text; keep a few, without paths.
        scrub = lambda s: re.sub(r"path=[^\s&]+", "path=<pdf>", s)[:200]
        doc["open_detail"] = {k: [scrub(x) for x in (drv.get(k) or [])[:5]]
                              for k in ("consoleErrors", "pageErrors", "failedRequests") if drv.get(k)}
        if drv.get("openError"):
            doc["open_detail"]["openError"] = scrub(drv["openError"])

        opened = (drv.get("status") == 200 and drv.get("pfCount") and m is not None
                  and drv.get("representation") == "raster-v1")
        if drv and not r["timeout"] and not drv.get("fatal") and not opened:
            doc["classes"].append("open-failed")
        if drv.get("pfCount") is not None and n and drv["pfCount"] != n:
            doc["classes"].append("page-count-mismatch")
        if opened and not self.args.text_only and drv.get("firstRasterMs") is None:
            doc["classes"].append("raster-timeout")
        # The overlay asks every entry for /<hash>/meta.json, which reader entries
        # do not have. That one systematic 404 (and the console line Chromium logs
        # for it) gets its own class so it does not mask other errors.
        failed = drv.get("failedRequests") or []
        # Raster requests the lifecycle cancels (src removed when a page leaves
        # the mount window after a jump) are aborted by design, not failures.
        aborted = [f for f in failed if "net::ERR_ABORTED" in f]
        o["aborted_requests"] = len(aborted) + (drv.get("abortedRequests") or 0)
        failed = [f for f in failed if f not in aborted]
        meta404 = [f for f in failed if re.fullmatch(r"404 /[0-9a-f]+/meta\.json", f)]
        other_failed = len(failed) - len(meta404)
        console = drv.get("consoleErrors") or []
        load404 = [c for c in console if "status of 404" in c]
        other_console = len(console) - min(len(load404), len(meta404))
        if meta404:
            doc["classes"].append("meta-json-404")
        if other_console > 0 or o["page_errors"]:
            doc["classes"].append("console-error")
        if other_failed:
            doc["classes"].append("failed-request")
        try:
            if drv.get("zoomVar") and abs(float(drv["zoomVar"]) - zoom) > 1e-3:
                doc["classes"].append("bench-error")
                doc["notes"].append(f"zoom not applied: {drv['zoomVar']} != {zoom:.4f}")
        except ValueError:
            pass

        # Visual comparison of the captured pages.
        dpages = {p["page"]: p for p in drv.get("pages", [])}
        jobs = []
        for p in pages:
            dp = dpages.get(p)
            if dp and dp.get("shot"):
                job = {"page": p, "shot": dp["shot"], "scale": zoom * DPR}
                if self.args.keep_artifacts:
                    job["artifacts"] = str(pathlib.Path(self.args.keep_artifacts) / sha[:16])
                jobs.append(job)
        visual = {}
        if jobs and not info.get("open_error"):
            cmp = self.worker("compare", pdf, {"jobs": jobs, "dark": INK_DARK, "radius": INK_RADIUS}, wdir, T_COMPARE)
            if cmp.get("worker_error"):
                doc["classes"].append("bench-error")
                doc["notes"].append("compare: " + cmp["worker_error"][:200])
            visual = {v["page"]: v for v in cmp.get("pages", [])}

        old_set = set(old_samples)
        out_pages = []
        ious_all, iousx_all, find_found, find_total = [], [], 0, 0
        for p in pages:
            dp = dpages.get(p, {})
            tp = text.get(p, {})
            pg = {"page": p, "in_old_sample": p in old_set}
            cls = []
            if not dp:
                pg["skipped"] = "not driven"
                out_pages.append(pg)
                continue
            if dp.get("missing"):
                cls.append("page-missing")
            if dp.get("error"):
                cls.append("bench-error")
                pg["error"] = dp["error"][:200]
            pg.update({"order_inversions": dp.get("orderInversions"), "order_pairs": dp.get("orderPairs"),
                       "raster_state": dp.get("rasterState"), "jump_ms": dp.get("jumpMs"),
                       "jump_landed": dp.get("jumpLanded"), "scroll_ms": dp.get("scrollMs"), "decode_wait_ms": dp.get("decodeWaitMs"),
                       "text_wait": dp.get("textWait"), "text_wait_ms": dp.get("textWaitMs"), "raster_px": dp.get("naturalWidth"),
                       "device_px": dp.get("deviceWidth")})
            if dp.get("paletteMissing"):
                cls.append("palette-missing")
            if dp.get("jumpLanded") is False:
                cls.append("jump-failed")
            if dp.get("rasterState") == "timeout":
                cls.append("raster-timeout")
            elif dp.get("rasterState") == "error":
                cls.append("raster-error")
            if dp.get("naturalWidth") and dp.get("deviceWidth") \
                    and dp["naturalWidth"] < dp["deviceWidth"] - RASTER_UNDERRES_PX:
                cls.append("raster-underres")
            if dp.get("imgBox") is False:
                cls.append("raster-no-box")
            if dp.get("clipped"):
                pg["visual_skipped"] = "page larger than viewport"
            v = visual.get(p)
            if v and not v.get("error"):
                pg["visual"] = {k: v[k] for k in ("extra", "missing", "block_diff", "missing_faint",
                                                  "ink_html", "ink_ref", "size_delta")}
                score = max(v["extra"], v["missing"])
                blur = (v["missing"] > VISUAL["missing"] and v.get("missing_faint", 0) >= BLUR_FAINT
                        and v["extra"] <= VISUAL["extra"])
                if blur:
                    cls.append("raster-blur")
                elif score > VISUAL_HIGH or v["block_diff"] > VISUAL["block_diff"]:
                    cls.append("visual-diff-high")
                elif score > max(VISUAL["extra"], VISUAL["missing"]):
                    cls.append("font-substitution" if (row.get("fonts") or {}).get("nonembedded")
                               else "glyph-drift")
                if v["ink_ref"] >= 2000 and v["ink_html"] < 0.05 * v["ink_ref"]:
                    cls.append("blank-page")
                if max(abs(d) for d in v["size_delta"]) > SIZE_DELTA_PX:
                    cls.append("page-size-mismatch")
            elif v and v.get("error"):
                cls.append("bench-error")
                pg["visual_error"] = v["error"][:200]

            # Text.
            ptext = tp.get("text")
            dom = dp.get("domText")
            if ptext is None or tp.get("error"):
                pg["text_skipped"] = "pdfium text unavailable"
            elif not norm_text(ptext):
                pg["text_skipped"] = "no extractable text"
            elif dom is None:
                pg["text_skipped"] = "no text layer read"
            else:
                a, b = norm_text(dom), norm_text(ptext)
                pc = len(re.sub(r"\s", "", b))
                hc = len(re.sub(r"\s", "", a))
                t = {"pdfium_chars": pc, "dom_chars": hc, "copy_sim": rnd(similarity(a, b)),
                     "copy_sim_nows": rnd(similarity(re.sub(r"\s", "", a), re.sub(r"\s", "", b))),
                     "lines": dp.get("lineCount")}
                if dp.get("selText") is not None:
                    t["select_sim"] = rnd(similarity(norm_text(dp["selText"]), b))
                if pc >= 50 and hc < TEXT_LOSS_RATIO * pc:
                    cls.append("text-loss")
                if pc >= COPY_MIN_CHARS and t["copy_sim"] < COPY_SIM_MIN:
                    cls.append("copy-mismatch")
                words = tp.get("words") or []
                dwords = dp.get("words") or []
                found = 0
                ious, ious_x, find_ious, missing_dom = [], [], [], 0
                for w, dw in zip(words, dwords):
                    if dw.get("found"):
                        found += 1
                    if not w["boxes"]:
                        continue
                    if not dw.get("inDom"):
                        missing_dom += 1
                        continue
                    ious.append(iou(dw.get("rects") or [], w["boxes"]))
                    ious_x.append(iou_x(dw.get("rects") or [], w["boxes"]))
                    if dw.get("findRects"):
                        find_ious.append(iou(dw["findRects"], w["boxes"]))
                t["words"] = len(words)
                t["offpage_candidates"] = tp.get("offpage_candidates", 0)
                t["find_found"] = found
                t["iou_words"] = len(ious)
                t["iou_missing_in_dom"] = missing_dom
                if ious:
                    t["iou_median"] = rnd(statistics.median(ious))
                    t["iou_min"] = rnd(min(ious))
                    t["iou_x_median"] = rnd(statistics.median(ious_x))
                if find_ious:
                    t["find_iou_median"] = rnd(statistics.median(find_ious))
                if words:
                    if found < len(words):
                        cls.append("find-miss")
                    find_found += found
                    find_total += len(words)
                else:
                    pg["words_skipped"] = "no word of >=5 letters occurs once on the page"
                ious_all.extend(ious)
                iousx_all.extend(ious_x)
                pg["text"] = t
            pg["classes"] = sorted(set(cls))
            doc["classes"].extend(cls)
            out_pages.append(pg)
        doc["pages"] = out_pages

        # Document aggregates.
        vis = [pg["visual"] for pg in out_pages if pg.get("visual")]
        txt = [pg["text"] for pg in out_pages if pg.get("text")]
        agg = {}
        if vis:
            agg["visual_worst"] = rnd(max(max(v["extra"], v["missing"]) for v in vis), 5)
            agg["block_diff_worst"] = rnd(max(v["block_diff"] for v in vis), 5)
            old_vis = [pg["visual"] for pg in out_pages if pg.get("visual") and pg["in_old_sample"]]
            if old_vis:
                agg["visual_worst_old_pages"] = rnd(max(max(v["extra"], v["missing"]) for v in old_vis), 5)
        scored = [t for t in txt if t["pdfium_chars"] >= COPY_MIN_CHARS]
        if scored:
            agg["copy_sim_mean"] = rnd(statistics.mean(t["copy_sim"] for t in scored))
            agg["copy_sim_min"] = rnd(min(t["copy_sim"] for t in scored))
            agg["copy_sim_nows_mean"] = rnd(statistics.mean(t["copy_sim_nows"] for t in scored))
        if find_total:
            agg["find_recall"] = rnd(find_found / find_total)
            agg["find_words"] = find_total
        if ious_all:
            agg["iou_median"] = rnd(statistics.median(ious_all))
            agg["iou_p10"] = rnd(pct(ious_all, 10))
            agg["iou_words"] = len(ious_all)
            agg["iou_x_median"] = rnd(statistics.median(iousx_all))
            if agg["iou_median"] < IOU_MEDIAN_MIN:
                doc["classes"].append("highlight-misaligned")
        jumps = [pg["jump_ms"] for pg in out_pages if pg.get("jump_ms") is not None]
        if jumps:
            agg["jump_ms_median"] = statistics.median(jumps)
        if not txt and pages:
            doc["notes"].append("no page with extractable text: text metrics skipped")
        doc["metrics"] = agg

    def old_probe(self, sha):
        path = self.corpus / "probe" / f"{sha}.json"
        try:
            return json.loads(path.read_text())
        except (OSError, json.JSONDecodeError):
            return None


def git(*args):
    try:
        return subprocess.run(["git", *args], cwd=REPO, capture_output=True, text=True, timeout=20).stdout.rstrip()
    except Exception:
        return None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True)
    ap.add_argument("--corpus")
    ap.add_argument("--tier", action="append", help="only rows of this tier (t1 includes t0); repeatable")
    ap.add_argument("--sha", action="append", help="only rows whose sha256 starts with this")
    ap.add_argument("--limit", type=int)
    ap.add_argument("--text-only", action="store_true", help="score copy/find/highlights without raster screenshots")
    ap.add_argument("--base", default="http://127.0.0.1:7436")
    ap.add_argument("--jobs", type=int, default=3)
    ap.add_argument("--max-pages", type=int, default=5)
    ap.add_argument("--doc-timeout", type=int, default=300, help="seconds per document in the browser")
    ap.add_argument("--raster-wait", type=int, default=30, help="seconds to wait for one page raster")
    ap.add_argument("--keep-artifacts", help="keep screenshots and diff sheets here (private content!)")
    ap.add_argument("--include-existing", action="store_true",
                    help="also score documents already in the daemon cache, read-only via /r/<hash>/")
    args = ap.parse_args()
    args.base = args.base.rstrip("/")

    if args.keep_artifacts:
        keep = pathlib.Path(args.keep_artifacts).expanduser().resolve()
        if str(keep).startswith(str(REPO.resolve())):
            print("run: --keep-artifacts must be outside the repository", file=sys.stderr)
            return 2
        args.keep_artifacts = str(keep)
    out_path = pathlib.Path(args.out).expanduser().resolve()
    if str(out_path).startswith(str(REPO.resolve())):
        print("run: note: --out is inside the repository; it holds no document text, only numbers and sha256",
              file=sys.stderr)

    try:
        with urllib.request.urlopen(f"{args.base}/healthz", timeout=10) as resp:
            health = json.loads(resp.read())
    except Exception as exc:
        print(f"run: daemon at {args.base} not reachable: {exc}", file=sys.stderr)
        return 2
    corpus = shared.corpus_dir(args.corpus)
    if not shared.playwright_node_path():
        print("run: no cached Playwright found (see bench/corpus/probe/shared.py)", file=sys.stderr)
        return 2

    preexisting = {p.name for p in CACHE.iterdir() if p.is_dir()} if CACHE.is_dir() else set()
    rows = [json.loads(l) for l in (corpus / "manifest.jsonl").read_text().splitlines() if l.strip()]
    rows = [r for r in rows if (corpus / "files" / r["sha256"][:2] / f"{r['sha256']}.pdf").is_file()]
    present = len(rows)
    if args.tier:
        order = {"t0": 0, "t1": 1, "t2": 2}
        cap = max(order.get(t, 2) for t in args.tier)
        rows = [r for r in rows if r.get("tier") in order and order[r["tier"]] <= cap]
    if args.sha:
        rows = [r for r in rows if any(r["sha256"].startswith(s) for s in args.sha)]
    rows.sort(key=lambda r: r["sha256"])
    skipped_existing = [r for r in rows if r["sha256"][:16] in preexisting]
    if not args.include_existing:
        rows = [r for r in rows if r["sha256"][:16] not in preexisting]
    if args.limit is not None:
        rows = rows[:args.limit]

    SCRATCH.mkdir(parents=True, exist_ok=True)
    meta = {
        "bench": "reader", "bench_version": BENCH_VERSION,
        "git_commit": (git("rev-parse", "HEAD") or "").strip() or None,
        "git_dirty_paths": [l[3:] for l in (git("status", "--porcelain", "--", "daemon", "assets", "bench/reader")
                                            or "").splitlines()],
        "base": args.base, "daemon_cache_entries_at_start": health.get("entries"),
        "started_at": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "viewport_policy": f"fit-width {FIT_WIDTH_CSS} CSS px (page height <= {MAX_PAGE_CSS_HEIGHT}), DPR {DPR}; "
                           "viewport = page box + 100 px",
        "dpr": DPR, "max_pages": args.max_pages, "words_per_page": WORDS_PER_PAGE,
        "thresholds": {"visual": VISUAL, "visual_high": VISUAL_HIGH, "blur_faint": BLUR_FAINT,
                       "ink_dark": INK_DARK, "ink_radius": INK_RADIUS, "size_delta_px": SIZE_DELTA_PX,
                       "text_loss_ratio": TEXT_LOSS_RATIO, "copy_sim_min": COPY_SIM_MIN,
                       "copy_min_chars": COPY_MIN_CHARS, "iou_median_min": IOU_MEDIAN_MIN,
                       "raster_underres_px": RASTER_UNDERRES_PX},
        "selection": {"text_only": args.text_only, "tier": args.tier, "sha": args.sha, "limit": args.limit,
                      "include_existing": args.include_existing},
        "counts": {"locally_present": present, "selected": len(rows),
                   "skipped_existing_entries": 0 if args.include_existing else len(skipped_existing)},
    }
    bench = Bench(args, corpus, preexisting)
    docs: list[dict] = []

    def write():
        meta["counts"]["scored"] = len(docs)
        meta["counts"]["entries_created"] = len(bench.created)
        meta["counts"]["entries_deleted"] = sum(1 for s in bench.deleted.values() if s == "200")
        tmp = out_path.with_name(f".{out_path.name}.tmp")
        out_path.parent.mkdir(parents=True, exist_ok=True)
        tmp.write_text(json.dumps({"meta": meta, "docs": sorted(docs, key=lambda d: d["sha256"])}, indent=1))
        os.replace(tmp, out_path)

    print(f"run: {len(rows)} documents ({present} locally present; "
          f"{meta['counts']['skipped_existing_entries']} skipped as existing cache entries)", flush=True)
    t0 = time.monotonic()
    try:
        with cf.ThreadPoolExecutor(max_workers=max(1, min(args.jobs, 6))) as pool:
            futures = {pool.submit(bench.score, r): r for r in rows}
            for fut in cf.as_completed(futures):
                row = futures[fut]
                try:
                    d = fut.result()
                except Exception as exc:
                    d = {"sha256": row["sha256"], "classes": ["bench-error"], "notes": [str(exc)[:300]]}
                docs.append(d)
                mt = d.get("metrics") or {}
                o = d.get("open") or {}
                print(f"[{len(docs)}/{len(rows)}] {d['sha256'][:12]} "
                      f"{','.join(d['classes']) or 'ok'} | first raster {o.get('first_raster_ms')} ms"
                      f" | vis {mt.get('visual_worst')} copy {mt.get('copy_sim_mean')}"
                      f" find {mt.get('find_recall')} iou {mt.get('iou_median')} | {d.get('seconds')} s",
                      flush=True)
                write()
    finally:
        # Sweep: any entry created during the run that is still present.
        if CACHE.is_dir():
            for p in CACHE.iterdir():
                if p.is_dir() and p.name not in preexisting and p.name not in bench.deleted \
                        and any(p.name == d.get("hash") for d in docs):
                    bench.created.add(p.name)
                    bench.delete_entry(p.name)
        # A raster render still running for an aborted request can recreate
        # <hash>/reader/px/ after the DELETE; wait and remove such orphans.
        if any((CACHE / h).exists() for h in bench.created):
            time.sleep(10)
        for h in [h for h in bench.created if (CACHE / h).exists()]:
            bench.deleted.pop(h, None)
            bench.delete_entry(h)
        leftover = [h for h in bench.created if (CACHE / h).exists()]
        meta["cleanup"] = {"created": len(bench.created),
                           "deleted_ok": sum(1 for s in bench.deleted.values() if s == "200"),
                           "still_present": len(leftover)}
        meta["finished_at"] = dt.datetime.now().astimezone().isoformat(timespec="seconds")
        meta["seconds"] = round(time.monotonic() - t0, 1)
        write()
        print(f"run: {len(docs)} documents in {meta['seconds']:.0f} s; cache cleanup {meta['cleanup']}; "
              f"wrote {out_path}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())

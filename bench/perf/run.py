#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy>=2", "pillow>=11"]
# ///
"""Perf bench: time to view, interaction latency and memory, reader vs Chrome's native PDF viewer.

Each trial is one fresh full Chromium (Chromium for Testing, headed by default)
running the same journey on one document with one engine (drive.cjs). Latency
is read from screencast frames, identically for both engines; frame pacing
from a trace of the display compositor; memory from macOS `footprint` over
every browser process. Definitions: bench/perf/README.md.

Usage:
    uv run bench/perf/run.py --out /tmp/pdfv-perf/results/perf.json [--engine reader|native|both]
        [--docs SHA_PREFIX,...] [--repeat 5] [--base http://127.0.0.1:7481] [--headless]
    python3 bench/perf/compare.py /tmp/pdfv-perf/results/perf.json

The reader needs a daemon with PDF_VIEWER_ENGINE=reader on --base, with its
own scratch cache (see README). Trials run strictly one at a time.

Privacy: corpus documents may be private. The JSON holds numbers, sha256
prefixes, page counts and manifest labels only. Screencast frames are written
under /tmp/pdfv-perf/work/<trial>/ and deleted right after the trial is
scored, unless --keep-frames DIR (refused inside the repository).
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import os
import pathlib
import platform
import shutil
import statistics
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

import numpy as np
from PIL import Image

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parents[1]
DRIVE = HERE / "drive.cjs"
WORK = pathlib.Path("~/.cache/pdf_viewer-bench/perf-work").expanduser()   # outside the repository
sys.dont_write_bytecode = True
sys.path.insert(0, str(REPO / "bench" / "corpus" / "probe"))
import probe as oldprobe  # noqa: E402  (corpus location and Playwright lookup)

BENCH_VERSION = "2"

# Default document set: local corpus, stratified by page count, text- and figure-heavy.
DEFAULT_DOCS = [
    "3a22c08d7c0f",  # 3 p, mixed text and images
    "6bbca166322c",  # 18 p, 8 MB, image-heavy slides
    "fa9b7cc99c1e",  # 27 p, vector-figure heavy
    "6045f88e2eca",  # 127 p, text-heavy
    "7319a537e6c3",  # 342 p, text-heavy
    "3b592f92ab8c",  # 1677 p, the largest
]
# Also present locally and usable with --docs: 09b124f6a862 (125 p slides), 40d976c83c18 (714 p),
# 00bf2159e2ab (1137 p).

# Geometry. The headed window is placed on the Mac's built-in display (below the
# main display), so it never covers the owner's work: position and size are fixed.
# Headed, because frame pacing and paint latency need the real display's vsync
# (new-headless runs on a virtual 60 Hz begin-frame source).
# Native zoom 125 % is 5/3 CSS px per PDF point (native 100 % = 4/3 px/pt); the
# reader's zoom is CSS px per point, so 1.6667 is the same page size on screen.
# 125 % -> 150 % is the native viewer's next preset step.
WINDOW = {"width": 1300, "height": 820}
WINDOW_POSITION = {"x": 320, "y": 1100}
DPR = 2
NATIVE_ZOOM, NATIVE_ZOOM_STEP = 125, 150
READER_ZOOM = round(NATIVE_ZOOM / 75, 4)
READER_ZOOM_STEP = round(NATIVE_ZOOM_STEP / 75, 4)
# Content region compared in frames, as fractions of the viewport: clear of the
# native toolbar and thumbnail sidebar and of the reader's chrome.
REGION = {"x0": 0.3, "x1": 0.7, "y0": 0.1, "y1": 0.97}
WHEEL_DELTA, WHEEL_INTERVAL_MS = 100, 16
PAGE_GAP_CSS = 8

# Pixel comparison: a pixel differs when its luma differs by more than
# PIX_THRESHOLD; two frames match when fewer than MATCH_FRACTION of the
# region's pixels differ. Validated in README ("Signal validation").
PIX_THRESHOLD = 40
MATCH_FRACTION = 0.002
NONBLANK_FRACTION = 0.005
# Coarse comparison ("the page is there, at its final size and place, legible but
# perhaps not sharp"): luma averaged over COARSE x COARSE device-px blocks (8 px =
# 4 CSS px at DPR 2), a block differs by more than COARSE_THRESHOLD levels, and
# two frames match when fewer than COARSE_FRACTION of blocks differ. A raster
# scaled from another zoom, or a quarter-resolution preview, matches the sharp
# final frame; the previous page, a blank page or the old size does not.
COARSE = 8
COARSE_THRESHOLD = 24
COARSE_FRACTION = 0.01


def sh(cmd, timeout=30):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout).stdout.strip()
    except Exception:
        return ""


def machine_state() -> dict:
    load = os.getloadavg()
    vm = sh(["memory_pressure", "-Q"])
    return {
        "time": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "load": [round(x, 2) for x in load],
        "memory_free_pct": next((l.split(":")[-1].strip() for l in vm.splitlines() if "free percentage" in l), None),
    }


def find_chromium() -> str:
    if os.environ.get("PDFV_CHROMIUM"):
        return os.environ["PDFV_CHROMIUM"]
    cache = pathlib.Path.home() / "Library/Caches/ms-playwright"
    dirs = sorted((d for d in cache.glob("chromium-*") if d.name.split("-")[1].isdigit()),
                  key=lambda d: int(d.name.split("-")[1]), reverse=True)
    for d in dirs:
        exe = d / "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
        if exe.exists():
            return str(exe)
    raise SystemExit("run: no Chromium for Testing under ~/Library/Caches/ms-playwright; set PDFV_CHROMIUM")


def daemon_pid(port: int) -> int | None:
    out = sh(["lsof", "-t", f"-iTCP:{port}", "-sTCP:LISTEN"])
    return int(out.splitlines()[0]) if out else None


def http(method: str, url: str) -> str:
    try:
        with urllib.request.urlopen(urllib.request.Request(url, method=method), timeout=30) as r:
            return str(r.status)
    except urllib.error.HTTPError as e:
        return str(e.code)
    except Exception as e:
        return f"error {e}"


# ------------------------------------------------------------------ frames
class Frames:
    """Screencast frames of one trial, loaded lazily as luma crops of the content region."""

    def __init__(self, wdir: pathlib.Path, frames: list[dict], region: dict):
        self.dir = wdir / "frames"
        self.frames = sorted(frames, key=lambda f: f["t"])
        self.region = region
        self._cache: dict[str, np.ndarray] = {}

    def luma(self, name: str) -> np.ndarray:
        if name not in self._cache:
            im = Image.open(self.dir / name).convert("L")
            w, h = im.size
            r = self.region
            box = (int(w * r["x0"]), int(h * r["y0"]), int(w * r["x1"]), int(h * r["y1"]))
            self._cache[name] = np.asarray(im.crop(box), dtype=np.int16)
        return self._cache[name]

    def coarse(self, name: str) -> np.ndarray:
        key = "coarse:" + name
        if key not in self._cache:
            x = self.luma(name)
            h, w = (x.shape[0] // COARSE) * COARSE, (x.shape[1] // COARSE) * COARSE
            self._cache[key] = x[:h, :w].reshape(h // COARSE, COARSE, w // COARSE, COARSE).mean(axis=(1, 3))
        return self._cache[key]

    def coarse_diff(self, a: str, b: str) -> float:
        x, y = self.coarse(a), self.coarse(b)
        if x.shape != y.shape:
            return 1.0
        return float(np.mean(np.abs(x - y) > COARSE_THRESHOLD))

    def diff(self, a: str, b: str) -> float:
        x, y = self.luma(a), self.luma(b)
        if x.shape != y.shape:
            return 1.0
        return float(np.mean(np.abs(x - y) > PIX_THRESHOLD))

    def nonblank(self, a: str) -> bool:
        x = self.luma(a)
        return float(np.mean(np.abs(x - np.median(x)) > PIX_THRESHOLD)) > NONBLANK_FRACTION

    def between(self, t0: float, t1: float) -> list[dict]:
        return [f for f in self.frames if t0 <= f["t"] <= t1]

    def before(self, t0: float, session_start: float | None = None) -> dict | None:
        prior = [f for f in self.frames if f["t"] < t0 and (session_start is None or f["t"] >= session_start)]
        return prior[-1] if prior else None


def analyze_phase(fr: Frames, ph: dict, ref_time: float, *, is_open: bool) -> dict:
    """Pixel timings of one phase, in ms from ref_time (the input that matters)."""
    res: dict = {}
    t0, t1 = ph["tAction"], ph["tEnd"]
    window = fr.between(t0, t1)
    pre = None if is_open else fr.before(t0)
    res["frames"] = len(window)
    if not window:
        res["no_change"] = True
        return res
    final = window[-1]["file"]
    res["final_vs_shot"] = round(fr.diff(final, pathlib.Path(ph["finalShot"]).name), 5) if ph.get("finalShot") else None
    # Visually complete: the earliest frame from which every later frame matches the final one.
    k = len(window)
    while k > 0 and fr.diff(window[k - 1]["file"], final) < MATCH_FRACTION:
        k -= 1
    res["complete_ms"] = round(window[min(k, len(window) - 1)]["t"] - ref_time, 1)
    # Coarsely complete: from this frame on, every frame shows the final page at
    # its final size and place (legible, maybe blurred); a blank or old-size frame
    # after it would push it later, so it also catches flicker.
    k = len(window)
    while k > 0 and fr.coarse_diff(window[k - 1]["file"], final) < COARSE_FRACTION:
        k -= 1
    res["coarse_ms"] = round(window[min(k, len(window) - 1)]["t"] - ref_time, 1)
    # Frames on the way that were neither the old view nor near the final one at
    # coarse scale and were mostly blank: a blank page during a zoom or jump.
    res["blank_frames"] = sum(1 for f in window if not fr.nonblank(f["file"]))
    # First visible response.
    if is_open:
        first = next((f for f in window if fr.nonblank(f["file"])), None)
        res["first_content_ms"] = round(first["t"] - ref_time, 1) if first else None
    else:
        changed = pre is None or fr.diff(final, pre["file"]) >= MATCH_FRACTION
        res["changed"] = changed
        first = next((f for f in window if pre is None or fr.diff(f["file"], pre["file"]) >= MATCH_FRACTION), None)
        res["first_change_ms"] = round(first["t"] - ref_time, 1) if first else None
    # Number of distinct visual states on the way (how progressive the paint is).
    res["distinct_states"] = 1 + sum(1 for a, b in zip(window, window[1:]) if fr.diff(a["file"], b["file"]) >= MATCH_FRACTION)
    if ph.get("domCrispAt"):
        res["dom_crisp_ms"] = round(ph["domCrispAt"] - ref_time, 1)
    if ph.get("timedOut"):
        res["timed_out"] = True
    return res


def analyze_trace(path: pathlib.Path, ph: dict) -> dict | None:
    """Display-compositor frame pacing while wheel input was being sent."""
    if not path.exists():
        return None
    data = json.loads(path.read_text())
    events = data["traceEvents"] if isinstance(data, dict) else data
    mark = next((e for e in events if e.get("name") == "pdfv-perf-sync" and e.get("ph") in ("R", "I", "n", "b", "X")), None)
    if not mark:
        return {"error": "no sync mark"}
    offset = mark["ts"] / 1000 - ph["syncMark"]           # trace ms minus epoch ms
    t0, t1 = ph["tAction"] + offset, ph["tLastInput"] + offset
    swaps = sorted(e["ts"] / 1000 for e in events if e.get("name") == "Display::DrawAndSwap" and e.get("ph") == "X")
    # Display refresh period from the display-link callbacks (the built-in display is 120 Hz).
    # Several display-link threads interleave; take the busiest one's own period.
    by_thread: dict = {}
    for e in events:
        if e.get("name") == "CVDisplayLinkCallback":
            by_thread.setdefault((e.get("pid"), e.get("tid")), []).append(e["ts"] / 1000)
    vs = sorted(max(by_thread.values(), key=len)) if by_thread else []
    vsync_source = "CVDisplayLinkCallback"
    if len(vs) <= 10:
        vs = sorted(e["ts"] / 1000 for e in events if e.get("name") == "OnVSyncPresentation")
        vsync_source = "OnVSyncPresentation"
    vsync = float(statistics.median(np.diff(vs))) if len(vs) > 10 else None
    if not vsync:
        return {"error": "no vsync events"}
    win = [t for t in swaps if t0 <= t <= t1]
    if len(win) < 2:
        return {"swaps": len(win), "error": "too few swaps"}
    iv = np.diff(win)
    missed = int(sum(max(0, round(i / vsync) - 1) for i in iv))
    # Stalls, against the input period: wheel events arrive every input_ms, so an
    # engine that does not animate between events (the reader) can only update that
    # often, while one that does (native) updates every vsync. The comparable
    # question is how often a whole input period passed with no presented frame.
    period = ph.get("intervalMs") or 16
    bins = np.arange(t0, t1 - period, period)
    idx = np.searchsorted(np.array(win), bins)
    nxt = np.array(win + [float("inf")])[idx]
    stalled = int(np.sum(nxt >= bins + period))
    return {
        "duration_ms": round(t1 - t0, 1), "vsync_ms": round(vsync, 2), "vsync_source": vsync_source, "swaps": len(win),
        "fps": round(len(win) / ((t1 - t0) / 1000), 1),
        "interval_p50": round(float(np.percentile(iv, 50)), 1), "interval_p95": round(float(np.percentile(iv, 95)), 1),
        "interval_p99": round(float(np.percentile(iv, 99)), 1), "interval_max": round(float(iv.max()), 1),
        "input_period_ms": period, "stall_fraction": round(stalled / max(1, len(bins)), 4),
        "long_frames": int(np.sum(iv > 2 * period)),
        "missed_vsyncs": missed, "vsync_dropped_fraction": round(missed / (missed + len(win)), 4),
    }


def score_trial(wdir: pathlib.Path, raw: dict, spec: dict) -> dict:
    fr = Frames(wdir, raw.get("frames", []), REGION)
    phases = raw.get("phases", {})
    res: dict = {"engine": raw["engine"], "phases": {}, "errors": raw.get("errors", []), "notes": raw.get("notes", [])}
    if raw.get("fatal"):
        res["fatal"] = raw["fatal"]
    for name, ph in phases.items():
        if "tAction" not in ph or "tEnd" not in ph:
            res["phases"][name] = {"incomplete": True}
            continue
        is_open = name.startswith("open")
        ref = ph["tLastInput"] if name.startswith("scroll") or name == "zoom_burst" else ph["tAction"]
        # Discrete inputs are timed from the event as the page received it (drive.cjs, input clock).
        if ph.get("tInput"):
            ref = ph["tInput"]
        elif name in ("jump", "zoom", "zoom_burst"):
            res["notes"].append(f"{name}: no input timestamp from the page; timed from the driver's call")
        a = analyze_phase(fr, ph, ref, is_open=is_open)
        a["state"] = ph.get("state")
        if name == "scroll5":
            a.pop("first_change_ms", None)
            a["before"] = ph.get("before")
            a["input_ms"] = round(ph["tLastInput"] - ph["tAction"], 1)
            a["events"] = ph.get("events")
        if name == "scroll10":
            # No frames were captured during the traced scroll (see README).
            a = {"trace": analyze_trace(wdir / "scroll-trace.json", ph), "state": ph.get("state"),
                 "before": ph.get("before"), "input_ms": round(ph["tLastInput"] - ph["tAction"], 1),
                 "events": ph.get("events")}
        if name in ("jump", "zoom", "zoom_burst"):
            a["target"] = ph.get("target")
            a["before"] = ph.get("before")
        if ph.get("status") is not None:
            a["status"] = ph["status"]
        res["phases"][name] = a

    mem = raw.get("memory", {})
    if mem.get("baseline") and mem.get("after"):
        def by_kind(m):
            out: dict = {}
            for p in m["procs"]:
                out[p["kind"]] = out.get(p["kind"], 0) + (p["footprint"] or 0)
            return out
        b, a = by_kind(mem["baseline"]), by_kind(mem["after"])
        # The tracing service process exists only because the bench traced the scroll.
        bench_only = [k for k in set(a) | set(b) if "Tracing" in k]
        tb = mem["baseline"]["total"] - sum(b.get(k, 0) for k in bench_only)
        ta = mem["after"]["total"] - sum(a.get(k, 0) for k in bench_only)
        res["memory"] = {
            "browser_baseline": tb, "browser_after": ta, "browser_delta": ta - tb, "excluded_kinds": bench_only,
            "delta_by_kind": {k: a.get(k, 0) - b.get(k, 0) for k in sorted(set(a) | set(b))},
            "procs_after": len(mem["after"]["procs"]), "footprint_missing": mem["after"]["missing"],
        }
        if mem.get("afterZoom"):
            z = by_kind(mem["afterZoom"])
            res["memory"]["browser_after_zoom_delta"] = (mem["afterZoom"]["total"] - sum(z.get(k, 0) for k in bench_only)) - tb
        if mem.get("daemonAfter"):
            res["memory"]["daemon_after"] = mem["daemonAfter"]["total"]
            res["memory"]["daemon_delta"] = mem["daemonAfter"]["total"] - mem["daemonBefore"]["total"]
            res["memory"]["daemon_procs"] = len(mem["daemonAfter"]["procs"])
    if raw.get("readerDom"):
        res["reader_dom"] = raw["readerDom"]
    if raw["engine"] == "reader":
        rs = raw.get("rasters", [])
        def phase_of(t):
            for name in ("zoom_burst", "zoom", "scroll5", "jump", "scroll10", "open_warm", "open_cold"):
                if name in phases and "tAction" in phases[name] and t >= phases[name]["tAction"] - 400:
                    return name
            return "open_cold"
        per: dict = {}
        for r in rs:
            p = per.setdefault(phase_of(r["t"]), {"requests": 0, "bytes": 0, "ms": []})
            p["requests"] += 1
            p["bytes"] += r["bytes"] or 0
            if r["ms"] is not None:
                p["ms"].append(r["ms"])
        for p in per.values():
            p["ms_median"] = round(statistics.median(p["ms"]), 1) if p["ms"] else None
            p["ms_max"] = max(p["ms"]) if p["ms"] else None
            del p["ms"]
        journey = [r for r in rs if not phase_of(r["t"]).startswith("zoom")]
        # Burst: widths requested after the first step of the burst. Only the final
        # zoom's width (one per visible page) is needed; the rest is wasted work.
        if "zoom_burst" in phases and phases["zoom_burst"].get("state"):
            final_widths = {r["width"] for r in rs if phase_of(r["t"]) == "zoom_burst"
                            and r["t"] >= phases["zoom_burst"]["tLastInput"] - 50}
            burst = [r for r in rs if phase_of(r["t"]) == "zoom_burst"]
            per.setdefault("zoom_burst", {})["widths"] = len({r["width"] for r in burst})
            per["zoom_burst"]["stale_requests"] = sum(1 for r in burst if r["t"] < phases["zoom_burst"]["tLastInput"] - 50
                                                     and r["width"] not in final_widths)
        res["rasters"] = {
            "requests": len(rs), "bytes": sum(r["bytes"] or 0 for r in rs), "aborted": raw.get("abortedRasters", 0),
            "journey_requests": len(journey), "journey_bytes": sum(r["bytes"] or 0 for r in journey),
            "widths": sorted({r["width"] for r in rs}), "by_phase": per,
        }
    # Main-document requests: for the reader, /read (register, 307) and the shell
    # (built from PDFium on a cold open, a file read when warm).
    docs = raw.get("documents") or []
    for name in ("open_cold", "open_warm"):
        if name in phases and "tAction" in phases[name]:
            t0, t1 = phases[name]["tAction"], phases[name].get("tEnd", float("inf"))
            res["phases"][name]["documents"] = [{k: v for k, v in d.items() if k != "t"} for d in docs
                                                if t0 - 50 <= d["t"] <= t1]
    res["viewport"] = raw.get("viewport")
    res["browser_version"] = raw.get("browserVersion")
    res["mode"] = raw.get("mode")
    return res


# ------------------------------------------------------------------ summary
def summarize(values: list[float]) -> dict | None:
    v = [x for x in values if x is not None and not (isinstance(x, float) and math.isnan(x))]
    if not v:
        return None
    med = statistics.median(v)
    return {"median": round(med, 2), "mad": round(statistics.median(abs(x - med) for x in v), 2),
            "min": round(min(v), 2), "max": round(max(v), 2), "n": len(v)}


METRICS = {
    # name: (path in a scored trial, unit, lower_is_better)
    "open_cold_ms": (("phases", "open_cold", "complete_ms"), "ms"),
    "open_warm_ms": (("phases", "open_warm", "complete_ms"), "ms"),
    "open_cold_first_content_ms": (("phases", "open_cold", "first_content_ms"), "ms"),
    "scroll_settle_ms": (("phases", "scroll5", "complete_ms"), "ms"),
    "scroll_fps": (("phases", "scroll10", "trace", "fps"), "fps"),
    "scroll_stall_fraction": (("phases", "scroll10", "trace", "stall_fraction"), "frac"),
    "scroll_interval_p95_ms": (("phases", "scroll10", "trace", "interval_p95"), "ms"),
    "jump_legible_ms": (("phases", "jump", "coarse_ms"), "ms"),
    "jump_ms": (("phases", "jump", "complete_ms"), "ms"),
    "zoom_applied_ms": (("phases", "zoom", "coarse_ms"), "ms"),
    "zoom_ms": (("phases", "zoom", "complete_ms"), "ms"),
    "zoom_burst_applied_ms": (("phases", "zoom_burst", "coarse_ms"), "ms"),
    "zoom_burst_ms": (("phases", "zoom_burst", "complete_ms"), "ms"),
    "memory_browser_mb": (("memory", "browser_delta"), "MB"),
    "memory_after_zoom_mb": (("memory", "browser_after_zoom_delta"), "MB"),
    "memory_daemon_mb": (("memory", "daemon_after"), "MB"),
}


def dig(d, path):
    for k in path:
        if not isinstance(d, dict):
            return None
        d = d.get(k)
    return d


def aggregate(trials: list[dict]) -> dict:
    out = {}
    for name, (path, unit) in METRICS.items():
        vals = [dig(t, path) for t in trials if not t.get("fatal")]
        if unit == "MB":
            vals = [v / 1e6 if v is not None else None for v in vals]
        out[name] = summarize(vals)
    return out


# ------------------------------------------------------------------ main
def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True)
    ap.add_argument("--engine", choices=["reader", "native", "both"], default="both")
    ap.add_argument("--docs", help="comma-separated sha256 prefixes (default: the 8-document set in run.py)")
    ap.add_argument("--repeat", type=int, default=5)
    ap.add_argument("--base", default="http://127.0.0.1:7442")
    ap.add_argument("--native-port", type=int, default=0, help="port of the native viewer's PDF server (0: any free port)")
    ap.add_argument("--work", default=str(WORK), help="scratch directory for frames (private content; outside the repo)")
    ap.add_argument("--corpus")
    ap.add_argument("--headless", action="store_true", help="new-headless full Chromium instead of a headed window")
    ap.add_argument("--keep-frames", help="keep screencast frames here (private content!)")
    ap.add_argument("--max-load", type=float, default=12.0,
                    help="wait (up to 2 min) before a trial while the 1-minute load average is above this")
    args = ap.parse_args()
    args.base = args.base.rstrip("/")
    for d in (args.keep_frames, args.work):
        if d and str(pathlib.Path(d).expanduser().resolve()).startswith(str(REPO.resolve())):
            print("run: --keep-frames and --work must be outside the repository", file=sys.stderr)
            return 2
    work = pathlib.Path(args.work).expanduser()
    port = int(args.base.rsplit(":", 1)[1])
    if port == 7435 or args.native_port == 7435:
        print("run: 7435 is the owner's daemon; run the bench against a scratch daemon", file=sys.stderr)
        return 2
    engines = ["reader", "native"] if args.engine == "both" else [args.engine]
    if "reader" in engines:
        try:
            with urllib.request.urlopen(f"{args.base}/healthz", timeout=10) as r:
                health = json.loads(r.read())
        except Exception as exc:
            print(f"run: daemon at {args.base} not reachable: {exc}", file=sys.stderr)
            return 2
        owner = pathlib.Path.home() / ".cache" / "pdf_viewer"
        cache = pathlib.Path(str(health.get("cache_dir") or owner))
        if health.get("engine") != "reader" or cache == owner or owner in cache.parents:
            print(f"run: the daemon must run the reader on a scratch cache, got {health}", file=sys.stderr)
            return 2
    node_path = oldprobe.playwright_node_path()
    if not node_path:
        print("run: no cached Playwright found", file=sys.stderr)
        return 2
    chromium = find_chromium()
    corpus = oldprobe.corpus_dir(args.corpus)
    rows = {}
    for line in (corpus / "manifest.jsonl").read_text().splitlines():
        if line.strip():
            r = json.loads(line)
            rows[r["sha256"]] = r
    wanted = args.docs.split(",") if args.docs else DEFAULT_DOCS
    docs = []
    for prefix in wanted:
        match = [r for s, r in rows.items() if s.startswith(prefix.strip())]
        if len(match) != 1:
            print(f"run: {prefix}: {len(match)} manifest rows", file=sys.stderr)
            return 2
        r = match[0]
        pdf = corpus / "files" / r["sha256"][:2] / f"{r['sha256']}.pdf"
        if not pdf.is_file():
            print(f"run: {prefix}: PDF not present locally", file=sys.stderr)
            return 2
        docs.append((r, pdf))

    out_path = pathlib.Path(args.out).expanduser().resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    work.mkdir(parents=True, exist_ok=True)
    meta = {
        "bench": "perf", "bench_version": BENCH_VERSION,
        "git_commit": sh(["git", "-C", str(REPO), "rev-parse", "HEAD"]) or None,
        "git_dirty_paths": [l[3:] for l in sh(["git", "-C", str(REPO), "status", "--porcelain", "--", "daemon", "assets",
                                                "bench/perf"]).splitlines()],
        "machine": {"model": sh(["sysctl", "-n", "hw.model"]), "cpu": sh(["sysctl", "-n", "machdep.cpu.brand_string"]),
                    "memory_gb": round(int(sh(["sysctl", "-n", "hw.memsize"]) or 0) / 2**30),
                    "macos": platform.mac_ver()[0]},
        "chromium": chromium.split("/ms-playwright/")[-1].split("/")[0],
        "mode": "new-headless" if args.headless else "headed",
        "window": WINDOW, "window_position": WINDOW_POSITION, "dpr": DPR, "native_zoom": [NATIVE_ZOOM, NATIVE_ZOOM_STEP],
        "reader_zoom": [READER_ZOOM, READER_ZOOM_STEP], "region": REGION,
        "wheel": {"delta": WHEEL_DELTA, "interval_ms": WHEEL_INTERVAL_MS},
        "pixel_match": {"threshold": PIX_THRESHOLD, "fraction": MATCH_FRACTION,
                        "coarse": {"block": COARSE, "threshold": COARSE_THRESHOLD, "fraction": COARSE_FRACTION}},
        "repeat": args.repeat, "engines": engines,
        "started": machine_state(),
    }
    results: dict = {"meta": meta, "docs": []}

    def write():
        tmp = out_path.with_name(f".{out_path.name}.tmp")
        tmp.write_text(json.dumps(results, indent=1))
        os.replace(tmp, out_path)

    dpid = daemon_pid(port) if "reader" in engines else None
    total = len(docs) * len(engines) * args.repeat
    n = 0
    t_start = time.monotonic()
    for row, pdf in docs:
        sha = row["sha256"]
        hash16 = sha[:16]
        sizes = row.get("page_sizes") or [{"w": 612, "h": 792, "count": 1}]
        common = max(sizes, key=lambda s: s["count"])
        page_css = common["h"] * READER_ZOOM + PAGE_GAP_CSS
        pages = row["pages"]
        doc = {"sha": sha[:12], "pages": pages, "labels": row.get("labels", []), "bytes": row.get("bytes"),
               "page_pt": [common["w"], common["h"]], "trials": {e: [] for e in engines}}
        results["docs"].append(doc)
        for rep in range(args.repeat):
            for engine in engines if rep % 2 == 0 else list(reversed(engines)):
                n += 1
                waited = 0
                while os.getloadavg()[0] > args.max_load and waited < 120:
                    time.sleep(10)
                    waited += 10
                state = machine_state()
                state["waited_s"] = waited
                wdir = work / f"{sha[:12]}-{engine}-{rep}"
                shutil.rmtree(wdir, ignore_errors=True)
                wdir.mkdir(parents=True)
                deleted = http("DELETE", f"{args.base}/mapping/{hash16}") if engine == "reader" else None
                spec = {
                    "engine": engine, "pdfPath": str(pdf), "chromium": chromium, "headless": args.headless,
                    "readUrl": f"{args.base}/read?path={urllib.parse.quote(str(pdf))}",
                    "stateResetUrl": f"{args.base}/entry/{hash16}/state",
                    "nativePort": args.native_port, "nativeZoom": NATIVE_ZOOM,
                    "readerZoom": READER_ZOOM, "readerZoomStep": READER_ZOOM_STEP,
                    "window": WINDOW, "windowPosition": WINDOW_POSITION, "dpr": DPR, "region": REGION, "jpegQuality": 80,
                    "outDir": str(wdir), "daemonPid": dpid if engine == "reader" else None,
                    "zoomBurst": 4, "zoomBurstIntervalMs": 60,
                    "quietMs": 1500, "openQuietMs": 2500, "coldMaxMs": 120000, "phaseMaxMs": 30000,
                    "baselineIdleMs": 3000, "idleMs": 3000,
                    "pointer": {"x": WINDOW["width"] // 2, "y": 400},
                    "wheelDelta": WHEEL_DELTA, "wheelIntervalMs": WHEEL_INTERVAL_MS,
                    "wheelEvents10": math.ceil(min(10, max(1, pages - 1)) * page_css / WHEEL_DELTA),
                    "wheelEvents5": math.ceil(min(5, max(1, pages - 1)) * page_css / WHEEL_DELTA),
                    "jumpPage": max(1, math.ceil(pages / 2)) if pages > 3 else pages,
                    "traceCategories": ["viz", "gpu", "blink.user_timing"],
                }
                (wdir / "spec.json").write_text(json.dumps(spec))
                env = dict(os.environ, NODE_PATH=node_path)
                t0 = time.monotonic()
                try:
                    proc = subprocess.run(["node", str(DRIVE), str(wdir / "spec.json")], env=env, timeout=600,
                                          capture_output=True, text=True)
                    err = proc.stderr[-500:] if proc.returncode else None
                except subprocess.TimeoutExpired:
                    err = "driver timeout"
                raw_path = wdir / "trial.json"
                if raw_path.exists():
                    raw = json.loads(raw_path.read_text())
                    trial = score_trial(wdir, raw, spec)
                else:
                    trial = {"engine": engine, "fatal": err or "no trial.json"}
                trial["rep"] = rep
                trial["machine"] = state
                trial["machine_end"] = machine_state()
                trial["seconds"] = round(time.monotonic() - t0, 1)
                if deleted is not None:
                    trial["cold_entry_delete"] = deleted
                doc["trials"][engine].append(trial)
                if args.keep_frames:
                    dest = pathlib.Path(args.keep_frames).expanduser() / wdir.name
                    shutil.rmtree(dest, ignore_errors=True)
                    shutil.copytree(wdir, dest)
                shutil.rmtree(wdir, ignore_errors=True)
                ph = trial.get("phases", {})
                print(f"[{n}/{total}] {sha[:12]} {pages}p {engine} r{rep}: "
                      f"cold {dig(ph, ('open_cold', 'complete_ms'))} warm {dig(ph, ('open_warm', 'complete_ms'))} "
                      f"stall {dig(ph, ('scroll10', 'trace', 'stall_fraction'))} settle {dig(ph, ('scroll5', 'complete_ms'))} "
                      f"jump {dig(ph, ('jump', 'coarse_ms'))}/{dig(ph, ('jump', 'complete_ms'))} "
                      f"zoom {dig(ph, ('zoom', 'coarse_ms'))}/{dig(ph, ('zoom', 'complete_ms'))} "
                      f"burst {dig(ph, ('zoom_burst', 'coarse_ms'))}/{dig(ph, ('zoom_burst', 'complete_ms'))} "
                      f"mem {round((dig(trial, ('memory', 'browser_delta')) or 0) / 1e6)}/"
                      f"{round((dig(trial, ('memory', 'browser_after_zoom_delta')) or 0) / 1e6)} MB "
                      f"load {state['load'][0]}"
                      f"{' FATAL ' + trial['fatal'][:200] if trial.get('fatal') else ''} | {trial['seconds']} s",
                      flush=True)
                write()
        if "reader" in engines:
            doc["cleanup"] = http("DELETE", f"{args.base}/mapping/{hash16}")
        doc["summary"] = {e: aggregate(doc["trials"][e]) for e in engines}
        write()
    meta["finished"] = machine_state()
    meta["seconds"] = round(time.monotonic() - t_start, 1)
    write()
    return 0


if __name__ == "__main__":
    sys.exit(main())

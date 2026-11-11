#!/usr/bin/env python3
"""Reader vs native table from a bench/perf/run.py result (stdlib only).

Usage: python3 bench/perf/compare.py RESULT.json [--md OUT.md]

Prints, per document and metric, the reader's and the native viewer's median
over trials with the median absolute deviation (MAD), the ratio reader/native,
and a verdict. A difference counts only beyond the noise band
    band = 2 * max(MAD_reader, MAD_native) + floor
with a floor per unit (one 60 Hz frame or 5 % for times, 10 MB or 5 % for
memory, 2 fps, 0.01 for fractions). Inside the band the verdict is "noise".
Writes the same tables as markdown beside the JSON (or to --md).
"""
from __future__ import annotations

import argparse
import json
import math
import pathlib
import statistics
import sys

# Scroll metrics need room for ~15 pages of scrolling.
MIN_SCROLL_PAGES = 16

# metric: (label, unit, higher_is_better)
METRICS = [
    ("open_cold_ms", "open, cold (ms)", "ms", False),
    ("open_warm_ms", "open, warm (ms)", "ms", False),
    ("scroll_settle_ms", "held scroll: last input to crisp (ms)", "ms", False),
    ("scroll_stall_fraction", "held scroll: input periods with no new frame", "frac", False),
    ("scroll_long_frames", "held scroll: frames longer than 2 input periods", "n", False),
    ("scroll_fps", "held scroll: frames presented per s (information)", "fps", True),
    ("jump_legible_ms", "far jump to legible (ms)", "ms", False),
    ("jump_ms", "far jump to sharp (ms)", "ms", False),
    ("zoom_applied_ms", "zoom step: visibly at the new size (ms)", "ms", False),
    ("zoom_ms", "zoom step to sharp (ms)", "ms", False),
    ("zoom_burst_applied_ms", "zoom burst (4 steps): last input to new size (ms)", "ms", False),
    ("zoom_burst_ms", "zoom burst (4 steps): last input to sharp (ms)", "ms", False),
    ("memory_browser_mb", "memory: browser processes after the journey (MB)", "MB", False),
    ("memory_after_zoom_mb", "memory: browser processes after the zooms (MB)", "MB", False),
    ("memory_total_mb", "memory: browser + daemon growth (MB)", "MB", False),
]

# Where each metric lives in a scored trial, and the phase whose timeout or
# missing change invalidates it.
PATHS = {
    "open_cold_ms": (("phases", "open_cold", "complete_ms"), "open_cold"),
    "open_warm_ms": (("phases", "open_warm", "complete_ms"), "open_warm"),
    "scroll_settle_ms": (("phases", "scroll5", "complete_ms"), "scroll5"),
    "scroll_fps": (("phases", "scroll10", "trace", "fps"), None),
    "scroll_stall_fraction": (("phases", "scroll10", "trace", "stall_fraction"), None),
    "scroll_long_frames": (("phases", "scroll10", "trace", "long_frames"), None),
    "jump_legible_ms": (("phases", "jump", "coarse_ms"), "jump"),
    "jump_ms": (("phases", "jump", "complete_ms"), "jump"),
    "zoom_applied_ms": (("phases", "zoom", "coarse_ms"), "zoom"),
    "zoom_ms": (("phases", "zoom", "complete_ms"), "zoom"),
    "zoom_burst_applied_ms": (("phases", "zoom_burst", "coarse_ms"), "zoom_burst"),
    "zoom_burst_ms": (("phases", "zoom_burst", "complete_ms"), "zoom_burst"),
}


def floor(unit: str, native: float) -> float:
    if unit == "ms":
        return max(16.7, 0.05 * abs(native))
    if unit == "MB":
        return max(10.0, 0.05 * abs(native))
    if unit == "fps":
        return 2.0
    if unit == "n":
        return 2.0
    return 0.01


def dig(d, *path):
    for k in path:
        d = d.get(k) if isinstance(d, dict) else None
    return d


def values(trials: list[dict], metric: str) -> list[float]:
    out = []
    for t in trials:
        if t.get("fatal"):
            continue
        mem = t.get("memory", {}) or {}
        ph = t.get("phases", {})
        if metric in PATHS:
            path, phase = PATHS[metric]
            v = dig(t, *path)
            # A phase that hit its timeout or never changed the screen has no valid time.
            if phase and (dig(ph, phase, "timed_out") or dig(ph, phase, "no_change")):
                v = None
        elif metric == "memory_browser_mb":
            v = mem.get("browser_delta") / 1e6 if mem.get("browser_delta") is not None else None
        elif metric == "memory_after_zoom_mb":
            v = mem.get("browser_after_zoom_delta") / 1e6 if mem.get("browser_after_zoom_delta") is not None else None
        else:  # memory_total_mb
            v = (((mem.get("browser_delta") or 0) + max(0, mem.get("daemon_delta") or 0)) / 1e6
                 if mem.get("browser_delta") is not None else None)
        if metric.startswith("scroll") and (t.get("pages") or 0) < MIN_SCROLL_PAGES:
            v = None
        if v is not None:
            out.append(float(v))
    return out


def stats(v: list[float]):
    if not v:
        return None
    m = statistics.median(v)
    return {"median": m, "mad": statistics.median(abs(x - m) for x in v), "min": min(v), "max": max(v), "n": len(v)}


def fmt(x: float | None, unit: str) -> str:
    if x is None:
        return "–"
    if unit == "frac":
        return f"{x:.3f}"
    if unit == "fps":
        return f"{x:.1f}"
    return f"{x:.0f}"


def compare(result: dict) -> tuple[list[dict], dict]:
    rows = []
    for doc in result["docs"]:
        tr = doc.get("trials", {})
        for ts in tr.values():
            for t in ts:
                t["pages"] = doc["pages"]
        for key, label, unit, higher in METRICS:
            r = stats(values(tr.get("reader", []), key))
            n = stats(values(tr.get("native", []), key))
            if key == "memory_total_mb" and n is not None:
                n = stats(values(tr.get("native", []), "memory_browser_mb"))
            row = {"doc": doc["sha"], "pages": doc["pages"], "metric": key, "label": label, "unit": unit,
                   "reader": r, "native": n}
            if r and n:
                band = 2 * max(r["mad"], n["mad"]) + floor(unit, n["median"])
                diff = r["median"] - n["median"]
                row["band"] = band
                row["ratio"] = r["median"] / n["median"] if n["median"] else None
                if abs(diff) <= band:
                    row["verdict"] = "noise"
                else:
                    row["verdict"] = "reader better" if (diff > 0) == higher else "reader worse"
            rows.append(row)
    summary = {}
    for key, label, unit, higher in METRICS:
        rs = [r for r in rows if r["metric"] == key and r.get("ratio")]
        if not rs:
            continue
        ratios = [r["ratio"] for r in rs if r["ratio"] > 0]
        summary[key] = {
            "label": label, "docs": len(rs),
            "geomean_ratio": math.exp(sum(math.log(x) for x in ratios) / len(ratios)) if ratios else None,
            "better": sum(r["verdict"] == "reader better" for r in rs),
            "worse": sum(r["verdict"] == "reader worse" for r in rs),
            "noise": sum(r["verdict"] == "noise" for r in rs),
        }
    return rows, summary


def cell(s, unit):
    if not s:
        return "–"
    return f"{fmt(s['median'], unit)} ±{fmt(s['mad'], unit)}"


def render(result: dict, rows: list[dict], summary: dict) -> str:
    meta = result["meta"]
    lines = [f"# Perf bench: reader vs native ({meta.get('started', {}).get('time', '?')})", ""]
    lines.append(f"Commit `{(meta.get('git_commit') or '?')[:10]}`, {meta.get('machine', {}).get('model')} "
                 f"{meta.get('machine', {}).get('cpu')}, macOS {meta.get('machine', {}).get('macos')}, "
                 f"{meta.get('chromium')} {meta.get('mode')}, window {meta['window']['width']}×{meta['window']['height']} "
                 f"DPR {meta['dpr']}, native {meta['native_zoom'][0]} % ≙ reader zoom {meta['reader_zoom'][0]}, "
                 f"{meta['repeat']} trials per engine and document. Load at start {meta.get('started', {}).get('load')}, "
                 f"at end {meta.get('finished', {}).get('load')}.")
    lines.append("")
    lines.append("Cells are median ±MAD over trials. Ratio = reader / native. A verdict other than *noise* "
                 "needs |reader − native| > 2·max(MAD) + floor (band). See bench/perf/README.md for definitions.")
    lines.append("")
    lines.append("## Summary over documents")
    lines.append("")
    lines.append("| metric | docs | geometric-mean ratio | reader better | worse | noise |")
    lines.append("|---|---:|---:|---:|---:|---:|")
    for key, s in summary.items():
        g = s["geomean_ratio"]
        lines.append(f"| {s['label']} | {s['docs']} | {g:.2f} | {s['better']} | {s['worse']} | {s['noise']} |"
                     if g else f"| {s['label']} | {s['docs']} | – | {s['better']} | {s['worse']} | {s['noise']} |")
    lines.append("")
    for key, label, unit, _ in METRICS:
        rs = [r for r in rows if r["metric"] == key]
        if not any(r["reader"] or r["native"] for r in rs):
            continue
        lines.append(f"## {label}")
        lines.append("")
        lines.append("| doc | pages | reader | native | ratio | band | verdict |")
        lines.append("|---|---:|---:|---:|---:|---:|---|")
        for r in rs:
            ratio = f"{r['ratio']:.2f}" if r.get("ratio") else "–"
            band = fmt(r.get("band"), unit) if r.get("band") is not None else "–"
            lines.append(f"| {r['doc']} | {r['pages']} | {cell(r['reader'], unit)} | {cell(r['native'], unit)} | "
                         f"{ratio} | {band} | {r.get('verdict', '–')} |")
        lines.append("")
    # Reader-only attribution figures.
    lines.append("## Reader-only figures (median over trials)")
    lines.append("")
    lines.append("| doc | pages | raster requests (journey) | raster MB (journey) | raster ms cold (median) | "
                 "mounted pages | decoded raster MB | daemon footprint MB | daemon growth MB | text lines |")
    lines.append("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|")
    for doc in result["docs"]:
        tr = [t for t in doc.get("trials", {}).get("reader", []) if not t.get("fatal")]
        if not tr:
            continue
        def med(f):
            v = [x for x in (f(t) for t in tr) if x is not None]
            return statistics.median(v) if v else None
        def g(t, *path):
            for k in path:
                t = t.get(k) if isinstance(t, dict) else None
            return t
        cells = [
            med(lambda t: g(t, "rasters", "journey_requests")),
            med(lambda t: (g(t, "rasters", "journey_bytes") or 0) / 1e6),
            med(lambda t: g(t, "rasters", "by_phase", "open_cold", "ms_median")),
            med(lambda t: g(t, "reader_dom", "imagesWithSrc")),
            med(lambda t: (g(t, "reader_dom", "decodedBytesEstimate") or 0) / 1e6),
            med(lambda t: (g(t, "memory", "daemon_after") or 0) / 1e6),
            med(lambda t: (g(t, "memory", "daemon_delta") or 0) / 1e6),
            med(lambda t: g(t, "reader_dom", "textLines")),
        ]
        lines.append(f"| {doc['sha']} | {doc['pages']} | " + " | ".join("–" if c is None else f"{c:.0f}" for c in cells) + " |")
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("result")
    ap.add_argument("--md")
    args = ap.parse_args()
    path = pathlib.Path(args.result)
    result = json.loads(path.read_text())
    rows, summary = compare(result)
    md = render(result, rows, summary)
    out = pathlib.Path(args.md) if args.md else path.with_suffix(".md")
    out.write_text(md)
    print(md)
    print(f"\nwrote {out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Summarize a reader scorecard, beside the stored results of the retired engine.

Usage:
    python3 bench/reader/compare.py <reader.json> [--md OUT.md] [--corpus DIR] [--worst 15]

Reads the scorecard written by bench/reader/run.py and, for the same sha256,
<corpus>/probe/<sha256>.json: the results the probe of the retired pdf2htmlEX
engine stored before it was removed (ADR 0015). They are a fixed historical
baseline; documents without one are left out of the tables. Prints a table and writes a markdown summary
(default: next to the scorecard, <reader>.md). Stdlib only; no PDF is opened
and no document text is read. Definitions: bench/reader/README.md.
"""
from __future__ import annotations

import argparse
import collections
import json
import os
import pathlib
import sys

# Failure families with a counterpart in both engines. A document fails a
# family when it has any of the listed classes.
FAMILIES = [
    ("fails to open / render",
     {"convert-crash", "convert-timeout", "convert-refused", "light-build-failed", "viewer-load-failed"},
     {"open-failed", "doc-timeout", "raster-timeout", "raster-error", "page-missing"}),
    ("page-count-mismatch", {"page-count-mismatch"}, {"page-count-mismatch"}),
    ("page-size-mismatch", {"page-size-mismatch"}, {"page-size-mismatch"}),
    ("visual-diff-high", {"visual-diff-high"}, {"visual-diff-high"}),
    ("glyph-drift / font-substitution", {"glyph-drift", "font-substitution"}, {"glyph-drift", "font-substitution"}),
    ("raster-blur", {"raster-blur"}, {"raster-blur"}),
    ("blank-page", {"blank-page"}, {"blank-page"}),
    ("text-loss", {"text-loss"}, {"text-loss"}),
]
OLD_NOT_COMPARABLE = {
    "ghost-glyphs": "pdf2htmlEX visible text layer; reader text is transparent, not measured",
    "selection-occlusion": "pdf2htmlEX text-layer stacking; not measured for the reader",
    "tall-line-box": "pdf2htmlEX line boxes; not measured for the reader",
    "covered-text-desync": "pdf2htmlEX converter warning; no converter in the reader",
    "no-text": "document property (PDFium), not a viewer failure",
    "pdfium-error": "PDFium side, not a viewer failure",
    "pdfium-slow-page": "PDFium side, not a viewer failure",
    "probe-error": "old probe's own failure",
}
READER_ONLY = {
    "console-error": "console or page error other than the meta.json 404 (old: stored consoleErrors, see below)",
    "meta-json-404": "overlay requests /<hash>/meta.json, which reader entries lack",
    "failed-request": "a daemon request answered >= 400 or failed (other than meta.json)",
    "find-miss": "a sampled word was not found by window.find on its page",
    "copy-mismatch": "copy similarity < 0.95 on a page with >= 50 PDFium characters",
    "highlight-misaligned": "document median highlight IoU < 0.5",
    "raster-underres": "page raster narrower than the page's device width",
    "jump-failed": "palette jump did not bring the page into view",
    "raster-no-box": "page raster image has no layout box when the page is screenshotted",
    "palette-missing": "the : palette did not open",
    "bench-error": "the bench itself failed on this document",
}
NOT_VIEWER_OLD = {"no-text", "pdfium-error", "pdfium-slow-page", "probe-error"}


def corpus_dir(arg):
    return pathlib.Path(arg or os.environ.get("PDFV_CORPUS_DIR") or "~/.local/share/pdf_viewer/corpus").expanduser()


def pct(values, q):
    v = sorted(x for x in values if x is not None)
    if not v:
        return None
    k = (len(v) - 1) * q / 100
    lo = int(k)
    hi = min(lo + 1, len(v) - 1)
    return v[lo] + (v[hi] - v[lo]) * (k - lo)


def fmt(x, digits=3):
    if x is None:
        return "–"
    if isinstance(x, int) or (isinstance(x, float) and abs(x) >= 100):
        return f"{x:,.0f}"
    return f"{x:.{digits}f}"


def share(n, d):
    return f"{n}/{d} ({100 * n / d:.1f} %)" if d else "–"


def old_metrics(probe: dict) -> dict:
    """Numbers from a stored probe result that have a reader counterpart."""
    out = {"console_errors": 0, "console_errors_non404": 0}
    for u in probe.get("convert") or []:
        errs = (u.get("viewer") or {}).get("consoleErrors") or []
        out["console_errors"] += len(errs)
        out["console_errors_non404"] += sum(1 for e in errs if "status of 404" not in e)
    worst = None
    for p in (probe.get("visual") or {}).get("pages", []):
        if "extra" in p:
            s = max(p["extra"], p["missing"])
            worst = s if worst is None else max(worst, s)
    out["visual_worst"] = worst
    secs = 0.0
    for u in probe.get("convert") or []:
        secs += u.get("seconds") or 0
        secs += (u.get("light") or {}).get("seconds") or 0
    out["convert_seconds"] = secs
    return out


def table(rows, header):
    widths = [max(len(str(r[i])) for r in [header] + rows) for i in range(len(header))]
    line = lambda r: "  ".join(str(c).ljust(w) for c, w in zip(r, widths))
    return "\n".join([line(header), line(["-" * w for w in widths])] + [line(r) for r in rows])


def md_table(rows, header):
    out = ["| " + " | ".join(header) + " |", "|" + "|".join("---" for _ in header) + "|"]
    out += ["| " + " | ".join(str(c) for c in r) + " |" for r in rows]
    return "\n".join(out)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("scorecard")
    ap.add_argument("--md")
    ap.add_argument("--corpus")
    ap.add_argument("--worst", type=int, default=15)
    args = ap.parse_args()
    src = pathlib.Path(args.scorecard)
    data = json.loads(src.read_text())
    meta, docs = data["meta"], data["docs"]
    corpus = corpus_dir(args.corpus)
    old = {}
    for d in docs:
        path = corpus / "probe" / f"{d['sha256']}.json"
        if path.exists():
            old[d["sha256"]] = json.loads(path.read_text())
    both = [d for d in docs if d["sha256"] in old]
    n = len(both)
    sections = []   # (title, plain text, markdown)

    # ---- overview
    bench_err = [d for d in both if "bench-error" in d["classes"]]
    ov = [
        ["documents scored", len(docs)],
        ["with a stored old-engine probe", n],
        ["with bench-error (still counted; see failures list)", len(bench_err)],
        ["git commit", (meta.get("git_commit") or "?")[:12]
         + (" (dirty: " + ", ".join(meta.get("git_dirty_paths") or []) + ")" if meta.get("git_dirty_paths") else "")],
        ["base", meta.get("base")],
        ["started", meta.get("started_at")],
        ["max pages / words per page", f"{meta.get('max_pages')} / {meta.get('words_per_page')}"],
        ["cache entries created / deleted / left", "{created} / {deleted_ok} / {still_present}".format(
            **(meta.get("cleanup") or {"created": "?", "deleted_ok": "?", "still_present": "?"}))],
    ]
    sections.append(("Run", table(ov, ["", ""]), md_table(ov, ["", ""])))

    # ---- failure families
    rows = []
    old_any = sum(1 for d in both if any(c for f in FAMILIES for c in f[1] if c in old[d["sha256"]].get("classes", [])))
    new_any = sum(1 for d in both if any(c for f in FAMILIES for c in f[2] if c in d["classes"]))
    for name, oc, nc in FAMILIES:
        o = sum(1 for d in both if oc & set(old[d["sha256"]].get("classes", [])))
        r = sum(1 for d in both if nc & set(d["classes"]))
        rows.append([name, share(o, n), share(r, n)])
    rows.append(["ANY comparable family", share(old_any, n), share(new_any, n)])
    old_viewer = sum(1 for d in both if set(old[d["sha256"]].get("classes", [])) - NOT_VIEWER_OLD)
    rows.append(["old: any viewer class (summary.py definition)", share(old_viewer, n), "n/a"])
    oce = sum(1 for d in both if old_metrics(old[d["sha256"]])["console_errors"])
    rce = sum(1 for d in both if {"console-error", "meta-json-404"} & set(d["classes"]))
    rce2 = sum(1 for d in both if "console-error" in d["classes"])
    oce2 = sum(1 for d in both if old_metrics(old[d["sha256"]])["console_errors_non404"])
    rows.append(["console errors, any (old 404s come from the probe harness's stubbed routes)",
                 share(oce, n), share(rce, n)])
    rows.append(["console errors other than resource 404s (old) / meta.json 404 (reader)", share(oce2, n),
                 share(rce2, n)])
    h = ["failure family (same documents)", "old engine", "reader"]
    sections.append(("Failure rate, old engine vs reader", table(rows, h), md_table(rows, h)))

    # ---- class counts
    oc = collections.Counter(c for d in both for c in old[d["sha256"]].get("classes", []))
    rc = collections.Counter(c for d in both for c in d["classes"])
    rows = [[c, oc[c], "reader counterpart" if any(c in f[1] for f in FAMILIES) else
             OLD_NOT_COMPARABLE.get(c, "?")] for c in sorted(oc, key=lambda c: -oc[c])]
    h = ["old class", "documents", "comparability"]
    sections.append(("Old-engine classes on these documents", table(rows, h), md_table(rows, h)))
    rows = [[c, rc[c], "comparable" if any(c in f[2] for f in FAMILIES) else READER_ONLY.get(c, "?")]
            for c in sorted(rc, key=lambda c: -rc[c])]
    h = ["reader class", "documents", "meaning"]
    sections.append(("Reader classes", table(rows, h), md_table(rows, h)))

    # ---- distributions
    def series(key, src="metrics"):
        return [(d["sha256"], (d.get(src) or {}).get(key)) for d in both if (d.get(src) or {}).get(key) is not None]

    metrics = [
        ("time to first raster, ms (cold, incl. /read)", series("first_raster_ms", "open"), "high"),
        ("palette jump to crisp page, ms (doc median)", series("jump_ms_median"), "high"),
        ("visual: worst max(extra, missing) per doc", series("visual_worst"), "high"),
        ("visual: same, old-probe pages only", series("visual_worst_old_pages"), "high"),
        ("visual: block_diff worst", series("block_diff_worst"), "high"),
        ("copy similarity (doc mean)", series("copy_sim_mean"), "low"),
        ("copy similarity (doc worst page)", series("copy_sim_min"), "low"),
        ("copy similarity, whitespace removed", series("copy_sim_nows_mean"), "low"),
        ("find recall", series("find_recall"), "low"),
        ("highlight IoU (doc median)", series("iou_median"), "low"),
        ("highlight IoU (doc p10)", series("iou_p10"), "low"),
        ("highlight x-extent IoU (doc median)", series("iou_x_median"), "low"),
    ]
    oldv = [(s, old_metrics(old[s])["visual_worst"]) for s in old if old_metrics(old[s])["visual_worst"] is not None
            and s in {d["sha256"] for d in both}]
    oldt = [(s, old_metrics(old[s])["convert_seconds"] * 1000) for s in old if s in {d["sha256"] for d in both}]
    rows = []
    for name, vals, _ in metrics:
        v = [x for _, x in vals]
        rows.append([name, len(v), fmt(pct(v, 10)), fmt(pct(v, 50)), fmt(pct(v, 90))])
    v = [x for _, x in oldv]
    rows.append(["OLD visual: worst max(extra, missing) per doc", len(v), fmt(pct(v, 10)), fmt(pct(v, 50)), fmt(pct(v, 90))])
    v = [x for _, x in oldt]
    rows.append(["OLD conversion + light build, ms (one-off, not comparable)", len(v), fmt(pct(v, 10)),
                 fmt(pct(v, 50)), fmt(pct(v, 90))])
    h = ["metric", "n", "p10", "median", "p90"]
    sections.append(("Distributions", table(rows, h), md_table(rows, h)))

    # ---- worst documents
    kind = lambda s: next((l for l in next(d for d in both if d["sha256"] == s)["labels"] if l.startswith("kind:")), "")
    for name, vals, worse in metrics:
        if not vals:
            continue
        ranked = sorted(vals, key=lambda kv: kv[1], reverse=(worse == "high"))[:args.worst]
        rows = [[s[:12], fmt(x, 4), kind(s)] for s, x in ranked]
        h = ["sha256", name, "kind"]
        sections.append((f"Worst {args.worst}: {name}", table(rows, h), md_table(rows, h)))

    # ---- failing documents
    rows = [[d["sha256"][:12], ",".join(c for c in d["classes"] if c != "meta-json-404"),
             " | ".join(d.get("notes") or [])[:120]]
            for d in both if set(d["classes"]) - {"meta-json-404"}]
    h = ["sha256", "reader classes (excl. meta-json-404)", "notes"]
    sections.append(("Reader failures by document", table(rows, h), md_table(rows, h)))

    for title, text, _ in sections:
        print(f"\n== {title} ==\n{text}")
    md_path = pathlib.Path(args.md) if args.md else src.with_suffix(".md")
    md = [f"# Reader scorecard vs old engine\n\nScorecard: `{src.name}`. Definitions: bench/reader/README.md.\n"]
    md += [f"## {t}\n\n{m}\n" for t, _, m in sections]
    md_path.write_text("\n".join(md))
    print(f"\nwrote {md_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

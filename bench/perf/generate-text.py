#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["reportlab==5.1.0"]
# ///
"""Generate a public, deterministic text corpus for run.py and the reader scorecard.

uv run bench/perf/generate-text.py /tmp/pdfv-perf-corpus
The default repeats text, exercising large DOMs but giving no unique find words.
Use --unique-words for a separate scorecard fixture with unique words per page.
"""
import argparse
import hashlib
import json
from pathlib import Path

from reportlab.pdfgen import canvas

ap = argparse.ArgumentParser(description=__doc__)
ap.add_argument("out", type=Path)
ap.add_argument("--pages", type=int, nargs="+", default=[127, 1677])
ap.add_argument("--unique-words", action="store_true")
ap.add_argument("--flat", action="store_true", help="write named PDFs for verify-extension.sh --cold-reader")
args = ap.parse_args()
args.out.mkdir(parents=True, exist_ok=True)
rows = []
words = "Searching highlights geometry measured document rendering preserves transparent selectable keyboard navigation accurately".split()
for pages in args.pages:
    p = args.out / f"dense-{pages}.pdf"
    c = canvas.Canvas(str(p), pagesize=(612, 792), invariant=1)
    for n in range(pages):
        c.setFont("Helvetica", 10)
        for line in range(50):
            text = f"Page {n+1} line {line+1}: Measured rendering keeps searchable text across the document."
            if args.unique_words and line < len(words):
                text = words[line] + f" {n+1} {line+1}"
            c.drawString(40, 750-line*14, text)
        c.showPage()
    c.save()
    if args.flat:
        continue
    sha = hashlib.sha256(p.read_bytes()).hexdigest()
    target = args.out / "files" / sha[:2] / f"{sha}.pdf"
    target.parent.mkdir(parents=True, exist_ok=True)
    p.replace(target)
    rows.append(dict(sha256=sha, pages=pages, bytes=target.stat().st_size, tier="t1",
                     labels=["generated-text"], page_sizes=[dict(w=612, h=792, count=pages)], sources=[]))
if rows:
    (args.out / "manifest.jsonl").write_text("".join(json.dumps(r)+"\n" for r in rows))
    print(",".join(r["sha256"][:12] for r in rows))

"""Corpus location, Playwright lookup and comparison thresholds shared by the
reader scorecard (bench/reader) and the performance benchmark (bench/perf).

The thresholds were calibrated for the probe of the retired pdf2htmlEX engine
and are kept unchanged so reader scorecards stay comparable with the stored
results of that probe."""
from __future__ import annotations

import os
import pathlib

FIT_WIDTH_CSS = 1600           # visual comparison at fit-width 1600 CSS px ...
DPR = 2                        # ... and device pixel ratio 2
MAX_PAGE_CSS_HEIGHT = 4000     # very tall pages get a smaller zoom

INK_DARK = 128                 # luma below this is ink
INK_RADIUS = 2                 # device px of tolerance (1 CSS px at DPR 2)
VISUAL = {"extra": 0.03, "missing": 0.03, "block_diff": 0.02}   # above: page fails (diff images saved)
VISUAL_HIGH = 0.15             # extra or missing above this: visual-diff-high; between: glyph-drift
BLUR_FAINT = 0.8               # share of missing ink with faint viewer ink nearby: raster-blur
TEXT_LOSS_RATIO = 0.5          # HTML keeps less than half of PDFium's characters
SIZE_DELTA_PX = 4              # page box differs from PDFium's by more than this


def corpus_dir(arg):
    raw = arg or os.environ.get("PDFV_CORPUS_DIR") or "~/.local/share/pdf_viewer/corpus"
    return pathlib.Path(raw).expanduser()


def playwright_node_path() -> str | None:
    default = pathlib.Path.home() / ".npm/_npx/705bc6b22212b352/node_modules"
    if (default / "playwright").is_dir():
        return str(default)
    for base in (pathlib.Path.home() / ".npm/_npx", pathlib.Path.home() / "Library/Caches"):
        for p in base.glob("*/node_modules/playwright"):
            return str(p.parent)
    return None

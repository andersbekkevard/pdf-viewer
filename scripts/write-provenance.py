#!/usr/bin/env python3
"""Write conversion provenance into a cache entry's meta.json.

Provenance is *pipeline*-owned metadata (which converter binary produced the
HTML, when, at what overlay version) — kept deliberately separate from the
pdfinfo-derived fields owned by extract-meta.py. It lives under a single
top-level "provenance" object so the two writers never collide:

    {
      "pages": 1137,            # pdfinfo-derived (extract-meta.py)
      "file_size": 14190884,    #   "
      "provenance": {           # pipeline-derived (this script)
        "converter": "native-arm64",
        "pdf2htmlex": "0.18.8.rc2",
        "poppler": "24.06.1",
        "converted_at": "2026-06-12",
        "overlay_version": "8efe6927a5"
      }
    }

Merge-safety, both directions:
  - This script does a read-modify-write *merge*: it loads any existing
    meta.json, replaces only the "provenance" key, and writes the rest back
    untouched. So a meta.json that already has pdfinfo fields keeps them.
  - extract-meta.py / extract-pdf-meta.sh is the mirror image: it now merges
    its pdfinfo fields into an existing meta.json instead of blind-overwriting,
    so a meta.json that already has provenance keeps it.
Either writer can run first; order does not matter.

Usage:
  write-provenance.py <meta.json> [--converter NAME] [--pdf2htmlex V]
      [--poppler V] [--converted-at ISO] [--overlay-version HASH]
      [--extra KEY=VALUE ...] [--bin /path/to/pdf2htmlEX]

If --pdf2htmlex / --poppler are omitted and --bin is given, versions are
parsed from `<bin> --version`. --extra KEY=VALUE adds raw string fields (used
by the backfill to stamp {"backfilled": true}).
"""
import argparse
import datetime
import json
import os
import subprocess
import sys


def parse_versions_from_bin(bin_path: str) -> dict:
    """Return {'pdf2htmlex': ..., 'poppler': ...} parsed from `<bin> --version`.

    pdf2htmlEX prints e.g.:
        pdf2htmlEX version 0.18.8.rc2
        Libraries:
          poppler 24.06.1
    Output may land on stdout or stderr depending on build; read both.
    """
    out = {}
    try:
        proc = subprocess.run(
            [bin_path, "--version"],
            capture_output=True, text=True, timeout=15,
        )
    except (OSError, subprocess.SubprocessError):
        return out
    text = (proc.stdout or "") + "\n" + (proc.stderr or "")
    for line in text.splitlines():
        s = line.strip()
        low = s.lower()
        if low.startswith("pdf2htmlex version "):
            out["pdf2htmlex"] = s.split(None, 2)[2].strip()
        elif low.startswith("poppler "):
            # The "Libraries:" block prints "poppler 24.06.1"; guard against
            # the separate "Poppler data-dir: …" line by requiring the token
            # after "poppler" to look like a version (starts with a digit).
            parts = s.split(None, 1)
            if len(parts) == 2 and parts[1][:1].isdigit():
                out["poppler"] = parts[1].strip()
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("meta", help="path to meta.json (created if absent)")
    ap.add_argument("--converter", default="native-arm64")
    ap.add_argument("--pdf2htmlex", default=None)
    ap.add_argument("--poppler", default=None)
    ap.add_argument("--converted-at", default=None,
                    help="ISO date; defaults to today (UTC) when omitted")
    ap.add_argument("--overlay-version", default=None)
    ap.add_argument("--bin", default=None,
                    help="pdf2htmlEX binary to parse --version from when "
                         "--pdf2htmlex/--poppler are omitted")
    ap.add_argument("--extra", action="append", default=[],
                    metavar="KEY=VALUE",
                    help="extra raw string field (repeatable)")
    args = ap.parse_args()

    pdf2htmlex = args.pdf2htmlex
    poppler = args.poppler
    if (pdf2htmlex is None or poppler is None) and args.bin:
        parsed = parse_versions_from_bin(args.bin)
        if pdf2htmlex is None:
            pdf2htmlex = parsed.get("pdf2htmlex")
        if poppler is None:
            poppler = parsed.get("poppler")

    prov: dict = {"converter": args.converter}
    if pdf2htmlex:
        prov["pdf2htmlex"] = pdf2htmlex
    if poppler:
        prov["poppler"] = poppler
    if args.converted_at is not None:
        prov["converted_at"] = args.converted_at
    elif not args.extra:
        # Live conversions stamp the date; backfill omits it (uses --extra
        # backfilled=true + a documented date heuristic instead).
        prov["converted_at"] = datetime.date.today().isoformat()
    if args.overlay_version is not None:
        # A content hash (inject-overlay.py --print-version). Always a string:
        # an all-digit hash must not turn into a number or lose leading zeros.
        prov["overlay_version"] = args.overlay_version

    for kv in args.extra:
        key, _, value = kv.partition("=")
        key = key.strip()
        if not key:
            continue
        value = value.strip()
        if value == "true":
            prov[key] = True
        elif value == "false":
            prov[key] = False
        else:
            try:
                prov[key] = int(value)
            except ValueError:
                prov[key] = value

    # Idempotent merge: load existing meta.json, replace only "provenance",
    # preserve every pdfinfo-derived key untouched.
    meta: dict = {}
    if os.path.exists(args.meta):
        try:
            with open(args.meta, "r", encoding="utf-8") as f:
                loaded = json.load(f)
            if isinstance(loaded, dict):
                meta = loaded
        except (OSError, ValueError):
            meta = {}

    meta["provenance"] = prov

    tmp = args.meta + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, args.meta)
    return 0


if __name__ == "__main__":
    sys.exit(main())

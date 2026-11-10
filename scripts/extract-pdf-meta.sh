#!/bin/bash

# ============================================================================
# Extract PDF metadata into meta.json.
#
# Usage: extract-pdf-meta.sh <pdf_path> <out_meta_json>
#
# Requires local `pdfinfo` (from `brew install poppler`). Metadata is an
# optional enhancement — if pdfinfo isn't on PATH we log + skip (exit 0)
# rather than fail, so a fresh convert still completes (the overlay falls
# back to empty meta in that case).
# ============================================================================

set -u

PDF="${1:-}"
OUT="${2:-}"
if [[ -z "$PDF" || -z "$OUT" ]]; then
    echo "usage: $(basename "$0") <pdf> <out.json>" >&2
    exit 2
fi
[[ -f "$PDF" ]] || { echo "not a file: $PDF" >&2; exit 1; }

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARSER="$REPO_DIR/scripts/extract-meta.py"

# Optional feature: with no local pdfinfo there's nothing to fall back to now
# that Docker is gone. Skip cleanly (exit 0) so the caller treats meta as
# simply absent rather than a hard failure.
if ! command -v pdfinfo >/dev/null 2>&1; then
    echo "pdfinfo not found (brew install poppler) — skipping meta for $PDF" >&2
    exit 0
fi

RAW=$(mktemp)
trap 'rm -f "$RAW"' EXIT

pdfinfo -enc UTF-8 "$PDF" > "$RAW" 2>/dev/null || {
    echo "pdfinfo failed on $PDF" >&2
    exit 1
}

# Pass $OUT as a merge target (not a stdout redirect) so an existing
# meta.json's pipeline-written "provenance" object survives. extract-meta.py
# refreshes only the pdfinfo-owned keys and leaves provenance untouched.
python3 "$PARSER" "$RAW" "$OUT"

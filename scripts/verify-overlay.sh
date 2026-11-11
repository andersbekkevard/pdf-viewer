#!/usr/bin/env bash
set -euo pipefail
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$REPO_DIR/scripts/lib/playwright.sh"
resolve_playwright || exit 2
if [[ "${1:-}" = --both ]]; then
    shift
    "$0" --reader "$@"
    "$0" --pdf2htmlex "$@"
    exit
fi
if [[ $# = 0 || "${1:-}" = --reader || "${1:-}" = --pdf2htmlex ]]; then
    engine=${1:---reader}
    [[ $# = 0 ]] || shift
    source "$REPO_DIR/scripts/lib/overlay-scratch.sh"
    start_overlay_scratch
    make_overlay_fixture
    if [[ "$engine" = --pdf2htmlex ]]; then
        convert_overlay_fixture
    else
        export PDFV_SYNTHETIC=1
    fi
    NODE_PATH="$PW_NODE_PATH" node "$REPO_DIR/scripts/verify-overlay.cjs" "$OVERLAY_URL" "$@"
else
    # Existing cached document, including a full URL on any daemon port.
    NODE_PATH="$PW_NODE_PATH" node "$REPO_DIR/scripts/verify-overlay.cjs" "$@"
fi

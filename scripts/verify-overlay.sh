#!/usr/bin/env bash
# Overlay regression checks in headless Chromium.
#   verify-overlay.sh [--only <group>…]   generated fixtures on a scratch daemon
#   verify-overlay.sh <url> […]           an existing document on any daemon
set -euo pipefail
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$REPO_DIR/scripts/lib/playwright.sh"
resolve_playwright || exit 2
[[ "${1:-}" != --reader ]] || shift   # the old flag; the reader is the only engine
if [[ $# = 0 || "${1:-}" = --* ]]; then
    source "$REPO_DIR/scripts/lib/overlay-scratch.sh"
    start_overlay_scratch
    make_overlay_fixture
    export PDFV_SYNTHETIC=1
    NODE_PATH="$PW_NODE_PATH" node "$REPO_DIR/scripts/verify-overlay.cjs" "$OVERLAY_URL" "$@"
else
    NODE_PATH="$PW_NODE_PATH" node "$REPO_DIR/scripts/verify-overlay.cjs" "$@"
fi

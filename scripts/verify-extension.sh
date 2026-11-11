#!/usr/bin/env bash
# Extension end-to-end check: scratch reader daemon on :7450 (PDFV_VERIFY_PORT
# moves it), a temp copy of extension/, a local web origin and headless
# Chromium for Testing. It starts and stops everything itself and never
# touches the real cache or daemons. Options: header of verify-extension.cjs.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HARNESS="$REPO_DIR/scripts/verify-extension.cjs"

source "$(cd "$(dirname "$0")" && pwd)/lib/playwright.sh"
resolve_playwright || exit 2

exec env NODE_PATH="$PW_NODE_PATH" node "$HARNESS" "$@"

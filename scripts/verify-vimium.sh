#!/usr/bin/env bash
# Viewer under the real Vimium extension: a read-only copy of the installed
# Vimium plus a temp copy of extension/, a scratch reader daemon on the first
# free port in 7470–7479 and headless Chromium for Testing. Generates its test
# PDFs, starts and stops everything itself and never touches the real cache,
# the daemons on 7435–7437 or a browser profile. See docs/verification.md.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HARNESS="$REPO_DIR/scripts/verify-vimium.cjs"

source "$(cd "$(dirname "$0")" && pwd)/lib/playwright.sh"
resolve_playwright || exit 2

exec env NODE_PATH="$PW_NODE_PATH" node "$HARNESS" "$@"

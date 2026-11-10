#!/usr/bin/env bash
# Text-fidelity wrapper. Resolves the same cached Playwright used by smoke-viewer;
# the harness reads converted HTML from disk, so the daemon is not needed.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HARNESS="$REPO_DIR/scripts/measure-text-fidelity.cjs"

source "$(cd "$(dirname "$0")" && pwd)/lib/playwright.sh"
resolve_playwright || exit 2

exec env NODE_PATH="$PW_NODE_PATH" node "$HARNESS" "$@"

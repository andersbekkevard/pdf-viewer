#!/usr/bin/env bash
# Run the same-journey renderer physical-footprint benchmark without adding deps.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HARNESS="$REPO_DIR/scripts/measure-viewer-memory.cjs"

if ! curl -fsS http://127.0.0.1:7435/healthz >/dev/null; then
    echo "measure-viewer-memory.sh: daemon unreachable on :7435 (it must already be running)" >&2
    exit 2
fi

source "$(cd "$(dirname "$0")" && pwd)/lib/playwright.sh"
resolve_playwright || exit 2

exec env NODE_PATH="$PW_NODE_PATH" node "$HARNESS" "$@"

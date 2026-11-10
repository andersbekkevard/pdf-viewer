#!/usr/bin/env bash
# Visual parity wrapper. Resolves the same cached Playwright used by smoke-viewer.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HARNESS="$REPO_DIR/scripts/verify-light-parity.cjs"

if ! curl -fsS http://localhost:7435/healthz >/dev/null; then
    echo "verify-light-parity.sh: daemon unreachable on :7435 (it must already be running)" >&2
    exit 2
fi

source "$(cd "$(dirname "$0")" && pwd)/lib/playwright.sh"
resolve_playwright || exit 2

exec env NODE_PATH="$PW_NODE_PATH" node "$HARNESS" "$@"

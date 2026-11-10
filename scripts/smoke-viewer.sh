#!/usr/bin/env bash
#
# smoke-viewer.sh — overlay smoke test. The standard pre-close check for
# overlay beads (see docs/verification.md).
#
# Single command, exits non-zero on any failure. Flow:
#   1. Convert test/fixtures/basic_text.pdf with the real native pdf2htmlEX
#      binary into a TEMP cache entry under ~/.cache/pdf_viewer/ so the
#      running daemon (:7435) can serve it.
#   2. Inject the live overlay via scripts/inject-overlay.py (same call
#      signature as scripts/pdf2html-convert.sh).
#   3. Run headless-Chromium assertions (scripts/smoke-viewer.cjs) against
#      the daemon-served entry.
#   4. trap-clean the temp entry on exit (pass or fail).
#
# No mocks: the assertions hit the real daemon. No global installs: Playwright
# is resolved from the local npx module cache.
set -euo pipefail

PORT=7435
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE_DIR="$HOME/.cache/pdf_viewer"
FIXTURE="$REPO_DIR/test/fixtures/basic_text.pdf"
INJECTOR="$REPO_DIR/scripts/inject-overlay.py"
ASSERT_SCRIPT="$REPO_DIR/scripts/smoke-viewer.cjs"

# Native arm64 pdf2htmlEX — same paths as pdf2html-convert.sh.
NATIVE_BIN="$HOME/.local/opt/pdf2htmlEX/bin/pdf2htmlEX"
NATIVE_DATA_DIR="$HOME/.local/opt/pdf2htmlEX/share/pdf2htmlEX"
NATIVE_POPPLER_DATA="/opt/homebrew/share/poppler"

# Temp cache entry. The dir name must be hex so inject-overlay.py derives the
# hash meta tag and the daemon's /<hash>/<file> route accepts it. A hex pid
# pad keeps it unique and trivially cleanable.
SMOKE_HASH=$(printf 'fee%013x' "$$")
SMOKE_HASH="${SMOKE_HASH:0:16}"
OUT_DIR="$CACHE_DIR/$SMOKE_HASH"

cleanup() { rm -rf "$OUT_DIR"; }
trap cleanup EXIT

err() { printf 'smoke-viewer.sh: %s\n' "$*" >&2; exit 1; }

[[ -f "$FIXTURE" ]]      || err "fixture missing: $FIXTURE"
[[ -x "$NATIVE_BIN" ]]   || err "native pdf2htmlEX not installed: $NATIVE_BIN (run scripts/install-native-pdf2htmlex.sh)"
[[ -d "$NATIVE_DATA_DIR" ]] || err "native data dir missing: $NATIVE_DATA_DIR"

# Daemon must already be up — we never start it (read-only, no mocks).
HEALTHZ=$(curl -sf "http://localhost:${PORT}/healthz" 2>/dev/null || true)
[[ "$HEALTHZ" == *'"status":"ok"'* ]] || \
    err "daemon unreachable on :${PORT} — start it (uv run --directory daemon main.py) or kickstart launchd"

# The daemon serves /_assets/* via the cache-dir symlink; require it exists.
[[ -L "$CACHE_DIR/_assets" ]] || \
    err "cache _assets symlink missing — overlay assets won't be served (run a conversion once to create it)"

mkdir -p "$OUT_DIR"

# --- 1. convert with the real native binary ---------------------------------
echo "smoke-viewer.sh: converting fixture into temp entry $SMOKE_HASH"
"$NATIVE_BIN" --data-dir "$NATIVE_DATA_DIR" \
    --poppler-data-dir "$NATIVE_POPPLER_DATA" --dest-dir "$OUT_DIR" \
    "$FIXTURE" >/dev/null 2>&1 \
    || err "pdf2htmlEX conversion failed"

OUT_HTML="$OUT_DIR/basic_text.html"
[[ -f "$OUT_HTML" ]] || err "conversion produced no HTML at $OUT_HTML"

# --- 2. inject overlay (same signature as pdf2html-convert.sh) --------------
uv run "$INJECTOR" "$OUT_HTML" "basic_text" \
    || err "overlay injection failed"

# A real cached entry always has a sibling meta.json (extract-pdf-meta.sh runs
# post-nav). The overlay fetches /<hash>/meta.json on boot; without it the
# daemon 404s and the browser logs a console error — noise that would mask a
# genuine overlay regression. Write a minimal valid one so the entry matches a
# real cache entry and the "zero console errors" assertion stays meaningful.
printf '{"title":"basic_text","pages":1}\n' > "$OUT_DIR/meta.json"

# --- 3. resolve Playwright + run assertions ---------------------------------
# Local npx module cache (playwright 1.60 / chromium 1223). Verify it resolves;
# fall back to a filesystem search if the pinned dir moved. No installs.
source "$(cd "$(dirname "$0")" && pwd)/lib/playwright.sh"
resolve_playwright || exit 1

VIEW_URL="http://localhost:${PORT}/${SMOKE_HASH}/basic_text.html"
echo "smoke-viewer.sh: asserting against $VIEW_URL"
NODE_PATH="$PW_NODE_PATH" node "$ASSERT_SCRIPT" "$VIEW_URL"

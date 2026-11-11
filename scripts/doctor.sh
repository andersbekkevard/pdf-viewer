#!/bin/bash

# ============================================================================
# pdf_viewer — doctor.sh
#
# One-command, READ-ONLY diagnosis of the full pdf_viewer chain. Walks every
# link the day-to-day workflow depends on and prints one PASS / FAIL / WARN
# line per check, each with a one-line fix hint. Exits non-zero iff a
# *required* check fails; WARN-only checks (optional features) never fail.
#
# The chain (parent epic: pdfv-6el):
#   browser extension → daemon (:7435) → cache dir → overlay assets.
#
# WHY: most historical debugging sessions (stale overlay assets, daemon down,
# unwritable cache) reduce to checking one link in this
# chain. That knowledge lived in heads and docs; this puts it in a tool.
#
# This script NEVER mutates state: no network beyond localhost
# probes against the already-running daemon, no file writes. Safe to run
# anytime.
#
# Usage:
#   scripts/doctor.sh
#
# Env:
#   PDF_VIEWER_PORT   daemon port to probe (default: 7435). Override is for
#                     testability — pointing at a dead port exercises the
#                     daemon-down failure path without stopping the real one.
#
# Exit status:
#   0   all required checks PASS (WARN allowed)
#   1   one or more required checks FAILed
# ============================================================================

set -uo pipefail

PORT="${PDF_VIEWER_PORT:-7435}"
LAUNCHD_LABEL="com.anders.pdf_viewer"

CACHE_DIR="$HOME/.cache/pdf_viewer"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# --- output helpers ----------------------------------------------------------

# ANSI only when stdout is a TTY (keeps log/pipe output clean).
if [ -t 1 ]; then
    C_PASS=$'\033[32m'; C_FAIL=$'\033[31m'; C_WARN=$'\033[33m'
    C_INFO=$'\033[36m'; C_OFF=$'\033[0m'
else
    C_PASS=''; C_FAIL=''; C_WARN=''; C_INFO=''; C_OFF=''
fi

FAILED=0

pass() { printf '%sPASS%s %s\n'  "$C_PASS" "$C_OFF" "$1"; }
warn() { printf '%sWARN%s %s\n   ↳ %s\n' "$C_WARN" "$C_OFF" "$1" "$2"; }
info() { printf '%sINFO%s %s\n'  "$C_INFO" "$C_OFF" "$1"; }
fail() {
    printf '%sFAIL%s %s\n   ↳ %s\n' "$C_FAIL" "$C_OFF" "$1" "$2"
    FAILED=1
}

# ============================================================================
# 1. Daemon: /healthz on :PORT
# ============================================================================

health="$(curl -fsS -m 3 "http://127.0.0.1:${PORT}/healthz" 2>/dev/null || true)"
case "$health" in
    *'"status":"ok"'*)
        entries="$(printf '%s' "$health" | sed -n 's/.*"entries":\([0-9]*\).*/\1/p')"
        pass "daemon /healthz on :${PORT} (entries=${entries:-?})"
        ;;
    *)
        fail "daemon /healthz on :${PORT} not responding" \
             "start it: uv run --directory $REPO_DIR/daemon main.py  (or launchctl kickstart -k gui/\$UID/${LAUNCHD_LABEL})"
        ;;
esac

# ============================================================================
# 2. launchd job loaded
# ============================================================================

if launchctl print "gui/$(id -u)/${LAUNCHD_LABEL}" >/dev/null 2>&1 \
   || launchctl list 2>/dev/null | grep -q "${LAUNCHD_LABEL}"; then
    pass "launchd job ${LAUNCHD_LABEL} loaded"
else
    fail "launchd job ${LAUNCHD_LABEL} not loaded" \
         "load it: launchctl bootstrap gui/\$UID $REPO_DIR/launchd/${LAUNCHD_LABEL}.plist"
fi

# ============================================================================
# 3. Cache dir writable
# ============================================================================

if [ -d "$CACHE_DIR" ] && [ -w "$CACHE_DIR" ]; then
    pass "cache dir writable: $CACHE_DIR"
else
    fail "cache dir missing or not writable: $CACHE_DIR" \
         "mkdir -p $CACHE_DIR && chmod u+w $CACHE_DIR"
fi

# ============================================================================
# 4. /_assets/overlay.js returns 200 through the daemon
# ============================================================================

code="$(curl -s -o /dev/null -w '%{http_code}' -m 3 "http://127.0.0.1:${PORT}/_assets/overlay.js" 2>/dev/null || true)"
if [ "$code" = "200" ]; then
    pass "/_assets/overlay.js → 200 through the daemon"
else
    fail "/_assets/overlay.js → ${code:-no-response} through the daemon" \
         "daemon down or not serving this repo's assets/ — see checks above"
fi

# ============================================================================
# 5. Extension — manual verification instruction (no cheap automated probe)
# ============================================================================

info "Extension (Chrome MV3): no read-only automated probe exists. Verify manually —"
info "  open any *.pdf URL in Chrome; it should redirect to localhost:${PORT} and render the overlay."
info "  If it stays on the native viewer, check extension/ is loaded + its declarativeNetRequest rules are enabled."

# ============================================================================

echo
if [ "$FAILED" -ne 0 ]; then
    printf '%sdoctor: FAIL%s — one or more required checks failed (see ↳ hints above)\n' "$C_FAIL" "$C_OFF"
    exit 1
fi
printf '%sdoctor: OK%s — all required checks passed\n' "$C_PASS" "$C_OFF"
exit 0

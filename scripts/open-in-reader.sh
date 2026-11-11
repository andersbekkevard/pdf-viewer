#!/bin/bash

# ============================================================================
# pdf_viewer — open the active Google Chrome tab's PDF in the reader.
#
# Invoked by the thin Raycast entrypoint raycast/pdf-viewer-convert.sh, which
# forks this script into the background. The extension normally redirects a
# PDF by itself; this is the manual route for a tab it left in the browser's
# own viewer. Reads the active tab's URL and asks the extension (through the
# daemon) to send that tab to the daemon's open route. The reader builds the
# pages on demand; a sign-in-gated source is fetched through the extension.
# ============================================================================

PORT=7435
CACHE_DIR="$HOME/.cache/pdf_viewer"
LOG_FILE="$CACHE_DIR/log"
mkdir -p "$CACHE_DIR"

# The Raycast wrapper redirects all stdio to the log, so nothing this script
# prints reaches Raycast; Raycast silent mode would show stderr as a macOS
# notification. stdout/stderr go log-only.
exec >>"$LOG_FILE" 2>&1

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

# Escape a string for an AppleScript double-quoted string.
osasafe() {
    local s="$1"
    s="${s//\\/\\\\}"
    s="${s//\"/\\\"}"
    printf '%s' "$s"
}

fail() {
    log "FAIL: $1"
    osascript -e 'do shell script "afplay /System/Library/Sounds/Basso.aiff &"' >/dev/null 2>&1
    osascript -e "display notification \"$(osasafe "$1")\" with title \"pdf_viewer error\"" >/dev/null 2>&1
    exit 1
}

# Addressed by bundle id: the name "Google Chrome" can resolve to Playwright's
# "Google Chrome for Testing". Checked first because telling a closed app to
# answer launches it.
CHROME_RUNNING=$(osascript -e 'application id "com.google.Chrome" is running' 2>/dev/null)
[[ "$CHROME_RUNNING" == "true" ]] || fail "Google Chrome is not running"
TAB_URL=$(osascript -e 'tell application id "com.google.Chrome" to return URL of active tab of front window' 2>/dev/null)
[[ -n "$TAB_URL" ]] || fail "No Chrome window with an active tab"

CLEAN_URL=$(python3 -c "import sys,re; print(re.sub(r'[?&]_pdfvw=passthrough', '', sys.argv[1]))" "$TAB_URL")
case "$CLEAN_URL" in
    file://*) READER_URL="http://localhost:${PORT}/view-file-raw?${CLEAN_URL}" ;;
    http://localhost:${PORT}/*|http://127.0.0.1:${PORT}/*) fail "This tab is already in the PDF viewer" ;;
    http://*|https://*) READER_URL="http://localhost:${PORT}/view-raw?${CLEAN_URL}" ;;
    *) fail "Active tab is not a file:// or http(s):// page" ;;
esac

# Chromium's Apple Event bridge cannot navigate a tab without pulling the
# window to the front, so the extension does it: post {from_url, to_url} and
# its long-poll navigates the matching tab.
NAV_PAYLOAD=$(python3 -c "import json, sys; print(json.dumps({'from_url': sys.argv[1], 'to_url': sys.argv[2]}))" "$TAB_URL" "$READER_URL")
curl -sf -m 5 -X POST -H 'Content-Type: application/json' -d "$NAV_PAYLOAD" \
    "http://localhost:${PORT}/signal/navigate" >/dev/null \
    || fail "Could not reach the pdf_viewer daemon"
log "reader open: tab sent to the daemon's open route"

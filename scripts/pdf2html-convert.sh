#!/bin/bash

# ============================================================================
# pdf_viewer — convert the active Google Chrome tab's PDF into the cache.
#
# Invoked by the thin Raycast entrypoint raycast/pdf-viewer-convert.sh, which
# forks this script into the background. Reads the active tab's URL, gets the
# PDF (local file, direct download, or through the browser extension when the
# host needs the browser's session), builds the cache entry with the shared
# pipeline (scripts/lib/pipeline.sh), and asks the extension to navigate that
# tab to the viewer.
# ============================================================================

PORT=7435
# shellcheck source=lib/pipeline.sh
source "$(cd "$(dirname "$0")" && pwd)/lib/pipeline.sh"

# The Raycast wrapper forks us into the background and redirects all stdio
# to the log, so the immediate HUD bubble the user sees is the wrapper's
# own `echo` — nothing this script prints reaches Raycast. stdout/stderr
# go log-only.
exec >>"$LOG_FILE" 2>&1

# osasafe — escape a string for interpolation inside an AppleScript
# double-quoted string. fail()/notify() messages can carry shell-special
# bytes (e.g. download magic bytes like `<!DO...`); an unescaped `"` or `\`
# would break the osascript expression and swallow the error banner.
# Parameter expansion only — safe on macOS system bash 3.2.
osasafe() {
    local s="$1"
    s="${s//\\/\\\\}"
    s="${s//\"/\\\"}"
    printf '%s' "$s"
}

# notify <message> [<subtitle>] — macOS Notification Center toast. Raycast's
# silent mode doesn't surface its own UI during a run, so these are the only
# visible progress signal the user gets; keep them timely.
notify() {
    local msg="$1"
    local subtitle="${2:-}"
    if [[ -n "$subtitle" ]]; then
        osascript -e "display notification \"$(osasafe "$msg")\" with title \"pdf_viewer\" subtitle \"$(osasafe "$subtitle")\"" >/dev/null 2>&1
    else
        osascript -e "display notification \"$(osasafe "$msg")\" with title \"pdf_viewer\"" >/dev/null 2>&1
    fi
}

fail() {
    log "FAIL: $1"
    osascript -e 'do shell script "afplay /System/Library/Sounds/Basso.aiff &"' >/dev/null 2>&1
    # Distinct title so macOS doesn't coalesce with any prior "pdf_viewer"
    # banner (e.g. the "Converting…" notification fired just before the
    # convert step would otherwise replace this error message silently).
    osascript -e "display notification \"$(osasafe "$1")\" with title \"pdf_viewer error\"" >/dev/null 2>&1
    exit 1
}

# browser_fetch <url> <out_file> <headers_file> — download <url> through the
# browser extension, which has the signed-in session that curl lacks. The
# daemon relays a `fetch` signal; the extension fetches the URL only if one of
# its tabs has it open, then hands the bytes back. On failure it returns 1 with
# the reason in BROWSER_FETCH_ERROR.
BROWSER_FETCH_ACK_SEC=40     # extension SW may sleep up to one 30 s alarm tick
BROWSER_FETCH_TOTAL_SEC=300
browser_fetch() {
    local url="$1" out="$2" hdrs="$3" body resp id code waited=0
    BROWSER_FETCH_ERROR=""
    body=$(python3 -c "import json, sys; print(json.dumps({'url': sys.argv[1]}))" "$url")
    resp=$(curl -sSf --max-time 3 -X POST -H 'Content-Type: application/json' \
        -d "$body" "http://localhost:${PORT}/signal/fetch" 2>&1) || {
        BROWSER_FETCH_ERROR="daemon did not accept the fetch request ($resp)"
        return 1
    }
    id=$(printf '%s' "$resp" | python3 -c "import json, sys; print(json.load(sys.stdin)['id'])" 2>/dev/null)
    [[ -n "$id" ]] || { BROWSER_FETCH_ERROR="daemon gave no fetch id"; return 1; }
    while (( waited < BROWSER_FETCH_TOTAL_SEC * 2 )); do
        code=$(curl -sS --max-time 600 -D "$hdrs" -o "$out" -w '%{http_code}' \
            "http://localhost:${PORT}/fetch/${id}" 2>/dev/null)
        case "$code" in
            200)
                [[ "$(head -c 4 "$out")" == "%PDF" ]] && return 0
                BROWSER_FETCH_ERROR="browser returned a non-PDF"
                return 1
                ;;
            202)
                if (( waited >= BROWSER_FETCH_ACK_SEC * 2 )) && ! grep -q '"started"' "$out"; then
                    BROWSER_FETCH_ERROR="no Chrome tab answered; is the Anders PDF Viewer extension loaded and up to date (reload it in chrome://extensions)?"
                    return 1
                fi
                ;;
            502)
                BROWSER_FETCH_ERROR=$(python3 -c "import json, sys; print(json.load(open(sys.argv[1]))['error'])" "$out" 2>/dev/null)
                [[ -n "$BROWSER_FETCH_ERROR" ]] || BROWSER_FETCH_ERROR="extension reported an error"
                return 1
                ;;
            *)
                BROWSER_FETCH_ERROR="daemon returned HTTP ${code:-none} for the fetch result"
                return 1
                ;;
        esac
        sleep 0.5
        waited=$((waited + 1))
    done
    BROWSER_FETCH_ERROR="browser download did not finish within ${BROWSER_FETCH_TOTAL_SEC}s"
    return 1
}


ensure_asset_link || fail "Could not link assets dir"

# Get active tab URL from Google Chrome. Addressed by bundle id: the name
# "Google Chrome" can resolve to Playwright's "Google Chrome for Testing".
# Checked first because telling a closed app to answer launches it.
CHROME_RUNNING=$(osascript -e 'application id "com.google.Chrome" is running' 2>/dev/null)
[[ "$CHROME_RUNNING" == "true" ]] || fail "Google Chrome is not running"
TAB_URL=$(osascript -e 'tell application id "com.google.Chrome" to return URL of active tab of front window' 2>/dev/null)
[[ -n "$TAB_URL" ]] || fail "No Chrome window with an active tab"

# -----------------------------------------------------------------------------
# Reader engine: nothing to convert. Send the tab to the daemon's open route
# (the same one the extension's redirect uses); the reader builds the pages on
# demand, and a sign-in-gated source is fetched through the extension.
# PDF_VIEWER_FORCE_CONVERT=1 keeps the pdf2htmlEX conversion below.
# -----------------------------------------------------------------------------
if [[ -z "${PDF_VIEWER_FORCE_CONVERT:-}" ]] \
    && curl -sf -m 2 "http://localhost:${PORT}/healthz" 2>/dev/null | grep -q '"engine":"reader"'; then
    CLEAN_URL=$(python3 -c "import sys,re; print(re.sub(r'[?&]_pdfvw=passthrough', '', sys.argv[1]))" "$TAB_URL")
    case "$CLEAN_URL" in
        file://*) READER_URL="http://localhost:${PORT}/view-file-raw?${CLEAN_URL}" ;;
        http://*|https://*) READER_URL="http://localhost:${PORT}/view-raw?${CLEAN_URL}" ;;
        *) fail "Active tab is not a file:// or http(s):// page" ;;
    esac
    NAV_PAYLOAD=$(python3 -c "import json, sys; print(json.dumps({'from_url': sys.argv[1], 'to_url': sys.argv[2]}))" "$TAB_URL" "$READER_URL")
    log "reader open: tab sent to the daemon's open route"
    curl -sf -m 5 -X POST -H 'Content-Type: application/json' -d "$NAV_PAYLOAD" \
        "http://localhost:${PORT}/signal/navigate" >/dev/null \
        || fail "Could not reach the pdf_viewer daemon"
    exit 0
fi

# -----------------------------------------------------------------------------
# Scheme dispatch. file:// and http(s):// both end up with:
#   HASH, OUT_DIR, PDF_NAME, OUT_NAME, PDF_DIR (mount source), SOURCE_REF (log)
# -----------------------------------------------------------------------------
if [[ "$TAB_URL" =~ ^file://.*\.[pP][dD][fF]$ ]]; then
    ENCODED_PATH="${TAB_URL#file://}"
    LOCAL_PATH=$(python3 -c "import sys, urllib.parse as u; print(u.unquote(sys.argv[1]))" "$ENCODED_PATH")
    [[ -f "$LOCAL_PATH" ]] || fail "PDF not found on disk"

    # Stable per-file cache key (content hash, survives moves/renames)
    HASH=$(content_hash "$LOCAL_PATH")
    PDF_NAME=$(basename "$LOCAL_PATH")
    OUT_DIR="$CACHE_DIR/$HASH"
    PDF_DIR=$(dirname "$LOCAL_PATH")
    SOURCE_REF="$LOCAL_PATH"
    mkdir -p "$OUT_DIR"
    # An entry that already has HTML keeps its name: the same bytes under
    # another filename, or an entry renamed with :rename, must not convert a
    # second canonical HTML into the directory.
    EXISTING_HTML=$(canonical_html "$OUT_DIR")
    if [[ -n "$EXISTING_HTML" ]]; then
        OUT_NAME=$(basename "$EXISTING_HTML")
    else
        OUT_NAME="${PDF_NAME%.*}.html"
    fi

elif [[ "$TAB_URL" =~ ^https?:// ]]; then
    # host+path hash (query stripped, so signed URLs cache across sessions)
    HASH=$(python3 -c "import sys,hashlib,urllib.parse as u; p=u.urlparse(sys.argv[1]); print(hashlib.sha256((p.netloc+p.path).encode()).hexdigest()[:16])" "$TAB_URL")
    OUT_DIR="$CACHE_DIR/$HASH"
    PDF_DIR="$OUT_DIR/_source"
    SOURCE_REF="$TAB_URL"
    mkdir -p "$OUT_DIR"

    # Resolve PDF_NAME/OUT_NAME. Three cases:
    #   1. fully cached (OUT_DIR has *.html)      → read name from html
    #   2. _source has leftover *.pdf from a prior crashed convert → reuse
    #   3. cold miss                               → download + parse filename
    EXISTING_HTML=$(canonical_html "$OUT_DIR")
    EXISTING_PDF=$(ls "$OUT_DIR/_source"/*.pdf 2>/dev/null | head -1)

    if [[ -n "$EXISTING_HTML" ]]; then
        OUT_NAME=$(basename "$EXISTING_HTML")
        PDF_NAME="${OUT_NAME%.html}.pdf"
    elif [[ -n "$EXISTING_PDF" ]]; then
        PDF_NAME=$(basename "$EXISTING_PDF")
        OUT_NAME="${PDF_NAME%.*}.html"
    else
        mkdir -p "$PDF_DIR"
        notify "Downloading…" "Fetching source PDF from ${TAB_URL:0:60}"
        log "download start: $TAB_URL"
        DIRECT_PROBLEM=""
        if ! curl -fsSL --max-time 300 \
                -D "$PDF_DIR/headers.txt" \
                -o "$PDF_DIR/document.pdf" \
                "$TAB_URL"; then
            DIRECT_PROBLEM="download failed"
        else
            # Magic-byte sanity check (catches login pages from expired signed
            # URLs or auth-gated hosts such as Cloudflare Access, which return
            # HTTP 200 HTML so curl -f does not trip).
            MAGIC=$(head -c 4 "$PDF_DIR/document.pdf" 2>/dev/null)
            if [[ "$MAGIC" != "%PDF" ]]; then
                log "magic-byte check failed; first 200 bytes of $PDF_DIR/document.pdf:"
                head -c 200 "$PDF_DIR/document.pdf" | od -c >>"$LOG_FILE" 2>&1
                # Printable-only truncation for the user-facing message. (No
                # ${var@Q} here: this script runs on macOS system bash 3.2,
                # where that expansion is a syntax error that aborts fail()
                # and lets the script fall through into a bogus convert.)
                MAGIC_SAFE=$(printf '%s' "$MAGIC" | tr -cd '[:print:]' | cut -c1-20)
                DIRECT_PROBLEM="got non-PDF (magic: $MAGIC_SAFE), likely a sign-in page"
            fi
        fi

        # curl has none of the browser's cookies. Retry through the extension,
        # which fetches the same URL inside the signed-in browser session.
        if [[ -n "$DIRECT_PROBLEM" ]]; then
            log "direct download $DIRECT_PROBLEM; retrying through the browser"
            notify "Downloading through Chrome…" "Direct download $DIRECT_PROBLEM"
            rm -f "$PDF_DIR/document.pdf" "$PDF_DIR/headers.txt"
            if ! browser_fetch "$TAB_URL" "$PDF_DIR/document.pdf" "$PDF_DIR/headers.txt"; then
                rm -rf "$OUT_DIR"
                fail "Could not get the PDF. Direct: $DIRECT_PROBLEM. Browser: $BROWSER_FETCH_ERROR"
            fi
            log "browser fetch ok"
        fi
        log "download ok: $(du -h "$PDF_DIR/document.pdf" | cut -f1)"

        # Filename: Content-Disposition → URL path → fallback
        PDF_NAME=$(python3 - "$PDF_DIR/headers.txt" "$TAB_URL" <<'PY'
import sys, re, email.message, urllib.parse as u
headers_path, url = sys.argv[1], sys.argv[2]
name = None
try:
    hdrs = open(headers_path, 'r', encoding='utf-8', errors='replace').read()
    # curl -D captures all hops; keep the last Content-Disposition seen
    matches = re.findall(r'(?im)^content-disposition:\s*(.+?)\s*$', hdrs)
    if matches:
        msg = email.message.Message()
        msg['content-disposition'] = matches[-1]
        name = msg.get_filename()
except Exception:
    pass
if not name:
    path = u.urlparse(url).path
    name = path.rsplit('/', 1)[-1] or ''
name = u.unquote(name or '').strip().replace('/', '_').replace('\\', '_').replace('\x00', '')
if not name.lower().endswith('.pdf'):
    name = (name + '.pdf') if name else 'document.pdf'
if name in ('.pdf', '.', '..'):
    name = 'document.pdf'
print(name)
PY
        )
        [[ -n "$PDF_NAME" ]] || PDF_NAME="document.pdf"
        OUT_NAME="${PDF_NAME%.*}.html"
        mv "$PDF_DIR/document.pdf" "$PDF_DIR/$PDF_NAME"
        log "resolved filename: $PDF_NAME"
    fi

else
    fail "Active tab is not a file:// or http(s):// PDF"
fi

# -----------------------------------------------------------------------------
# Convert if not cached. Native pdf2htmlEX is only invoked here, on a real
# cache miss.
# -----------------------------------------------------------------------------
DID_CONVERT=0
if [[ ! -f "$OUT_DIR/$OUT_NAME" ]]; then
    notify "Converting $PDF_NAME" "Cache miss — may take up to ~2 minutes"
    native_ready || fail "native pdf2htmlEX not installed — run scripts/install-native-pdf2htmlex.sh"
    log "convert start: $SOURCE_REF -> $OUT_DIR/$OUT_NAME"
    native_convert "$PDF_DIR/$PDF_NAME" "$OUT_DIR" \
        || fail "pdf2htmlEX conversion failed (see $LOG_FILE)"
    log "convert done: $OUT_NAME"
    DID_CONVERT=1
fi

# Title, favicon and overlay tags on the canonical HTML (fatal), then the
# light variant when missing or older than the canonical HTML (non-fatal).
# Every step is idempotent, so a cache hit refreshes injection too.
build_entry "$OUT_DIR" "$OUT_NAME" "$HASH" "${OUT_NAME%.html}" \
    || fail "overlay injection failed"
LIGHT_OUT_NAME="${OUT_NAME%.html}.light.html"

# Verify the daemon is up. launchd owns it (phase 5) — this script must NOT
# fall back to starting `python3 -m http.server`, because the daemon's GET /
# returns 404 (no route matches the root), which would trick the old
# fallback into spawning a second server on *:7435 that collides with the
# IPv4-only daemon socket and serves half the requests.
#
# We grep for {"status":"ok"} rather than just HTTP 200 so a rogue http.server
# on *:7435 (from the old buggy fallback) doesn't pass the check by accident
# if it ever happens to respond 200 on some path.
HEALTHZ_BODY=$(curl -sf "http://localhost:${PORT}/healthz" 2>/dev/null || true)
if [[ "$HEALTHZ_BODY" != *'"status":"ok"'* ]]; then
    if lsof -nP -iTCP:${PORT} -sTCP:LISTEN 2>/dev/null | grep -q 'http.server'; then
        fail "stray http.server on :${PORT} is blocking the daemon — kill it with 'pkill -f \"http.server ${PORT}\"'"
    fi
    fail "daemon unreachable on :${PORT} — check 'launchctl list | grep pdf_viewer'"
fi

NAV_NAME="$OUT_NAME"
if [[ "$LIGHT_VARIANTS_ENABLED" == "1" && -f "$OUT_DIR/$LIGHT_OUT_NAME" ]]; then
    NAV_NAME="$LIGHT_OUT_NAME"
fi
ENCODED_NAME=$(python3 -c "import sys, urllib.parse as u; print(u.quote(sys.argv[1]))" "$NAV_NAME")
URL="http://localhost:${PORT}/${HASH}/${ENCODED_NAME}"

upsert_mapping "$SOURCE_REF" "$HASH" "$OUT_DIR/$OUT_NAME" \
    || log "mapping update failed for $HASH"

# Navigate the *originating* tab in-place — extension-mediated so we don't
# pull Comet to the front. Post {from_url, to_url} to the daemon; the
# extension's long-poll picks it up and calls chrome.tabs.update(tabId, {url})
# which has no focus side effects.
#
# Compared to the AppleScript path we had before, this trades a sub-second
# focus flash for a ≤25s worst-case delay (the extension's long-poll horizon).
# Fire-and-forget; if the signal drops on the floor (daemon down, extension
# suspended and SW restart fails), the viewer is still in cache and the next
# click on the PDF link hits the static redirect rule.
#
# JSON built with python3 -c so URLs with shell-special chars can't break
# the request body (matches the url-encoding pattern used earlier in script).
NAV_PAYLOAD=$(python3 -c "import json, sys; print(json.dumps({'from_url': sys.argv[1], 'to_url': sys.argv[2]}))" "$TAB_URL" "$URL")
curl -sS --max-time 2 -X POST \
    -H 'Content-Type: application/json' \
    -d "$NAV_PAYLOAD" \
    "http://localhost:${PORT}/signal/navigate" \
    >/dev/null 2>&1 \
    || log "navigate signal POST failed (non-fatal)"

# Raycast HUD already fired when the wrapper exited; we're detached now,
# so the user needs a final macOS notification to know the tab has actually
# been swapped (especially for the 1-2min cache-miss case).
notify "Opened $PDF_NAME"

# Conversion provenance — pipeline-owned, written synchronously BEFORE the
# backgrounded meta/thumb jobs so it can't race the pdfinfo merge. Versions
# are parsed from the binary so reconversions after a toolchain upgrade stay
# accurate. Both writers merge into meta.json, so order is immaterial for
# correctness; doing it first just sidesteps a concurrent read-modify-write.
# Only on a real conversion — a cache hit keeps its original provenance.
if [[ "$DID_CONVERT" == "1" ]]; then
    write_provenance "$OUT_DIR" || log "provenance write failed for $PDF_NAME"
fi

# Meta + per-page thumbs run AFTER the tab-nav signal — both are non-critical
# (overlay falls back to empty meta and skeleton thumb cards), and on 100+
# page textbooks pdftocairo adds 5–15s that used to block the tab swap.
# Run them in parallel; `wait` at end keeps this process alive until they
# finish so log output stays coherent and no jobs get orphaned.
( ensure_meta "$PDF_DIR/$PDF_NAME" "$OUT_DIR" || log "meta extraction failed for $PDF_NAME" ) &
( ensure_thumbs "$PDF_DIR/$PDF_NAME" "$OUT_DIR" || log "thumb extraction failed for $PDF_NAME" ) &
wait

#!/usr/bin/env bash
# Sourced by regression/smoke wrappers. All writes and processes are scratch-owned.
start_overlay_scratch() {
    OVERLAY_TMP=$(mktemp -d "${TMPDIR:-/tmp}/pdfv-overlay.XXXXXX")
    OVERLAY_PID=''
    trap '[[ -z "$OVERLAY_PID" ]] || { kill "$OVERLAY_PID" 2>/dev/null || true; wait "$OVERLAY_PID" 2>/dev/null || true; }; rm -rf "$OVERLAY_TMP"' EXIT
    local port
    port=$(python3 - "${PDFV_PORT:-0}" <<'PY'
import socket,sys
s=socket.socket(); s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1); s.bind(('127.0.0.1',int(sys.argv[1]))); print(s.getsockname()[1]); s.close()
PY
    )
    export PDFV_BASE="http://127.0.0.1:$port"
    export PDF_VIEWER_CACHE_DIR="$OVERLAY_TMP/cache" PDFV_STATE_DB="$OVERLAY_TMP/state.db"
    mkdir -p "$PDF_VIEWER_CACHE_DIR"
    uv run --directory "$REPO_DIR/daemon" uvicorn main:app --host 127.0.0.1 --port "$port" >"$OVERLAY_TMP/daemon.log" 2>&1 &
    OVERLAY_PID=$!
    local ready=0
    for _ in {1..150}; do
        if curl -fsS "$PDFV_BASE/healthz" >/dev/null 2>&1; then ready=1; break; fi
        kill -0 "$OVERLAY_PID" 2>/dev/null || break
        sleep .2
    done
    [[ "$ready" = 1 ]] || { cat "$OVERLAY_TMP/daemon.log" >&2; return 1; }
}
make_overlay_fixture() {
    uv run --quiet --no-project --with reportlab python "$REPO_DIR/scripts/lib/overlay-fixture.py" "$OVERLAY_TMP/fixture.pdf" 'Overlay regression fixture' "${PDFV_FIXTURE_PAGES:-160}"
    OVERLAY_URL=$(curl -fsS -o /dev/null -w '%{redirect_url}' --get --data-urlencode "path=$OVERLAY_TMP/fixture.pdf" "$PDFV_BASE/read")
    # A second document, without an outline: quick open's previous document
    # and its page-list fallback (verify-overlay.cjs, group quickopen).
    uv run --quiet --no-project --with reportlab python "$REPO_DIR/scripts/lib/overlay-fixture.py" "$OVERLAY_TMP/plain.pdf" 'Plain fixture without outline' 24 none
    PDFV_OTHER_URL=$(curl -fsS -o /dev/null -w '%{redirect_url}' --get --data-urlencode "path=$OVERLAY_TMP/plain.pdf" "$PDFV_BASE/read")
    export PDFV_OTHER_URL
}

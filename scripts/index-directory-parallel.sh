#!/bin/bash

# ============================================================================
# pdf_viewer — bulk directory indexer.
#
# Usage: index-directory-parallel.sh <folder> [jobs]
#   jobs: number of concurrent conversions (default 2).
#
# Recursively finds every *.pdf under <folder> (via fd) and builds a cache
# entry for each, keyed by content hash. Idempotent: entries that already
# have HTML are only refreshed (mapping row, metadata, thumbnails), so a
# second run on the same folder converts nothing. index-directory.sh is the
# same indexer with one worker.
#
# Concurrency model:
#   - Each PDF is processed independently by a worker (xargs -P).
#   - Atomic claim via `mkdir "$out_dir/.converting"` prevents two workers from
#     racing on the same content hash (the same PDF under two filenames).
#   - mappings.tsv rewrites are serialized by the pipeline's mapping lock.
#   - Stale `.converting` dirs from killed runs are purged at startup.
#
# Job-count default: the native arm64 binary parallelizes internally (~6
# threads per conversion), so 2 workers keep total in-flight threads near a
# typical Apple Silicon core count while overlapping I/O-bound phases
# (hashing, injection, meta, thumbnails).
#
# Requires the native pdf2htmlEX binary (install-native-pdf2htmlex.sh).
# ============================================================================

set -u

# Defined before validation so failures surface as macOS notifications:
# Raycast silent mode doesn't display stderr.
notify() { osascript -e "display notification \"$1\" with title \"pdf_viewer\"" >/dev/null 2>&1; }

DIR_ARG="${1:-}"
JOBS="${2:-2}"

if [[ -z "$DIR_ARG" ]]; then
    notify "No folder argument given"
    echo "usage: $(basename "$0") <folder> [jobs]" >&2
    exit 2
fi
if ! [[ "$JOBS" =~ ^[0-9]+$ ]] || [[ "$JOBS" -lt 1 ]]; then
    notify "Invalid jobs value: $JOBS"
    echo "jobs must be a positive integer (got '$JOBS')" >&2
    exit 2
fi

# Expand leading ~ — Raycast passes the literal string, no shell expansion.
DIR="${DIR_ARG/#\~/$HOME}"
if [[ ! -d "$DIR" ]]; then
    notify "Folder not found: $DIR_ARG"
    echo "not a directory: $DIR" >&2
    exit 1
fi

# shellcheck source=lib/pipeline.sh
source "$(cd "$(dirname "$0")" && pwd)/lib/pipeline.sh"

say() { printf '%s\n' "$*"; log "$*"; }
die() { printf 'error: %s\n' "$*" >&2; log "FAIL: $*"; exit 1; }

ensure_asset_link || die "could not link assets dir"
FD=$(command -v fd || command -v fdfind || true)
[[ -n "$FD" ]] || die "fd not found — install via 'brew install fd'"
if ! native_ready; then
    notify "native pdf2htmlEX not installed"
    die "native pdf2htmlEX not installed — run scripts/install-native-pdf2htmlex.sh"
fi

# Resolve the overlay version once for every worker's provenance write.
PIPELINE_OVERLAY_VERSION="$(uv run "$INJECTOR" --print-version)"
# Each worker appends one outcome word per PDF; the summary counts them.
RUN_STATUS="$(mktemp -t pdfviewer-index)"
trap 'rm -f "$RUN_STATUS"' EXIT
export PIPELINE_OVERLAY_VERSION RUN_STATUS

# Purge stale .converting claim dirs left behind by killed runs (>30 min old).
find "$CACHE_DIR" -maxdepth 2 -type d -name .converting -mmin +30 -exec rmdir {} + 2>/dev/null

# ---------------------------------------------------------------------------
# Worker — one PDF. Runs in a fresh bash per xargs slot, so it re-sources
# the pipeline.
# ---------------------------------------------------------------------------
worker() {
    # shellcheck source=lib/pipeline.sh
    source "$PIPELINE_SH"
    local pdf="$1" outcome="skipped"
    [[ -f "$pdf" ]] || { log "[miss] $pdf"; echo missing >> "$RUN_STATUS"; return 0; }

    local pdf_name hash out_dir html title
    pdf_name=$(basename "$pdf")
    title="${pdf_name%.*}"
    hash=$(content_hash "$pdf")
    out_dir="$CACHE_DIR/$hash"
    mkdir -p "$out_dir"

    html=$(canonical_html "$out_dir")
    if [[ -z "$html" ]]; then
        if mkdir "$out_dir/.converting" 2>/dev/null; then
            log "[convert] $pdf"
            outcome="converted"
            if ! native_convert "$pdf" "$out_dir"; then
                log "[fail-pdf2htmlex] $pdf"
                outcome="failed"
            elif ! build_entry "$out_dir" "$title.html" "$hash" "$title"; then
                log "[fail-inject] $pdf"
                outcome="failed"
            else
                write_provenance "$out_dir" || log "[fail-provenance] $pdf"
            fi
            rmdir "$out_dir/.converting" 2>/dev/null
        else
            # Another worker owns this hash — wait up to 15 min for it.
            local waited=0
            while [[ -d "$out_dir/.converting" ]] && [[ $waited -lt 4500 ]]; do
                sleep 0.2
                waited=$((waited + 1))
            done
            log "[skip-peer] $pdf"
        fi
        html=$(canonical_html "$out_dir")
        if [[ -z "$html" ]]; then
            [[ "$outcome" == "failed" ]] || log "[fail-peer] $pdf (no HTML after conversion)"
            echo failed >> "$RUN_STATUS"
            return 1
        fi
    else
        log "[skip-cached] $pdf"
    fi

    # Non-critical extras, also backfilled for entries converted earlier.
    ensure_meta "$pdf" "$out_dir" || log "[fail-meta] $pdf"
    ensure_thumbs "$pdf" "$out_dir" || log "[fail-thumbs] $pdf"
    # Refreshed for cache hits too, so a moved PDF updates its source row.
    upsert_mapping "$pdf" "$hash" "$html" || { echo failed >> "$RUN_STATUS"; return 1; }
    echo "$outcome" >> "$RUN_STATUS"
    return 0
}
PIPELINE_SH="$PIPELINE_DIR/pipeline.sh"
export PIPELINE_SH
export -f worker

# ---------------------------------------------------------------------------
# Discover + dispatch.
# ---------------------------------------------------------------------------
total=$("$FD" -t f -e pdf -e PDF . "$DIR" 2>/dev/null | wc -l | tr -d ' ')
if [[ "$total" -eq 0 ]]; then
    say "index: no PDFs under $DIR"
    exit 0
fi

say "index: $total PDFs under $DIR (jobs=$JOBS)"
notify "Indexing $total PDFs…"
start_ts=$(date +%s)

# No -I: BSD xargs caps a replaced argument at 255 bytes and aborts the whole
# run on the first longer path. -n 1 appends the path as the worker's $1.
"$FD" -t f -e pdf -e PDF . "$DIR" -0 2>/dev/null \
    | xargs -0 -P "$JOBS" -n 1 bash -c 'worker "$@"' _

count() { grep -cx "$1" "$RUN_STATUS" 2>/dev/null || true; }
converted=$(count converted)
skipped=$(count skipped)
failed=$(count failed)
summary="index done in $DIR: $converted converted, $skipped skipped, $failed failed ($(( $(date +%s) - start_ts ))s)"
say "$summary"
notify "$summary"
exit $(( failed > 0 ? 1 : 0 ))

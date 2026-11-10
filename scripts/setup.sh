#!/bin/bash

# ============================================================================
# pdf_viewer — setup.sh
#
# Idempotent fresh-Mac bootstrap. One command stands the whole system up;
# two manual steps (Comet extension, Raycast script dir) it can't automate
# are printed at the end. Safe to re-run on an already-configured machine:
# every step is a no-op when its target is already correct (no duplicate
# launchd jobs, no clobbered symlinks, the running daemon is left untouched
# unless the plist content actually changed).
#
# The chain it wires (parent epic: pdfv-6el):
#   brew runtime deps → uv → native pdf2htmlEX toolchain →
#   templated launchd job (:7435) → cache dir + _assets symlink →
#   scripts/doctor.sh (the success gate).
#
# WHY templating the plist: launchd/com.anders.pdf_viewer.plist hardcodes
# /Users/andersbekkevard absolute paths. We keep the repo copy as the
# template SOURCE and generate ~/Library/LaunchAgents/<label>.plist with the
# current $HOME and repo path substituted, so the job is correct on any
# machine/user without editing the checked-in file.
#
# Usage:
#   ./scripts/setup.sh
#
# Env (test hooks — none mutate launchd unless you ask):
#   PDF_VIEWER_PLIST_OUT   write the generated plist to this path instead of
#                          ~/Library/LaunchAgents/<label>.plist, and SKIP the
#                          launchctl bootstrap/kickstart entirely. Lets you
#                          inspect the substitution result without touching
#                          the live job. Combine with HOME/REPO overrides.
#   PDF_VIEWER_REPO        override the repo dir baked into the plist
#                          (default: the repo this script lives in).
#   PDF_VIEWER_PORT        forwarded to scripts/doctor.sh (default 7435).
#
# This script installs MISSING brew formulas (that is the point of a
# bootstrap) but never UPGRADES existing ones, never auto-installs uv,
# never starts Docker, and never restarts a healthy daemon.
# ============================================================================

set -euo pipefail

# --- paths -------------------------------------------------------------------

REPO_DIR="${PDF_VIEWER_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
BREWFILE="$REPO_DIR/Brewfile"
REPO_ASSETS="$REPO_DIR/assets"

LAUNCHD_LABEL="com.anders.pdf_viewer"
PLIST_TEMPLATE="$REPO_DIR/launchd/${LAUNCHD_LABEL}.plist"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
PLIST_DEST="${PDF_VIEWER_PLIST_OUT:-$LAUNCH_AGENTS_DIR/${LAUNCHD_LABEL}.plist}"

CACHE_DIR="$HOME/.cache/pdf_viewer"
ASSET_LINK="$CACHE_DIR/_assets"

NATIVE_PREFIX="$HOME/.local/opt/pdf2htmlEX"
NATIVE_BIN="$NATIVE_PREFIX/bin/pdf2htmlEX"
INSTALL_TOOLCHAIN="$REPO_DIR/scripts/install-native-pdf2htmlex.sh"
DOCTOR="$REPO_DIR/scripts/doctor.sh"

# Original hardcoded values in the repo plist — what we substitute OUT.
TEMPLATE_HOME="/Users/andersbekkevard"
TEMPLATE_REPO="/Users/andersbekkevard/dev/misc/pdf_viewer"

# --- output helpers ----------------------------------------------------------

if [ -t 1 ]; then
    C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_STEP=$'\033[36m'; C_OFF=$'\033[0m'
else
    C_OK=''; C_WARN=''; C_STEP=''; C_OFF=''
fi

step() { printf '\n%s==>%s %s\n' "$C_STEP" "$C_OFF" "$*"; }
ok()   { printf '%s  ok%s %s\n'  "$C_OK"   "$C_OFF" "$*"; }
note() { printf '     %s\n' "$*"; }
warn() { printf '%swarn%s %s\n'  "$C_WARN" "$C_OFF" "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

# ----------------------------------------------------------------------------
# plist templating — substitute the hardcoded absolute paths with the live
# $HOME and repo dir. Pure substitution; the repo plist stays the template.
# Kept as a standalone function so it can be unit-tested via PDF_VIEWER_PLIST_OUT.
# ----------------------------------------------------------------------------

render_plist() {
    # render_plist <template> <home> <repo>  -> renders to stdout
    local template="$1" home="$2" repo="$3"
    # Order matters: replace the longer repo path first so it isn't partially
    # rewritten by the HOME substitution (repo path begins with HOME).
    sed -e "s#${TEMPLATE_REPO}#${repo}#g" \
        -e "s#${TEMPLATE_HOME}#${home}#g" \
        "$template"
}

# ============================================================================
# 0. Preconditions
# ============================================================================

[ -f "$BREWFILE" ]          || die "Brewfile not found: $BREWFILE"
[ -f "$PLIST_TEMPLATE" ]    || die "plist template not found: $PLIST_TEMPLATE"
[ -x "$INSTALL_TOOLCHAIN" ] || die "toolchain installer not found/executable: $INSTALL_TOOLCHAIN"
[ -x "$DOCTOR" ]            || die "doctor not found/executable: $DOCTOR"
[ -d "$REPO_ASSETS" ]      || die "repo assets dir not found: $REPO_ASSETS"

# ============================================================================
# 1. Homebrew runtime deps + uv
# ============================================================================

step "Homebrew runtime dependencies ($BREWFILE)"
if ! command -v brew >/dev/null 2>&1; then
    die "Homebrew not installed. Install it first:
       /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
fi
if brew bundle check --no-upgrade --file="$BREWFILE" >/dev/null 2>&1; then
    ok "all Brewfile formulas already present (no upgrade)"
else
    note "missing formulas — installing (no upgrade of existing ones)…"
    brew bundle --no-upgrade --file="$BREWFILE"
    ok "Brewfile satisfied"
fi

step "uv (Python runner)"
if command -v uv >/dev/null 2>&1; then
    ok "uv present: $(command -v uv)"
else
    warn "uv not found — this repo needs it for the daemon and Python scripts."
    note "Install it (NOT auto-installed by setup) with either:"
    note "  curl -LsSf https://astral.sh/uv/install.sh | sh"
    note "  brew install uv"
    die "install uv, then re-run ./scripts/setup.sh"
fi

# ============================================================================
# 2. Native pdf2htmlEX toolchain
# ============================================================================

step "Native pdf2htmlEX toolchain ($NATIVE_BIN)"
toolchain_ok=0
native_ver=""
if [ -x "$NATIVE_BIN" ]; then
    # Capture to a var (not a head|grep pipeline): under `set -o pipefail` the
    # SIGPIPE from an early-closing `head` can race the binary's multi-line
    # --version output and spuriously fail the check, forcing a needless
    # reinstall on an already-healthy machine.
    native_ver="$("$NATIVE_BIN" --version 2>&1 || true)"
    case "$native_ver" in
        *"pdf2htmlEX version"*) toolchain_ok=1 ;;
    esac
fi
if [ "$toolchain_ok" -eq 1 ]; then
    ok "pdf2htmlEX already installed: $(printf '%s\n' "$native_ver" | head -1)"
else
    note "binary missing or unhealthy — running install-native-pdf2htmlex.sh…"
    if "$INSTALL_TOOLCHAIN"; then
        ok "toolchain installed"
    else
        die "toolchain install failed. If no local build tree exists, install the tap and re-run:
       brew tap andersbekkevard/tools && brew install pdf2htmlex
       ./scripts/setup.sh"
    fi
fi

# ============================================================================
# 3. launchd job — templated plist, idempotent load
# ============================================================================

step "launchd job ($LAUNCHD_LABEL)"

DESIRED_PLIST="$(render_plist "$PLIST_TEMPLATE" "$HOME" "$REPO_DIR")"

if [ -n "${PDF_VIEWER_PLIST_OUT:-}" ]; then
    # Test mode: write the rendered plist where asked and stop — never touch
    # the live launchd job from a test render.
    mkdir -p "$(dirname "$PLIST_DEST")"
    printf '%s\n' "$DESIRED_PLIST" > "$PLIST_DEST"
    ok "rendered plist written to $PLIST_DEST (test mode — launchd NOT modified)"
else
    mkdir -p "$LAUNCH_AGENTS_DIR"

    # Compare desired content against whatever is installed (a templated copy
    # OR a symlink to the repo template — we compare resolved CONTENT, not the
    # file type, so an equivalent symlink is treated as up-to-date and the
    # healthy daemon is never disturbed).
    plist_changed=1
    if [ -e "$PLIST_DEST" ]; then
        if diff -q <(printf '%s\n' "$DESIRED_PLIST") "$PLIST_DEST" >/dev/null 2>&1; then
            plist_changed=0
        fi
    fi

    if [ "$plist_changed" -eq 1 ]; then
        # An older install symlinked the repo template here; writing through
        # that link would overwrite the checked-in template.
        [ -L "$PLIST_DEST" ] && rm -f "$PLIST_DEST"
        printf '%s\n' "$DESIRED_PLIST" > "$PLIST_DEST"
        ok "wrote templated plist → $PLIST_DEST"
    else
        ok "plist already up to date (content matches templated output)"
    fi

    # Is the job currently bootstrapped?
    job_loaded=0
    if launchctl print "gui/$(id -u)/${LAUNCHD_LABEL}" >/dev/null 2>&1; then
        job_loaded=1
    fi

    if [ "$job_loaded" -eq 1 ] && [ "$plist_changed" -eq 0 ]; then
        ok "job already loaded and plist unchanged — leaving it alone"
    elif [ "$job_loaded" -eq 1 ] && [ "$plist_changed" -eq 1 ]; then
        note "plist changed — reloading job (bootout + bootstrap)…"
        launchctl bootout "gui/$(id -u)/${LAUNCHD_LABEL}" >/dev/null 2>&1 || true
        launchctl bootstrap "gui/$(id -u)" "$PLIST_DEST"
        launchctl kickstart -k "gui/$(id -u)/${LAUNCHD_LABEL}" >/dev/null 2>&1 || true
        ok "job reloaded"
    else
        note "job not loaded — bootstrapping…"
        launchctl bootstrap "gui/$(id -u)" "$PLIST_DEST"
        launchctl enable "gui/$(id -u)/${LAUNCHD_LABEL}" >/dev/null 2>&1 || true
        launchctl kickstart "gui/$(id -u)/${LAUNCHD_LABEL}" >/dev/null 2>&1 || true
        ok "job bootstrapped + enabled"
    fi
fi

# ============================================================================
# 4. Cache dir + _assets symlink
# ============================================================================

step "Cache dir + _assets symlink"
mkdir -p "$CACHE_DIR"
ok "cache dir present: $CACHE_DIR"

repo_assets_real="$( (cd "$REPO_ASSETS" && pwd -P) )"
link_ok=0
if [ -L "$ASSET_LINK" ]; then
    resolved="$( (cd "$ASSET_LINK" && pwd -P) 2>/dev/null || true)"
    [ -n "$resolved" ] && [ "$resolved" = "$repo_assets_real" ] && link_ok=1
fi

if [ "$link_ok" -eq 1 ]; then
    ok "_assets symlink already correct → $repo_assets_real (untouched)"
elif [ -e "$ASSET_LINK" ] || [ -L "$ASSET_LINK" ]; then
    # Wrong target (or a non-symlink in the way) — replace it.
    note "_assets present but wrong target — replacing…"
    rm -rf "$ASSET_LINK"
    ln -s "$REPO_ASSETS" "$ASSET_LINK"
    ok "_assets symlink → $REPO_ASSETS"
else
    ln -s "$REPO_ASSETS" "$ASSET_LINK"
    ok "_assets symlink created → $REPO_ASSETS"
fi

# ============================================================================
# 5. Success gate — doctor.sh
# ============================================================================

step "Running doctor.sh (success gate)"
if [ -n "${PDF_VIEWER_PLIST_OUT:-}" ]; then
    ok "test render mode — skipping doctor gate"
    exit 0
fi

set +e
"$DOCTOR"
doctor_rc=$?
set -e

echo
if [ "$doctor_rc" -ne 0 ]; then
    warn "doctor reported failures (exit $doctor_rc) — fix the ↳ hints above and re-run."
    exit "$doctor_rc"
fi

# ============================================================================
# 6. Manual steps doctor can't automate
# ============================================================================

cat <<EOF

${C_OK}setup: OK${C_OFF} — daemon, toolchain, launchd job, and cache are all green.

Two manual steps remain (one-time, can't be scripted):

  1. Comet extension — load it unpacked:
       comet://extensions → enable Developer mode → Load unpacked →
       point at: $REPO_DIR/extension/

  2. Raycast script directory — add the entrypoints:
       Raycast → Settings → Extensions → Script Commands →
       Add script directory → pick: $REPO_DIR/raycast/

(Optional) Vimium pass-through keys for localhost:7435 — see README "Externalities".
EOF

exit 0

#!/usr/bin/env bash
#
# smoke-viewer.sh — overlay smoke test. The standard pre-close check for
# overlay beads (see docs/verification.md): the smoke group of
# verify-overlay.sh on a one-page fixture, in headless Chromium against a
# scratch daemon. Exits non-zero on any failure.
set -euo pipefail
[[ "${1:-}" != --reader ]] || shift   # the old flag; the reader is the only engine
export PDFV_FIXTURE_PAGES=1
exec "$(cd "$(dirname "$0")" && pwd)/verify-overlay.sh" --only smoke "$@"

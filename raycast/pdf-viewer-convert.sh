#!/bin/bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title PDF viewer: open in reader
# @raycast.mode silent

# Optional parameters:
# @raycast.icon 📑
# @raycast.description Open the active Chrome tab's PDF in the pdf_viewer reader

# Thin entrypoint — the logic lives in pdf_viewer/scripts/ so it can be
# edited and tested outside of Raycast's conventions. The file keeps its old
# name so the Raycast hotkey bound to it survives.
#
# Silent mode shows stderr as a macOS notification, so the real script runs
# in the background with its output in the log.

mkdir -p "$HOME/.cache/pdf_viewer"
nohup /Users/andersbekkevard/dev/misc/pdf_viewer/scripts/open-in-reader.sh "$@" \
    >>"$HOME/.cache/pdf_viewer/log" 2>&1 &
disown
echo "opening in the reader…"

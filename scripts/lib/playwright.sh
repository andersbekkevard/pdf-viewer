# shellcheck shell=bash
# Sourced, never executed. Locates a cached Playwright install for the viewer
# checks. Runs under macOS system bash 3.2 (no bash 4 features).

resolve_playwright() {
    PW_NODE_PATH="$HOME/.npm/_npx/705bc6b22212b352/node_modules"
    if NODE_PATH="$PW_NODE_PATH" node -e "require.resolve('playwright')" >/dev/null 2>&1; then
        return 0
    fi

    local found
    found=$(find "$HOME/.npm/_npx" "$HOME/Library/Caches" -maxdepth 6 \
        -type d -name playwright -path '*/node_modules/playwright' 2>/dev/null | head -1)
    if [[ -z "$found" ]]; then
        echo "$(basename "$0"): no local Playwright found; do not install it for this check" >&2
        return 2
    fi

    PW_NODE_PATH="$(dirname "$found")"
    if ! NODE_PATH="$PW_NODE_PATH" node -e "require.resolve('playwright')" >/dev/null 2>&1; then
        echo "$(basename "$0"): no local Playwright found; do not install it for this check" >&2
        return 2
    fi
    return 0
}

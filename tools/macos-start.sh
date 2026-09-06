#!/bin/bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "$(uname -s)" != Darwin ]]; then
    printf '%s\n' 'Run this launcher in Terminal on the Mac.' >&2
    exit 1
fi
if [[ ! -x build-macos/app/scrcpy || ! -f gui/dist/index.html || ! -f build-macos/server/reverse-display.apk ]]; then
    printf '%s\n' 'Build the complete bundle first: bash tools/macos-build.sh' >&2
    exit 1
fi
export SCRCPY_GUI_BINARY="$PWD/build-macos/app/scrcpy"
export SCRCPY_REVERSE_DISPLAY_APK="$PWD/build-macos/server/reverse-display.apk"
export SCRCPY_ICON_DIR="$PWD/app/data"
export TAILSCALE_BE_CLI=1
export DISPLAY_BRIDGE_PORT=27183
if command -v adb >/dev/null 2>&1; then
    export ADB="$(command -v adb)"
else
    printf '%s\n' 'ADB is missing. USB/Wi-Fi/IP need: brew install --cask android-platform-tools'
    printf '%s\n' 'Internet mode can run without ADB if the phone app is installed separately.'
fi
printf '%s\n' 'Open http://127.0.0.1:27183 on THIS MAC. Keep this Terminal open.'
printf '%s\n' 'Allow Screen Recording and Accessibility when asked; restart this launcher after granting them.'
printf '%s\n' 'Stop streaming in the dashboard before pressing Control-C to exit.'
exec node gui/server/index.mjs

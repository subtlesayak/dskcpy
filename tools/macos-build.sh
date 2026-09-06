#!/bin/bash
# Build locally on the Mac. No Codex, Android SDK build, sudo or upload is used.
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "$(uname -s)" != Darwin ]]; then
    printf '%s\n' 'Run this script in Terminal on the Mac, not on Windows.' >&2
    exit 1
fi
if [[ "$(uname -m)" != arm64 ]]; then
    printf '%s\n' 'This first test bundle targets Apple silicon. Use a native Terminal, not Rosetta.' >&2
    exit 1
fi
version="$(sw_vers -productVersion)"
if (( ${version%%.*} < 13 )); then
    printf '%s\n' 'The experimental host requires macOS 13 or later.' >&2
    exit 1
fi
if ! xcrun --find clang >/dev/null 2>&1; then
    printf '%s\n' 'Install Apple Command Line Tools: xcode-select --install. Then run this script again.' >&2
    exit 1
fi
for tool in meson ninja pkg-config node npm; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        printf '%s\n' 'Install the build dependencies first: brew install ffmpeg sdl3 meson ninja pkgconf node' >&2
        exit 1
    fi
done
node -e 'const [a,b]=process.versions.node.split(".").map(Number); if (a<22 || (a===22 && b<12)) { console.error("Use Node 22.12 or newer."); process.exit(1); }'
pkg-config --exists libavformat libavcodec libavutil libswresample 'sdl3 >= 3.2.0' || {
    printf '%s\n' 'Missing native libraries. Run: brew install ffmpeg sdl3 pkgconf' >&2
    exit 1
}

apk=companion/reverse-display.apk
if [[ ! -f "$apk" ]]; then
    apk=server/build/outputs/apk/debug/server-debug.apk
fi
if [[ ! -f "$apk" ]]; then
    printf '%s\n' 'Missing companion APK. Use the complete dskcpy Mac source bundle.' >&2
    exit 1
fi
if [[ -f SHA256SUMS ]]; then
    shasum -a 256 -c SHA256SUMS >/dev/null
fi

printf '%s\n' 'Building EXPERIMENTAL Mac host (video and mouse/scroll; no Mac audio forwarding).'
# -Dusb=false disables upstream HID/OTG, NOT Android ADB USB streaming.
setup=(build-macos -Dcompile_server=false -Dreverse_macos=true -Dusb=false
    -Dbuildtype=debug -Db_lto=false -Dstrip=false)
if [[ -f build-macos/meson-private/coredata.dat ]]; then
    meson setup --reconfigure "${setup[@]}"
else
    meson setup "${setup[@]}"
fi
meson compile -C build-macos
meson test -C build-macos --print-errorlogs
mkdir -p build-macos/server
cp "$apk" build-macos/server/reverse-display.apk
# Reverse mode needs the APK, not the upstream scrcpy-server JAR.
help_output="$(build-macos/app/scrcpy --help)"
if [[ "$help_output" != *'ScreenCaptureKit/VideoToolbox'* ]]; then
    printf '%s\n' 'The built binary does not advertise the experimental Mac backend.' >&2
    exit 1
fi
(
    cd gui
    npm ci --no-audit --no-fund
    npm test
    npm run build
)
printf '%s\n' 'Build and local tests passed. Next: bash tools/macos-start.sh'

#!/usr/bin/env bash
# Separate unsigned, unpublished Apple-silicon hosting candidate. Does not touch
# the inherited Mac client target, installed app, or any running service.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"
if [[ $# != 1 || "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
    echo 'Usage (on Apple silicon): release/build_macos_host.sh NEW_OUTPUT_DIRECTORY' >&2; exit 1
fi
OUTPUT=$(node -e 'console.log(require("node:path").resolve(process.argv[1]))' "$1")
[[ ! -e "$OUTPUT" ]] || { echo 'Output exists; choose a new directory.' >&2; exit 1; }
BUILD="$OUTPUT.build"
[[ ! -e "$BUILD" ]] || { echo 'Build directory exists; choose a new output directory.' >&2; exit 1; }
for tool in cmake meson ninja pkg-config wget nasm node npm; do command -v "$tool" >/dev/null; done
export MACOSX_DEPLOYMENT_TARGET=13.0 DSKCPY_MAC_HOST_BUILD=1
export PKG_CONFIG_LIBDIR="$ROOT/app/deps/work/install/macos-host13-native-static/lib/pkgconfig"
unset PKG_CONFIG_PATH
export CFLAGS='-O2 -mmacosx-version-min=13.0' CXXFLAGS='-O2 -mmacosx-version-min=13.0'
export LDFLAGS='-mmacosx-version-min=13.0'
bash app/deps/sdl.sh macos native static
bash app/deps/dav1d.sh macos native static
bash app/deps/opus.sh macos native static
bash app/deps/ffmpeg.sh macos native static
bash app/deps/adb_macos.sh
DEPS="$ROOT/app/deps/work/install/macos-host13-native-static"
meson setup "$BUILD" --buildtype=release -Dcompile_server=false -Dreverse_macos=true \
    -Dusb=false -Dportable=true -Dstatic=true \
    -Dc_args="-I$DEPS/include -mmacosx-version-min=13.0" \
    -Dc_link_args="-L$DEPS/lib -mmacosx-version-min=13.0"
meson compile -C "$BUILD"
meson test -C "$BUILD" --print-errorlogs
"$BUILD/app/scrcpy" --help | grep -F 'ScreenCaptureKit/VideoToolbox'
npm ci --prefix gui
npm run build --prefix gui
node release/package_macos_host.mjs "$BUILD/app/scrcpy" "$ROOT/app/deps/work/install/adb-macos/adb" "$OUTPUT"
echo 'Unsigned hosting candidate verified and packaged. Clean macOS 13 and physical media qualification remain required; nothing was signed, installed or published.'

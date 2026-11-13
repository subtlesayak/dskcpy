#!/usr/bin/env bash
# Separate unsigned, unpublished native Mac hosting candidate. Does not touch
# the inherited Mac client target, installed app, or any running service.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"
if [[ $# != 1 || "$(uname -s)" != Darwin ]]; then
    echo 'Usage (on native macOS): release/build_macos_host.sh NEW_OUTPUT_DIRECTORY' >&2; exit 1
fi
export DSKCPY_MAC_HOST_ARCH="${DSKCPY_MAC_HOST_ARCH:-$(uname -m)}"
case "$DSKCPY_MAC_HOST_ARCH" in
    arm64) DSKCPY_NODE_ARCH=arm64 ;;
    x86_64) DSKCPY_NODE_ARCH=x64 ;;
    *) echo 'Unsupported Mac hosting architecture.' >&2; exit 1 ;;
esac
if [[ "$DSKCPY_MAC_HOST_ARCH" != "$(uname -m)" || "$(node -p process.arch)" != "$DSKCPY_NODE_ARCH" ]]; then
    echo 'Use native Node and build tools matching this Mac architecture; cross/Rosetta packaging is not supported.' >&2; exit 1
fi
OUTPUT=$(node -e 'console.log(require("node:path").resolve(process.argv[1]))' "$1")
[[ ! -e "$OUTPUT" ]] || { echo 'Output exists; choose a new directory.' >&2; exit 1; }
BUILD="$OUTPUT.build"
[[ ! -e "$BUILD" ]] || { echo 'Build directory exists; choose a new output directory.' >&2; exit 1; }
TEST_BUILD="$OUTPUT.tests"
[[ ! -e "$TEST_BUILD" ]] || { echo 'Test directory exists; choose a new output directory.' >&2; exit 1; }
for tool in cmake meson ninja pkg-config curl nasm node npm; do command -v "$tool" >/dev/null; done
export MACOSX_DEPLOYMENT_TARGET=13.0 DSKCPY_MAC_HOST_BUILD=1
export DSKCPY_BUILD_JOBS="${DSKCPY_BUILD_JOBS:-2}"
[[ "$DSKCPY_BUILD_JOBS" =~ ^([1-9]|[12][0-9]|3[0-2])$ ]] || { echo 'DSKCPY_BUILD_JOBS must be 1..32.' >&2; exit 1; }
export PKG_CONFIG_LIBDIR="$ROOT/app/deps/work/install/macos-host13-$DSKCPY_MAC_HOST_ARCH-native-static/lib/pkgconfig"
unset PKG_CONFIG_PATH
export CFLAGS="-O2 -arch $DSKCPY_MAC_HOST_ARCH -mmacosx-version-min=13.0" CXXFLAGS="-O2 -arch $DSKCPY_MAC_HOST_ARCH -mmacosx-version-min=13.0"
export LDFLAGS="-arch $DSKCPY_MAC_HOST_ARCH -mmacosx-version-min=13.0"
bash app/deps/sdl.sh macos native static
bash app/deps/dav1d.sh macos native static
bash app/deps/opus.sh macos native static
bash app/deps/ffmpeg.sh macos native static
bash app/deps/adb_macos.sh
DEPS="$ROOT/app/deps/work/install/macos-host13-$DSKCPY_MAC_HOST_ARCH-native-static"
C_ARGS=$(node -e 'console.log(JSON.stringify(process.argv.slice(1)))' -- "-I$DEPS/include" -arch "$DSKCPY_MAC_HOST_ARCH" -mmacosx-version-min=13.0)
LINK_ARGS=$(node -e 'console.log(JSON.stringify(process.argv.slice(1)))' -- "-L$DEPS/lib" -arch "$DSKCPY_MAC_HOST_ARCH" -mmacosx-version-min=13.0)
meson setup "$BUILD" --buildtype=release -Dcompile_server=false -Dreverse_macos=true \
    -Dusb=false -Dportable=true -Dstatic=true \
    -Dc_args="$C_ARGS" \
    -Dc_link_args="$LINK_ARGS"
meson compile -C "$BUILD" -j "$DSKCPY_BUILD_JOBS"
# The inherited Meson project deliberately omits assertion tests in release.
# Exercise the same isolated static dependencies in a separate debug build.
meson setup "$TEST_BUILD" --buildtype=debug -Dcompile_server=false -Dreverse_macos=true \
    -Dusb=false -Dportable=true -Dstatic=true \
    -Dc_args="$C_ARGS" \
    -Dc_link_args="$LINK_ARGS"
meson compile -C "$TEST_BUILD" -j "$DSKCPY_BUILD_JOBS"
meson test -C "$TEST_BUILD" --print-errorlogs
"$BUILD/app/scrcpy" --help | grep -F 'ScreenCaptureKit/VideoToolbox'
npm ci --prefix gui
npm run build --prefix gui
node release/package_macos_host.mjs "$BUILD/app/scrcpy" "$ROOT/app/deps/work/install/adb-macos/adb" "$OUTPUT"
echo 'Unsigned hosting candidate verified and packaged. Clean macOS 13 and physical media qualification remain required; nothing was signed, installed or published.'

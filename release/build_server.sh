#!/bin/bash
set -ex
cd "$(dirname "${BASH_SOURCE[0]}")"
. build_common
cd .. # root project dir

GRADLE="${GRADLE:-./gradlew}"
SERVER_BUILD_DIR="$WORK_DIR/build-server"

"$GRADLE" -p server assembleRelease assembleDebug
mkdir -p "$SERVER_BUILD_DIR/server"
cp server/build/outputs/apk/release/server-release-unsigned.apk \
    "$SERVER_BUILD_DIR/server/scrcpy-server"
cp server/build/outputs/apk/debug/server-debug.apk \
    "$SERVER_BUILD_DIR/server/reverse-display.apk"

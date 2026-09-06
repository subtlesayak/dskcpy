#!/usr/bin/env bash
# Run with the release build's isolated PKG_CONFIG_LIBDIR.
set -eu
cd "$(dirname "${BASH_SOURCE[0]}")/.."
printf 'dskcpy Windows release dependency sources (version and SHA-256)\n'
for dep in sdl ffmpeg libusb dav1d adb_windows; do
    version=$(sed -n 's/^VERSION=//p' "app/deps/$dep.sh" | tr -d '\r')
    digest=$(sed -n 's/^SHA256SUM=//p' "app/deps/$dep.sh" | tr -d '\r')
    test -n "$version" && test -n "$digest"
    printf '%s %s %s\n' "$dep" "$version" "$digest"
done
printf '\nLinked library versions\n'
for lib in sdl3 libavcodec libavformat libavutil libswresample libusb-1.0; do
    linked_version=$(pkg-config --modversion "$lib")
    printf '%s %s\n' "$lib" "$linked_version"
done

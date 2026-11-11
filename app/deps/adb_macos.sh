#!/usr/bin/env bash
set -ex
. $(dirname ${BASH_SOURCE[0]})/_init "$@"

VERSION=37.0.0
URL="https://dl.google.com/android/repository/platform-tools_r$VERSION-darwin.zip"
SHA256SUM=094a1395683c509fd4d48667da0d8b5ef4d42b2abfcd29f2e8149e2f989357c7

PROJECT_DIR="platform-tools-$VERSION-darwin"
FILENAME="$PROJECT_DIR.zip"

cd "$SOURCES_DIR"

if [[ -d "$PROJECT_DIR" ]]
then
    echo "$PWD/$PROJECT_DIR" found
else
    get_file "$URL" "$FILENAME" "$SHA256SUM"
    mkdir -p "$PROJECT_DIR"
    cd "$PROJECT_DIR"
    ZIP_PREFIX=platform-tools
    unzip "../$FILENAME" "$ZIP_PREFIX"/adb "$ZIP_PREFIX"/NOTICE.txt
    mv "$ZIP_PREFIX"/* .
    rmdir "$ZIP_PREFIX"
fi

# Older cached extractions predate license packaging. Verify the original ZIP
# before adding its notice; leave the existing executable untouched.
if [[ ! -f "$SOURCES_DIR/$PROJECT_DIR/NOTICE.txt" ]]; then
    cd "$SOURCES_DIR"
    get_file "$URL" "$FILENAME" "$SHA256SUM"
    unzip -p "$FILENAME" platform-tools/NOTICE.txt > "$PROJECT_DIR/NOTICE.txt"
fi

mkdir -p "$INSTALL_DIR/adb-macos"
cd "$INSTALL_DIR/adb-macos"
cp -r "$SOURCES_DIR/$PROJECT_DIR"/. "$INSTALL_DIR/adb-macos/"

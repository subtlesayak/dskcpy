#!/usr/bin/env bash
set -ex
. $(dirname ${BASH_SOURCE[0]})/_init "$@"

VERSION=37.0.0
URL="https://dl.google.com/android/repository/platform-tools_r$VERSION-win.zip"
SHA256SUM=4fe305812db074cea32903a489d061eb4454cbc90a49e8fea677f4b7af764918

PROJECT_DIR="platform-tools-$VERSION-windows"
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
    unzip "../$FILENAME" \
        "$ZIP_PREFIX"/AdbWinApi.dll \
        "$ZIP_PREFIX"/AdbWinUsbApi.dll \
        "$ZIP_PREFIX"/adb.exe \
        "$ZIP_PREFIX"/NOTICE.txt
    mv "$ZIP_PREFIX"/* .
    rmdir "$ZIP_PREFIX"
fi

# Retain cached binaries while adding the notice from the verified archive.
if [[ ! -f "$SOURCES_DIR/$PROJECT_DIR/NOTICE.txt" ]]; then
    cd "$SOURCES_DIR"
    get_file "$URL" "$FILENAME" "$SHA256SUM"
    unzip -p "$FILENAME" platform-tools/NOTICE.txt > "$PROJECT_DIR/NOTICE.txt"
fi

mkdir -p "$INSTALL_DIR/adb-windows"
cd "$INSTALL_DIR/adb-windows"
cp -r "$SOURCES_DIR/$PROJECT_DIR"/. "$INSTALL_DIR/adb-windows/"

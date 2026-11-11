#!/usr/bin/env bash
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/_init"
process_args "$@"
[[ "${DSKCPY_MAC_HOST_BUILD:-0}" == 1 ]] || { echo 'This dependency is for the isolated Mac hosting target.' >&2; exit 1; }

# Official release/checksum: https://opus-codec.org/downloads/
VERSION=1.6.1
URL="https://downloads.xiph.org/releases/opus/opus-$VERSION.tar.gz"
SHA256SUM=6ffcb593207be92584df15b32466ed64bbec99109f007c82205f0194572411a1
cd "$SOURCES_DIR"
get_file "$URL" "opus-$VERSION.tar.gz" "$SHA256SUM"
if [[ ! -d "opus-$VERSION" ]]; then tar xf "opus-$VERSION.tar.gz"; fi
mkdir -p "$BUILD_DIR/opus-$VERSION/$DIRNAME"
cd "$BUILD_DIR/opus-$VERSION/$DIRNAME"
if [[ ! -f Makefile ]]; then
    "$SOURCES_DIR/opus-$VERSION/configure" --prefix="$INSTALL_DIR/$DIRNAME" \
        --enable-static --disable-shared --disable-doc --disable-extra-programs
fi
make -j"${DSKCPY_BUILD_JOBS:-2}"
make install

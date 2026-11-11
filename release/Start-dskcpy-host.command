#!/bin/bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
export SCRCPY_GUI_BINARY="$ROOT/bin/scrcpy"
export SCRCPY_ICON_DIR="$ROOT/bin"
export ADB="${ADB:-$ROOT/bin/adb}"
exec node "$ROOT/gui/scripts/launch.mjs" "$@"

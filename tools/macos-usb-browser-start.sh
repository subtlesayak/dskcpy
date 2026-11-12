#!/bin/bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if [[ -z "${SCRCPY_GUI_BINARY:-}" ]]; then
  for candidate in build-macos-features/app/scrcpy build-macos/app/scrcpy; do
    if [[ -x "$candidate" ]]; then export SCRCPY_GUI_BINARY="$PWD/$candidate"; break; fi
  done
fi
if [[ ! -x "${SCRCPY_GUI_BINARY:-}" || ! -f gui/dist/index.html ]]; then
  echo "Build the Mac host and GUI before starting USB browser sharing."
  exit 1
fi
export SCRCPY_ICON_DIR="$PWD/app/data"
export DISPLAY_BRIDGE_PORT="${DISPLAY_BRIDGE_PORT:-27203}"
export DSKCPY_VIEWER_PORT="${DSKCPY_VIEWER_PORT:-27200}"
export DSKCPY_VIEWER_RTC_BIND=127.0.0.1
unset DSKCPY_VIEWER_ORIGIN DSKCPY_VIEWER_TLS_BIND DSKCPY_VIEWER_TLS_PORT DSKCPY_VIEWER_TLS_CERT DSKCPY_VIEWER_TLS_KEY
echo "Open the Mac dashboard and choose Browser receiver → USB cable."
echo "Connect and unlock Android, allow USB debugging, then select Open on phone. No QR is needed."
echo "The receiver uses a private ADB USB tunnel; no VPN or phone app is required."
echo "Keep this Terminal open."
exec node gui/scripts/launch.mjs --no-open --no-reuse

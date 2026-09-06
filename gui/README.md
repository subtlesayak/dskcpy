# dskcpy GUI

dskcpy is a local control surface for the reverse-display fork. The
React UI currently runs as a localhost web app:

- setup, diagnostics, and command generation in a browser;
- a packaged Tauri desktop wrapper remains a future option, not an implemented shell.

The control service binds to `127.0.0.1` only. It validates a small typed
configuration and launches scrcpy with an argument array (never through a
shell), so the browser cannot execute arbitrary commands.

## Wireless discovery and recovery

In **Wi-Fi** or **Connect IP**, choose **Discover wireless devices**. The service
reads `adb mdns services` with a five-second timeout. It displays private/link-local
IPv4 advertisements only; it does not scan a subnet or start capture. Use a
pairing result to fill the pairing form, then enter the six-digit phone code.
Use a connection result to select its separate connection port. If no service
is advertised, enable Wireless debugging and discover again or enter the IP
manually. IPv6 discovery is not supported by this flow.

**Reconnect automatically** is off by default. For USB, Wi-Fi and direct IP,
it retries an unexpected disconnect or a native stalled-stream error up to
three times, waiting 1.5, 3 and 4.5 seconds before successive attempts. The
budget applies to the entire session until the next manual Start; successful
process creation does not reset it. USB/Wi-Fi retries keep the selected device
identifier and cannot silently choose a different phone. Direct IP retries
keep the selected endpoint; a changed wireless port requires discovery again.

Stop cancels pending retries and connection attempts. A normal phone Stop,
program startup error or service shutdown does not start automatic recovery.
Internet sessions require manual reconnection with a fresh single-use secret;
the backend disables automatic retry for this transport even if requested by
an API client. These settings belong to the GUI service, not CLI flags.

## Run locally

```bash
npm ci
npm run dev
```

Open <http://127.0.0.1:5173>. The Vite server proxies `/api` to the local
control service on port `27183`.

For a production-style localhost build:

```bash
npm run build
npm start
```

Then open <http://127.0.0.1:27183>.

The service uses `SCRCPY_GUI_BINARY`, `SCRCPY_RUNTIME_DIR`, and `ADB` when set.
Otherwise it looks for the local `x-reverse` build, a standard MSYS2 MinGW
runtime on Windows, and `adb` via `ANDROID_HOME` or `PATH`.

The dashboard checks the executable, loads `--help` to verify its runtime
libraries and reverse-display support, and checks ADB and the companion APK
separately. It refreshes these checks every 15 seconds and before each start.
Phone authorization, network visibility, and session authentication remain
separate transport checks; local readiness does not guarantee a phone connection.

`SCRCPY_SERVER_PATH`, `SCRCPY_REVERSE_DISPLAY_APK`, and `SCRCPY_ICON_DIR`
override asset discovery. For a binary in a build's `app` directory, assets
default to its sibling `server` directory. For a custom portable binary, they
default to its own directory. An external binary never silently uses artifacts
from this checkout's `x-reverse` build. Internet mode does not require desktop
ADB or APK assets; the receiving phone must already have the companion installed.

Stop requests use a private stdin pipe (`SCRCPY_GUI_CONTROL=stdin-v1`) so the
native receiver releases active touch/mouse input and closes its connections.
The service force-terminates only its own process tree if it has not exited after
three seconds. Closing the pipe also requests shutdown if the service exits.
Ordinary CLI stdin is unaffected. A stalled stream reports an error after ten
seconds without progress; reconnect after checking the phone. Internet mode
requires a new phone session and secret.

See [regression and physical-device checks](../doc/reverse-display-validation.md).

## Cable-free Android setup

On Android 11 or newer, enable **Developer options → Wireless debugging**
on a trusted Wi-Fi network. In the GUI choose **Wi-Fi → Pair a phone without USB**.
Open **Pair device with pairing code** on the phone and enter that dialog's
IP:port and six-digit code in the GUI. Codes are used once, sent to ADB via
stdin, and are not saved in the browser or service logs.

After pairing, refresh devices and start using **Wi-Fi**. This mode selects an
existing wireless transport only; it does not fall back to USB. If automatic
discovery is unavailable, select **Connect IP**, using the address and port from
the phone's **main Wireless debugging screen**, not its pairing dialog. The
connection port can change when wireless debugging restarts. Both devices must
be on the same network and the phone must keep wireless debugging enabled.

Legacy `:5555` connections also work when already enabled. Android 10 and older
require an initial USB setup for the ADB-based workflow; an ordinary Android
app cannot enable debugging or grant itself authorization.

## Dashboard views

For separate networks or mobile data, choose **Internet**. This experimental
mode uses Tailscale plus a temporary phone session key, bypassing ADB entirely.
See [Internet mode setup and security](../doc/internet-mode.md). The updated
APK must be installed first; no VPN account is created automatically.

- **Connect:** transport, wireless pairing, start/stop, and generated command.
- **Device:** detected USB/wireless connections, authorization, and target selection.
- **Performance:** working presets, individual settings, and real decode-ack latency.
  Settings apply on the next stream; latency is not full physical display latency.
- **Activity:** the latest native connection and stream logs, including failures.

Refresh and clipboard actions have visible feedback; native Android buttons use
pressed/focused/ripple states. Close-window and lock actions retain confirmation.

## Platform support

Windows reverse display, USB/Wi-Fi/direct-IP selection, device discovery,
stream start/stop, generated commands, logs, selected encoder, and live
capture-to-decode acknowledgement are wired to the local service.

The opt-in experimental macOS host now provides ScreenCaptureKit/VideoToolbox
video and mouse/scroll controls. Use the [Mac setup guide](../doc/macos-host.md)
and its launcher to configure the correct native build. Mac audio forwarding
is not implemented. Wireless Mac video is user-reported working; the latest
telemetry update and the remaining hardware checklist need manual Mac testing.

A remote browser *viewer* remains a separate follow-up slice. A hosted webpage
cannot capture the desktop, invoke ADB, or
inject operating-system input without a local native helper.

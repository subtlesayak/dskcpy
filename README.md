<!-- generated-by: gsd-doc-writer -->
# dskcpy

**Stream your desktop to Android. Control it with touch.**

dskcpy is an experimental fork of [scrcpy](https://github.com/Genymobile/scrcpy)
that adds the reverse direction: Windows or macOS desktop video on your Android
phone or tablet, with input sent back to the computer. Desktop audio forwarding
is implemented on Windows and experimental on macOS. Use USB, a local wireless
connection, or a private VPN network.

[Quick start](#quick-start) · [Connections](#connection-options) ·
[macOS setup](doc/macos-host.md) · [Browser receiver](doc/browser-receiver.md) · [Documentation](#documentation)

> [!IMPORTANT]
> This is **dskcpy**, not an official Genymobile release. Get this fork's source
> from [subtlesayak/dskcpy](https://github.com/subtlesayak/dskcpy).
> Standard scrcpy downloads do not include these desktop-to-Android features.
> Reverse display installs a companion Android app and currently requires a
> source build; there is no signed, ready-to-install dskcpy desktop release.

## What it does

- **Desktop video:** low-buffering H.264 streaming with hardware encoding where
  available, a visible cursor, and adjustable resolution, frame rate and bitrate.
- **Touch control:** native multi-touch injection on Windows; click, drag and
  two-finger scrolling on the experimental Mac host.
- **Desktop audio on Android:** Windows system playback and experimental Mac
  system audio over USB, LAN or Internet, with a separate phone-playback mute control.
- **Flexible connections:** USB, paired ADB Wi-Fi, direct IP, and experimental
  Tailscale-backed Internet sessions without ADB after app installation.
- **Leave and return:** background the Android app and return to the same
  session on Android 6+, while the sender pauses video and audio while away.
- **Controls within reach:** volume tap/hold, mute, window actions, lock,
  touch enable/disable, Stop, and hide/show controls. Hold an icon for its hint.
- **Local browser dashboard:** Connect, Device, Performance and Activity views;
  wireless pairing/discovery, encoder selection, logs and live decode-ack metrics.
- **Experimental browser receiver:** native H.264 video, optional Opus audio and
  authenticated touch input. USB uses an Android ADB tunnel; Wi-Fi/direct IP and
  Internet/VPN require explicitly configured trusted HTTPS.
- **Bounded recovery:** optional, limited retries for USB/LAN sessions. Internet
  sessions deliberately require a fresh secret after disconnection.

The Android app uses Material 3 navigation and adapts its streaming controls to
available letterbox space. No root access is required. The project is free and
open source, and USB/LAN streaming does not require a dskcpy account.

## Platform support

| Host → receiver | Status |
| --- | --- |
| Windows → Android | Implemented: video, native touch and system audio. Physical-device testing covers USB and authenticated VPN sessions. |
| macOS → Android | Experimental, opt-in source build. Wireless video has been reported working on an M3 Mac. Mouse/scroll controls and ScreenCaptureKit → Opus system audio are implemented. **Mac audio playback and broader hardware testing remain unverified.** |
| Linux → Android | Reverse hosting is not implemented. |
| Desktop → iPhone/iPad | No native iOS receiver. Experimental browser path exists; Safari/iOS compatibility is not yet verified. USB browser tunneling is Android-only. |
| Desktop → browser | Experimental WebCodecs receiver. Windows NVENC video, audio enable/mute and pause/resume tested on localhost. Android Edge over private HTTPS is user-reported working, including leave/return. The complete physical USB/Wi-Fi/IP/VPN matrix remains pending. |

The original Android-to-computer scrcpy mode remains in the codebase. Its
platform support and features are separate from dskcpy's reverse mode.

## Prerequisites

- **Windows host:** Windows 10+ with Desktop Duplication and an available H.264
  encoder. The sender tries supported hardware encoders before software fallback.
- **Mac host:** Apple silicon, macOS 13+, and an opt-in build using ScreenCaptureKit
  and VideoToolbox. Screen Recording and Accessibility permissions are needed
  for capture and input respectively.
- **Android receiver:** Android 5.0+ (API 21) with H.264 decoding. Background/return
  session retention requires Android 6+. Use Android 11+ for USB-free ADB pairing.
- **Dashboard:** Node.js 22.12+ and npm, plus the compiled native host.
- **USB/LAN:** Android SDK platform-tools (`adb`) and authorized debugging access.
- **Internet mode:** Tailscale on both devices, permitted peer connectivity, and
  the companion already installed. This mode does not need USB debugging.

## Get the source

```bash
git clone https://github.com/subtlesayak/dskcpy.git
cd dskcpy
```

Do not substitute an upstream `scrcpy` executable or an unrelated companion APK.
Build the sender and companion from the same checkout. Android updates require
the same signing key; do not uninstall an existing app just to bypass a signing
error if you need to keep its settings.

### Windows build

Install the native dependencies described in [MSYS2 build setup](doc/build.md#in-msys2),
Node.js, JDK 17+, and Android SDK platform 36/build-tools 36.0.0. Make Java and
ADB available on `PATH`, and set `ANDROID_HOME` to your Android SDK directory.

From an **MSYS2 MinGW64 terminal** in this checkout:

```bash
meson setup x-reverse --buildtype=debug
meson compile -C x-reverse
meson test -C x-reverse --print-errorlogs
```

The build produces `x-reverse/app/scrcpy.exe`,
`x-reverse/server/scrcpy-server` and `x-reverse/server/reverse-display.apk`.
The signed companion is required for reverse mode. Keep the MinGW runtime
libraries available when launching the executable.

### Mac build

Follow the [Mac setup guide](doc/macos-host.md) for dependencies and permissions.
From a **Git checkout**, build the companion first with JDK 17+ and Android SDK
platform 36 configured, or use a complete source test bundle containing it:

```bash
./gradlew :server:assembleDebug
bash tools/macos-build.sh
bash tools/macos-start.sh
```

If a source bundle already contains `companion/reverse-display.apk`, skip the
Gradle command. The Mac script builds and tests the opt-in host and dashboard;
an ordinary Homebrew scrcpy installation cannot replace this build.

## Quick start

After building the Windows host:

1. On Android, enable USB debugging, connect a data-capable cable, unlock the
   phone and approve the computer's debugging prompt.
2. Prepare the dashboard once, from the checkout folder in PowerShell:

   ```powershell
   npm.cmd ci --prefix gui
   npm.cmd run build --prefix gui
   ```

3. Double-click **`start-dskcpy.cmd`** in the checkout folder. Keep its terminal
   open while using dskcpy. It checks local components, opens the dashboard and
   reuses an already-running dashboard without interrupting its stream.
4. In [the dashboard](http://127.0.0.1:27183) **on the computer**, choose **USB**,
   select the authorized phone if necessary, and click **Start streaming**.
   The host installs and opens the companion for ADB-based connections.
5. Touch the desktop on Android. Use **Stop session** to disconnect; leaving the
   app temporarily is different from stopping it. On Mac, use the Mac launcher
   above and follow the permission prompts before expecting video or input.

The dashboard discovers the local Windows `x-reverse` build automatically.
For another build location, configure `SCRCPY_GUI_BINARY` and the matching
assets as described in the [dashboard guide](gui/README.md).
For a check without starting a service or capture, run
`node gui/scripts/launch.mjs --check`. The launcher does not install dependencies,
enable network access or replace the source-build requirement.

## Connection options

| Mode | Setup | Needs USB? |
| --- | --- | --- |
| **USB** | Enable USB debugging and authorize the computer. | Yes, while streaming. |
| **Wi-Fi** | Pair using Android 11+ Wireless debugging, then select a discovered wireless device. | No, with wireless pairing. |
| **Connect IP** | Enter the phone's reachable LAN IP and ADB **connection** port. | No, when wireless debugging is already paired/enabled. |
| **Internet** | Select a reachable Tailscale Android peer and enter its temporary dskcpy session secret. | No, after companion installation. |

**Wireless pairing:** choose **Wi-Fi → Pair a phone without USB**. Enter the
address and six-digit code from Android's **Pair device with pairing code**
dialog. After pairing, use the connection address on the main **Wireless
debugging** screen. The pairing and connection ports are different, and ports
can change. Both devices must be reachable on the LAN. Older Android versions
need initial USB setup for the ADB TCP/IP workflow.

**Mobile data or separate networks:** a carrier IP alone is not an Internet
connection method. Use [Internet mode](doc/internet-mode.md) with Tailscale.
Different accounts can connect through a permitted device share or tailnet
invitation. No account enrollment or access-policy change is performed for you.

The phone can generate a **12-word passphrase**, **26-character alphanumeric
key**, or **3-word short passphrase**, with a copy button. The three-word option
is substantially weaker; prefer the longer formats, especially with other users.
Never post a session secret in an issue or screenshot.

## Usage examples

The binary is still named `scrcpy`. Once your build and runtime assets are
configured, the CLI can start reverse display without the dashboard:

```bash
# USB: a practical starting point for desktop text
scrcpy --reverse-display --connection=usb --max-size=1920 --max-fps=60 --video-bit-rate=12M

# An already-authorized wireless ADB device
scrcpy --reverse-display --connection=wifi

# An already-authorized LAN endpoint (replace this example IP and port)
scrcpy --reverse-display --connection=ip:192.168.1.20:5555
```

Use `--no-audio` to disable Windows audio capture. Select a Windows monitor with
`--reverse-display-index=1` (zero-based), or a supported host encoder with
`--video-encoder=h264_nvenc`. On Mac, use Auto or `h264_videotoolbox`.
Internet authentication is handled by the dashboard, not by putting secrets
into a CLI command. See [reverse-display options](doc/reverse-display.md).

## Must-know tips

- Start with **1920 / 60 FPS / 12 Mbps**, then tune for your connection and device.
  Dashboard setting changes apply to the **next** stream: stop and restart.
- Prefer USB when diagnosing latency. Hardware encoding and a stable local
  network help; a VPN relay or congested link can add delay.
- On Mac, use **two fingers to scroll**. Windows uses native touch injection.
- Phone-playback mute and computer mute are separate. Windows playback is not
  automatically silenced when audio is forwarded to Android.
- **Performance is not a glass-to-glass benchmark.** The number measures the
  host-to-decode acknowledgement round trip, not physical display scan-out.
  On Mac it starts at encode submission and excludes capture wait.
- If Mac video works but Performance stays on Connecting, rebuild and restart
  the updated native host. A browser refresh cannot replace the old binary.
- Open the dashboard on the **host computer**. It binds to localhost; entering
  its URL on the phone will not open the computer's dashboard.

## Limits and security

This mirrors an existing desktop display. It does **not** add a virtual monitor
or Windows Extend mode. Stylus pressure/Windows Ink, a native iOS receiver and a
packaged Tauri desktop wrapper are not implemented. Browser receiving is
experimental; Safari/iOS still needs physical-device verification.
There is no zero-latency or fixed-latency guarantee.

ADB grants powerful access to a device: authorize only trusted computers and
never expose debugging ports to the public Internet. In Internet mode, Tailscale
provides network encryption; dskcpy adds temporary-session authentication, not
its own replacement for VPN encryption. This protocol is experimental and has
not undergone an independent security audit. Read the
[security boundary](doc/internet-mode.md#security-boundary-and-protocol).

The dashboard does not upload logs or diagnostics automatically. Session secrets
are not saved in dashboard settings or generated commands. Review logs before
sharing them: remove keys, device identifiers, addresses, personal paths and
private screen content.

## Documentation

- [Reverse display, desktop controls and audio](doc/reverse-display.md)
- [Remaining implementation and validation work](doc/roadmap.md)
- [Dashboard setup, runtime configuration and reconnection](gui/README.md)
- [Mac build, permissions and manual test checklist](doc/macos-host.md)
- [Internet mode, shared devices and authentication](doc/internet-mode.md)
- [Regression tests and physical-device validation notes](doc/reverse-display-validation.md)
- [Native build reference](doc/build.md) — inherited scrcpy instructions; clone
  this fork and use the reverse-mode setup above.
- [Upstream Android-to-computer documentation](https://github.com/Genymobile/scrcpy#user-documentation)

For development, the dashboard uses `npm test` and `npm run build` from `gui/`.
Native tests run in a debug Meson build with `meson test -C x-reverse`.
Android tests use `./gradlew :server:testDebugUnitTest`. A passing build or mock
test does not establish physical Mac, audio, input or network performance.

Fixes and improvements are welcome through
[pull requests to this fork](https://github.com/subtlesayak/dskcpy/pulls).
Keep reverse-display bug reports separate from upstream scrcpy issues and include
the host OS, connection mode, reproduction steps and sanitized diagnostics.

## Credits and license

Built on [scrcpy](https://github.com/Genymobile/scrcpy) by Genymobile, Romain
Vimont and its contributors. dskcpy's README follows upstream's feature-first,
quick-start structure; reverse-display changes belong to this fork.

Licensed under [Apache License 2.0](LICENSE). Existing upstream copyright and
license notices are retained. The passphrase vocabulary has its own
[MIT license notice](server/src/main/assets/internet-words-LICENSE.txt).

Copyright (C) 2018 Genymobile. Copyright (C) 2018–2026 Romain Vimont.

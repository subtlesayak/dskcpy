# dskcpy

**Stream your Windows or Mac desktop to Android or a browser.**

View desktop video, forward system audio, and send touch or mouse input back to
the computer over USB, a local network, or a private VPN. dskcpy is a free,
open-source fork of [scrcpy](https://github.com/Genymobile/scrcpy) that adds this
reverse direction. The original Android-to-computer mode remains available.

[Get started](#quick-start) · [Windows setup](doc/windows-host.md) ·
[Downloads](#get-the-app) · [Mac setup](doc/macos-host.md) · [Browser receiving](doc/browser-receiver.md) ·
[Troubleshooting](FAQ.md) · [Documentation](#documentation)

[Current project status and verification](doc/project-status.md) separates the
merged implementation, unmerged follow-ups and candidate-specific physical results.

For source/artifact identity, Android upgrade checks and the separate unsigned
Mac hosting candidate, see [Build identity and compatible upgrades](doc/artifact-upgrades.md).

> [!IMPORTANT]
> Get dskcpy source from [this repository](https://github.com/subtlesayak/dskcpy).
> Download only from this repository's [releases](https://github.com/subtlesayak/dskcpy/releases).
> Preview builds are experimental: Mac/Windows desktop apps are unsigned, and
> Mac is not notarized. There is no qualified stable release yet. Upstream scrcpy
> downloads and package-manager installs do not include dskcpy's desktop-hosting
> features. Longer-session audio, transport and device qualification remain open.

## Get the app

[**0.1.0 preview — 21 November 2026**](https://github.com/subtlesayak/dskcpy/releases/tag/v0.1.0-preview.20261121)
provides prebuilt desktop hosts and a matching Android companion. These are
preview downloads, not a qualified stable release. No compiler or Node.js setup
is needed to run the desktop app.

| Platform | Download | Install and run |
| --- | --- | --- |
| Android | [Companion APK, version 50003](https://github.com/subtlesayak/dskcpy/releases/download/v0.1.0-preview.20261121/dskcpy-android-50003.apk) | [Android instructions](doc/downloads.md#android) |
| Mac, Apple silicon | [Mac app ZIP, arm64](https://github.com/subtlesayak/dskcpy/releases/download/v0.1.0-preview.20261121/dskcpy-macos-arm64.zip) | [Mac instructions](doc/downloads.md#mac) |
| Mac, Intel | [Mac app ZIP, x64](https://github.com/subtlesayak/dskcpy/releases/download/v0.1.0-preview.20261121/dskcpy-macos-x64.zip) | [Mac instructions](doc/downloads.md#mac) |
| Windows x64 | [Portable app ZIP](https://github.com/subtlesayak/dskcpy/releases/download/v0.1.0-preview.20261121/dskcpy-windows-x64.zip) | [Windows instructions](doc/downloads.md#windows) |
| Browser receiver | Open the invitation served by the running desktop host | [Browser setup](doc/browser-receiver.md) |

Read the [package contents, checksums and upgrade limits](doc/downloads.md)
before replacing a working installation. The preview contains the November 21
receiver. Current source also includes an installable browser receiver, an
offline list of saved computers and trusted-HTTPS LAN pairing. Live video,
audio and input require a connection to the host. See
[project status](doc/project-status.md#merged-implementation-baseline) for the
newer source and its verification, or [build from source](#get-the-source).

## What it does

- **Desktop video:** H.264 capture with hardware encoding where available,
  a visible cursor, and adjustable size, frame rate and bitrate.
- **Desktop control:** native touch on Windows; click, drag and two-finger
  scrolling on Mac. Receiver controls include volume, mute, window actions and Stop.
- **System audio:** Windows playback capture and experimental Mac system audio,
  with receiver playback mute separate from computer mute.
- **Android receiving:** a companion app with USB, paired ADB Wi-Fi, direct-IP
  and private VPN connections. On Android 6+, leaving and returning can retain
  the session; stopping ends it.
- **Browser receiving:** authenticated WebRTC H.264/Opus and one-use QR
  invitations, plus a WebCodecs path for Android USB browser tunnels.
- **Paired computers:** save verified hosts in this browser and
  [request each new stream](doc/remembered-browsers.md) without a new QR code.
  The host must choose Allow; pairing does not grant unattended streaming.
- **Mac window sharing:** select one window, or explicitly approve a small
  [window-switching list](doc/browser-window-switching.md). Sharing stays view-only.
  Audio starts off; optional [application audio](doc/browser-window-audio.md)
  includes the selected app's other windows and tabs. Hiding, minimizing or
  closing the current target ends capture.
- **Browser typing:** opt-in full-desktop keyboard and committed Unicode/IME input
  on matching Mac and [Windows hosts](doc/windows-browser-keyboard.md), gated by
  native capability and OS input permissions. Optional Mac
  [typing framing](doc/browser-typing-view.md) follows a bounded caret/field hint,
  with last-tap framing for older hosts.
- **Receiver tools:** adjustable touch-scroll speed, trackpad control, local
  pinch zoom, shortcut buttons and separately authorized
  [text clipboard transfer](doc/browser-clipboard.md).
- **Experimental separate controller:** an off-by-default
  [presentation and phone-controller prototype](doc/external-display-controller.md),
  with separate media/input roles and negotiated secondary click on matching
  hosts. Physical casting and background playback remain unqualified.
- **Desktop app prototype:** guided private-network and account-free Android USB
  setup; see [implemented features and release gates](desktop/README.md).
- **Local dashboard:** connection setup, wireless discovery, performance settings,
  activity logs, and optional bounded USB/LAN reconnect attempts.

USB/LAN operation needs no dskcpy account or root access. Private Internet/VPN
operation uses an external VPN such as Tailscale and its access controls.

## Platform support

| Host → receiver | Status and limits |
| --- | --- |
| Windows → Android | Video, native touch and system audio implemented; physical USB/VPN results are recorded in the validation notes. |
| Mac → Android | Experimental Apple-silicon and Intel builds. Earlier snapshots have physical video/input/recovery results; sustained audio and final-candidate qualification remain open. |
| Windows/Mac → browser | Experimental private WebRTC and WebCodecs paths, desktop typing, bounded adaptive video and media recovery. Mac window sharing stays view-only; app audio requires a separate opt-in. Physical device/driver qualification remains open. |
| Desktop → iPhone/iPad browser | Safari/iOS compatibility needs physical qualification; no native iOS receiver or iPhone USB tunnel is provided. |
| Linux desktop hosting | Not implemented. Linux can still use the inherited Android-to-computer mode. |

A source implementation or automated pass is not a physical-device pass. See
[validation notes](doc/reverse-display-validation.md), the
[Mac testing record](doc/testing/mac/README.md), and the [roadmap](doc/roadmap.md).

## Prerequisites

The preview desktop app includes its runtime. Compiler and Node.js requirements
below apply when building or running the dashboard from source.

- **Windows host:** Windows 10+, an interactive desktop, and an H.264 encoder.
- **Mac host:** Apple silicon or Intel, macOS 13+ and
  Screen Recording permission. Source builds also need Apple's Command Line Tools. Input additionally needs Accessibility.
  Local dependency builds can require a newer OS; the source minimum is not
  a guarantee that a Homebrew-linked binary runs on every macOS 13+ machine.
  Use the [matching native architecture](doc/mac-host-architectures.md).
- **Dashboard from source:** Node.js 22.12+ and npm, with this fork's compiled native host.
- **Android app receiver:** Android 5.0+ with H.264 decoding; Android 6+ for
  retained background sessions. A matching companion APK is required.
- **Browser receiver:** no companion APK. Android USB mode needs authorized
  debugging and ADB; Wi-Fi/direct-IP/VPN mode needs trusted HTTPS and private
  media reachability. Chrome and Edge are the initial targets; Safari/iOS needs testing.

## Get the source

### Mac downloads

Prebuilt Apple-silicon and Intel app ZIPs are available in
[Get the app](#get-the-app). They contain an experimental unsigned desktop app;
read the [Mac installation and qualification limits](doc/downloads.md#mac).
An installable browser receiver is a different application from the Mac host.
For development or another build configuration, follow
[Mac source-build setup](doc/macos-host.md).

### Clone the repository

```sh
git clone https://github.com/subtlesayak/dskcpy.git
cd dskcpy
```

Build the native host, dashboard and Android companion from a matching revision.
An APK upgrade also needs the same signing key; preserve an existing installation
and its data when resolving a signature mismatch.

### Windows build

Follow [Windows host setup](doc/windows-host.md). It covers the UCRT64 native
build, Android companion, dashboard, and runtime-library discovery/overrides.
Use a new build directory when changing compiler/runtime families.

### Mac build

Follow [Mac host setup](doc/macos-host.md). Choose Git-checkout or complete-bundle
instructions. The Mac build script expects an existing companion APK, even if
only testing browser receiving; a native-only browser build is documented separately.

## Quick start

First complete the [Windows](doc/windows-host.md) or [Mac](doc/macos-host.md)
build and start the dashboard **on the host computer**. Keep its terminal open.
Choose the receiver you want to use:

### Receive in the Android app

1. Connect Android with a data-capable USB cable, enable USB debugging, unlock
   the device, and approve the computer's authorization prompt.
2. In the computer dashboard, choose **USB**, select the authorized device,
   and select **Start streaming**. The host installs/opens the matching companion.
3. Grant the Mac capture/input permissions if requested. Check readable video,
   a harmless tap/drag, and two-finger scrolling on Mac.
4. Use **Stop session** to end the connection. Leaving the app temporarily is
   different from stopping it.

Then try [wireless pairing](gui/README.md#cable-free-android-setup) or
[native Android Internet mode](doc/internet-mode.md).

### Receive in a browser

1. In the computer dashboard, open **Browser receiver** and choose **USB cable**
   for an authorized Android device, or **This computer** for a local preview.
2. Select **Create link and code**. On Android USB, scan the QR using that
   connected device. For local preview, open the receiver link and paste its code.
3. Wi-Fi, direct IP and Internet/VPN need the
   [secure-link setup](doc/browser-receiver.md#choose-a-connection) first.
4. In the receiver, select **Disconnect** and confirm the stop request, or select
   **Stop browser stream** in the dashboard, to end sharing. Cancel keeps the
   receiver session running.

The dashboard and receiver are different pages. The dashboard's localhost
address is for the computer; use the generated receiver address on the phone.
A browser invitation is generated on the computer; a native Android Internet
secret is generated in the phone app. They are separate connection flows.

For later connections over private HTTPS, you can
[pair this browser and save computers](doc/remembered-browsers.md). Choose
**Request to connect** on a saved computer, then wait for **Allow** on the host.
Each new stream needs approval. A brief interruption can resume the same
approved stream within its existing deadline.

## Connection options

| Connection | Android app receiver | Browser receiver |
| --- | --- | --- |
| USB | Authorized debugging, ADB and matching companion; cable stays connected. | Android-only ADB reverse tunnel; no companion APK. |
| Same LAN / direct IP | Pair/connect using Android Wireless debugging and its connection port. | Trusted HTTPS receiver address and a reachable private media interface; no ADB pairing. |
| Internet / VPN | Reachable Android VPN peer and a temporary phone-generated secret. | Reachable host VPN peer, trusted HTTPS, private media traffic and a computer-generated invitation. |
| This computer | Not an Android-app mode. | Loopback preview; no certificate. Keyboard forwarding is omitted to avoid input feedback. |

Pairing and connection ports are different and may change. Use the connection
address on Android's main Wireless debugging screen after pairing. Android 11+
can pair without USB; older ADB wireless workflows need initial USB setup.
A carrier IP alone is not an Internet connection method.

## Must-know tips

- Build the native host and dashboard together for Mac window/keyboard controls;
  older binaries do not advertise those capabilities.
- Start with **1920 / 60 FPS / 12 Mbps**, then tune for your device and connection.
  Performance changes apply to the next stream.
- Mac window mode is view-only. Audio starts off; a capable host can explicitly
  allow the selected window's entire application audio. See
  [application-audio scope and qualification](doc/browser-window-audio.md).
  Select the entire desktop for input.
- Computer volume and receiver playback mute are separate controls.
- Decode-acknowledgement round trip is not physical touch-to-display latency.
  WebRTC send acknowledgements are not browser decode measurements either.
- Before rebuilding, changing native artifacts, or restarting a service, end the
  active session deliberately. A browser refresh cannot replace a native binary.

## Usage examples

The native binary is still named `scrcpy`. These commands require **this fork's
binary**, matching assets, and an already authorized Android connection:

```sh
# USB, with settings suitable as a starting point for desktop text
scrcpy --reverse-display --connection=usb --max-size=1920 --max-fps=60 --video-bit-rate=12M

# An existing authorized ADB wireless transport
scrcpy --reverse-display --connection=wifi
```

Use the dashboard for Internet authentication and browser invitations. Native
options and encoder/monitor selection are in the
[reverse-display reference](doc/reverse-display.md).

## Limits and security

The host mirrors an existing desktop; it does not add a virtual monitor or
Windows Extend mode. Stylus pressure/Windows Ink, native iOS software, packaged
Tauri apps and signed desktop distribution remain [roadmap work](doc/roadmap.md).

Authorize only trusted ADB computers. Keep debugging ports and the controller
private. Remote browser receiving uses a separate authenticated endpoint;
public relays, router forwarding and Funnel are not part of this setup.
Anyone with a live invitation can view/control the shared desktop within the
selected capture policy. Share it only with the intended receiver.

Diagnostics are not uploaded automatically. Before sharing logs or screenshots,
remove credentials, invitation codes, device/network identifiers, personal paths
and private desktop content. Read the [Internet security boundary](doc/internet-mode.md#security-boundary-and-protocol).

<a id="documentation"></a>

## User documentation

| Task | Guide |
| --- | --- |
| Download and run a prebuilt package | [Downloads, verification and upgrades](doc/downloads.md) |
| Build and run a Windows host | [Windows setup](doc/windows-host.md) |
| Build and run a Mac host | [Mac setup and permissions](doc/macos-host.md) |
| Receive desktop video in a browser | [Browser setup and controls](doc/browser-receiver.md) |
| Use native Android desktop controls/audio | [Reverse-display reference](doc/reverse-display.md) |
| Pair, discover or reconnect an Android device | [Dashboard guide](gui/README.md) |
| Connect the native Android app over a VPN | [Internet mode](doc/internet-mode.md) |
| Resolve setup or streaming failures | [FAQ](FAQ.md) |
| Build the inherited Android-to-computer mode | [Native build reference](doc/build.md) |
| Check current progress and actual evidence | [Project status](doc/project-status.md), [roadmap](doc/roadmap.md), [validation notes](doc/reverse-display-validation.md) |

Development checks are `npm test --prefix gui`, `npm run build --prefix gui`,
`meson test -C <debug-build-directory>`, and `./gradlew :server:testDebugUnitTest`
(`.\gradlew.bat` on Windows). See the
[upstream user documentation](https://github.com/Genymobile/scrcpy#user-documentation)
for the original Android-to-computer features; upstream binaries do not host dskcpy.

## Resources

- [FAQ and troubleshooting](FAQ.md)
- [Current project status and evidence](doc/project-status.md)
- [Remaining implementation and hardware work](doc/roadmap.md)
- [Build identity and compatible upgrades](doc/artifact-upgrades.md)
- [Developer guide](doc/develop.md)

Report dskcpy bugs to [this fork](https://github.com/subtlesayak/dskcpy/issues),
with the host OS, receiver, source revision, connection mode, reproduction steps
and sanitized diagnostics.

## Credits and license

Built on [scrcpy](https://github.com/Genymobile/scrcpy) by Genymobile, Romain
Vimont and its contributors. Existing notices are retained.
Project source is under [Apache License 2.0](LICENSE); packaged dependencies
retain their own licenses and [notices](doc/downloads.md#verify-the-download).
The passphrase vocabulary has a
separate [MIT notice](server/src/main/assets/internet-words-LICENSE.txt).

Copyright (C) 2018 Genymobile. Copyright (C) 2018–2026 Romain Vimont.

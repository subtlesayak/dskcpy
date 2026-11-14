# Mac host setup

Send an Apple-silicon or Intel Mac desktop to the Android app or a browser. The native
host uses ScreenCaptureKit and VideoToolbox and requires macOS 13+.
This is an experimental source build, not a signed/notarized Mac application.

See [Build identity and compatible upgrades](artifact-upgrades.md) before
updating an installed Android companion or building the separate unsigned
hosting candidate. Its deployment-target scan still needs clean-machine testing.

[Requirements](#requirements) · [Build](#build-from-a-git-checkout) ·
[Permissions](#allow-capture-and-input) · [First stream](#start-your-first-stream) ·
[Troubleshooting](../FAQ.md)

## Requirements

Use a Terminal matching the Mac's native architecture: arm64 on Apple silicon
(without Rosetta), or x86_64 on Intel. Keep dependency caches and packages separate;
see [Mac build architectures](mac-host-architectures.md). Install Apple's Command Line
Tools if they are absent:

```sh
xcode-select --install
```

Complete that installation. If needed, install [Homebrew](https://brew.sh/), then:

```sh
brew install ffmpeg sdl3 meson ninja pkgconf node
brew install --cask android-platform-tools
```

Node.js must be 22.12+. ADB/platform-tools is needed for native Android USB/Wi-Fi/IP
and Android USB browser tunnels; private browser/VPN mode does not use it.
Dependency installation needs Internet access. Local Homebrew libraries may
require a newer OS than the source minimum; these builds are not portable
macOS 13 release artifacts.

Choose the source workflow below. Build in a separate checkout/directory while
an existing stream is active; the standard script rebuilds `build-macos` and
must not replace the native host used by an active session.

## Build from a Git checkout

The companion build needs JDK 17 and the Android SDK. One JDK setup is:

```sh
brew install openjdk@17
export JAVA_HOME="$(brew --prefix openjdk@17)/libexec/openjdk.jdk/Contents/Home"
export PATH="$JAVA_HOME/bin:$PATH"
```

Use Android Studio's [SDK Manager](https://developer.android.com/studio/intro/update#sdk-manager)
to install Android SDK platform 36, build-tools 36.0.0 and platform-tools. Set
`ANDROID_HOME` to the SDK location shown there; a typical Mac installation uses
`export ANDROID_HOME="$HOME/Library/Android/sdk"`. Then:

```sh
git clone https://github.com/subtlesayak/dskcpy.git
cd dskcpy
# Set ANDROID_HOME to your existing SDK directory before running Gradle.
./gradlew :server:assembleDebug
bash tools/macos-build.sh
```

If you already cloned the project, begin at the Gradle step inside that checkout.
The Android output is `server/build/outputs/apk/debug/server-debug.apk`.
The Mac script finds it, builds/tests the native host and dashboard, and copies
it to `build-macos/server/reverse-display.apk`. Build related components from
the same revision. The companion is debug-signed for testing; updates require a
compatible signing key. Do not uninstall a working app just to bypass a mismatch.

The script does not build the Android companion itself. If you want only browser
receiving and have no APK/Android SDK, use the [native-only build](#browser-only-build-without-an-apk).

## Build a complete source bundle

A privately received complete bundle may already contain
`companion/reverse-display.apk`. Extract it into a new folder and keep its files
together. In the extracted root, run:

```sh
bash tools/macos-build.sh
```

This workflow needs no local Gradle/Android SDK build. If `SHA256SUMS` is present,
the script verifies it. A source-only ZIP without either recognized APK is not
a complete bundle: build the companion as above or use the browser-only path.
A Windows executable and an ordinary Homebrew `scrcpy` cannot replace this host.

## Start the dashboard

After either complete build:

```sh
bash tools/macos-start.sh
```

Open <http://127.0.0.1:27183> **on the Mac** and keep Terminal open. This launcher
selects `build-macos/app/scrcpy`, its companion and icons explicitly. It starts
the service directly; if its port is occupied, use the existing dashboard or
end that service deliberately when idle. Do not stop an unrelated process.
Later launches need only the start command.

## Allow capture and input

In **System Settings → Privacy & Security**, allow the process macOS identifies
as the launcher/host (often Terminal):

| Permission | Used for |
| --- | --- |
| Screen Recording / Screen & System Audio Recording | Desktop/window video and experimental system audio. The label varies by macOS version. |
| Accessibility | Mouse/scroll, desktop actions and optional browser keyboard input. Without it, capture can be view-only. |

Grant access only to the launcher/binary you intend to use. If macOS requires
quitting the launching app, end the session, quit/reopen that app, and launch
again. Refreshing a browser tab does not reload native permissions. A failed
browser start may consume its one-use invitation; create a fresh invitation
after correcting permission and restarting the host.

System audio capture does not request microphone permission. Protected media
may be unavailable even when ordinary desktop content captures correctly.

## Start your first stream

### Android app over USB

1. Enable Android USB debugging, connect a data-capable cable, unlock the phone,
   and approve this Mac's authorization prompt.
2. Choose **USB** in the Mac dashboard and select **Start streaming**. The host
   installs/opens the matching companion; it preserves app data on compatible updates.
3. Confirm readable video and cursor, then tap/drag a harmless window. Use
   **two fingers to scroll**. Mac control emulates a mouse, not Windows multitouch.
4. Leave the Android app briefly and return. Use **Stop session** to end the
   stream; check that input is released before reconnecting.

After USB, use [Wireless debugging](../gui/README.md#cable-free-android-setup)
for Wi-Fi/direct IP, or [native Internet mode](internet-mode.md) for a private VPN.
Pairing and connection ports are different. Test each transport independently.

### Browser receiver

Follow [browser receiving](browser-receiver.md): choose **This computer** for a
local preview or **USB cable** for an authorized Android browser. No APK is
installed for this receiver. Remote Wi-Fi/direct-IP/VPN requires trusted HTTPS
and private media reachability. The existing-private-VPN launcher is
`bash tools/macos-browser-start.sh`; its readiness check is
`bash tools/macos-browser-start.sh --check`. It needs the separately configured
private HTTPS route described in that guide.

The dashboard's **Refresh windows** picker enables single-window capture.
Window mode is view-only with audio off; minimizing, hiding or closing the
selected target ends the session. The dashboard can also approve a fixed list of
two to eight windows for [receiver switching](browser-window-switching.md) under
the same temporary view-only grant. Full-desktop browser sessions can offer
**Keyboard** with a focused typing field when the native host supports it.
The **This computer** preview omits typing to avoid input feeding back into itself.

## Browser-only build without an APK

This alternative builds the native host and dashboard directly. Use a fresh
build directory if one already belongs to an active session:

```sh
meson setup build-macos -Dcompile_server=false -Dreverse_macos=true -Dusb=false -Dbuildtype=debug
meson compile -C build-macos
meson test -C build-macos --print-errorlogs
npm ci --prefix gui
npm test --prefix gui
npm run build --prefix gui
export SCRCPY_GUI_BINARY="$PWD/build-macos/app/scrcpy"
export SCRCPY_ICON_DIR="$PWD/app/data"
node gui/scripts/launch.mjs
```

`-Dusb=false` disables inherited HID/OTG support, not ADB USB streaming.
The standard `macos-start.sh` requires an APK, so use the Node launcher above
for this browser-only path. Configure `DSKCPY_VIEWER_*` in the same terminal
for remote browser receiving; see the [browser guide](browser-receiver.md).

<a id="testing-mac-desktop-audio"></a>

## Audio and recovery checks

Mac system audio and output-route recovery are implemented experimentally.
Sustained audible playback remains a qualification gate. An Opus initialization
log or ACK is not proof of audible sound. With a quiet, non-protected clip:

- Enable playback on the receiver, check its media volume, then mute/unmute it.
  Receiver playback mute and Mac volume are separate controls.
- Leave/return, pause/resume, and stop/reconnect; check for gaps and stale audio.
- With audio muted, change an available output route, restore playback, and
  switch back. Verify video remains usable and audio respects mute.
- Repeat over each available transport. Record the source/artifact, transport,
  duration and actual outcome; do not infer hardware success from retries or logs.

The implementation clears old samples/partial encoding state on route changes
and uses bounded PCM conversion. It does not change the selected output device
or require microphone capture. Window mode has no audio. See the
[qualification record](testing/mac/platform-features.json) for source tests and limits.

## Updates and troubleshooting

Finish any active stream before updating its checkout or rebuilding its native
artifact. Keep local changes and working binaries recoverable; rebuild the host
and dashboard together. Native version/capability mismatches cannot be fixed by
refreshing the browser alone.

Use the [FAQ](../FAQ.md) for missing video, input, audio, assets and invitations.
The [Mac testing record](testing/mac/README.md) distinguishes dated physical
results from current-source automation. Earlier source-bundle update narratives
are retained in [setup history](testing/mac/setup-history.md).

For input/latency checks, use harmless content and report the transport and
measurement method. Decode-acknowledgement RTT excludes physical display scan-out;
WebRTC send completion is not browser decode time. Report sample count, median
and p95 if collecting timing samples. Remove private screen content, addresses,
device identifiers and local personal paths before sharing diagnostics.

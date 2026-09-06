# dskcpy: experimental Mac host

Manual test target: Apple silicon M3, macOS Tahoe 26.5.1 (reported by the tester).
No Codex installation is needed. This is a **source test bundle**, not a signed
Mac app or a verified Mac release. The Apple SDK build and hardware checks must
run on the Mac; Windows regression tests cannot prove them.

The tester reports working wireless Mac-to-Android streaming after the
thread-name startup fix. This confirms that manual video test, not every input,
transport or latency check below. The next screenshot showed a stale
"Connecting" status and no latency while video was working. This update fixes
buffered host logs so encoder and decode-acknowledgement updates reach the
dashboard immediately. The updated telemetry still needs a manual Mac retest.

## Updating when video works but Performance stays on Connecting

The previous Mac host buffered INFO/DEBUG output when launched by the dashboard.
The dashboard therefore received encoder and latency updates late, even though
the video connection was already working. Log records are now flushed
immediately; the waiting message also recognizes an already-started stream.
The wireless connection and pairing implementation are unchanged.

1. Stop streaming, then stop the old Mac dashboard with Control-C in its Terminal.
2. Extract the telemetry-fix source ZIP into a **new folder**, separate from the
   old copy. Open Terminal inside its `dskcpy-macos-source` folder.
3. Rebuild and launch the corrected native host and dashboard:

   ```sh
   bash tools/macos-build.sh
   bash tools/macos-start.sh
   ```

4. Reload the Mac dashboard and start the same wireless connection. Previously
   installed build dependencies and Android pairing can be reused.
5. Open Performance while video is playing. After the first decode acknowledgement,
   it should show **Live**, **Apple VideoToolbox (experimental)** and a latency
   value. Stopping retains the last measurement; a new stream clears it while
   waiting for a fresh acknowledgement. A browser refresh alone cannot update
   the old native binary: the rebuild above is required.

If it still stays on Connecting, share the relevant new Activity lines with
private details removed. The automated test uses synthetic telemetry, not a
measurement of your Mac or network. The displayed Mac latency excludes capture
wait and physical display scan-out.

## Updating after the thread-name startup crash

If Activity shows `Assertion failed: (strlen(name) <= 15)` in `sc_thread_create`,
wireless pairing is not the cause of that crash. The previous Mac worker name
was 17 bytes; the corrected name is 13 bytes. Keep debug assertions enabled.

1. Stop the old Mac dashboard with Control-C in its Terminal.
2. Extract the corrected source ZIP into a **new folder**, separate from the old
   copy. Do not merge folders or reuse the old compiled binary.
3. Open Terminal in the new extracted folder and run:

   ```sh
   bash tools/macos-build.sh
   bash tools/macos-start.sh
   ```

4. Reload the Mac dashboard and retry the same wireless device. Dependencies
   already installed do not need reinstalling, and Android pairing is unchanged.
   If another error appears, share the new Activity error with private details
   removed. The tester subsequently reported that wireless streaming works;
   the remaining platform checks are still listed below.

## What this slice includes

- ScreenCaptureKit desktop capture, visible cursor, VideoToolbox hardware H.264.
- Single-finger click/drag and two-finger scrolling. This is mouse emulation,
  not Windows native multi-touch, stylus pressure or Apple Pencil support.
- Volume controls where the Mac output exposes them, minimize, zoom/restore,
  close-window and lock shortcuts. Apps can decline individual window actions.
- Android background/return protocol, keyframe refresh and bounded buffering.
- The existing USB, paired ADB Wi-Fi/IP and authenticated Tailscale transports.
  Basic wireless video is user-confirmed; USB, direct-IP and Internet still need
  separate physical Mac checks. Transport reuse is not test evidence.
- The localhost browser dashboard, with Mac-only encoder choices and explicit
  experimental/permission information.

Mac desktop audio forwarding is **implemented experimentally**, using
ScreenCaptureKit system capture and 10 ms Opus packets. Audible playback still
requires manual Mac verification; Windows audio is unchanged. No iOS or browser media
receiver, extended virtual monitor, HDR, system-wide text keyboard, or zero-latency
guarantee is included. The Android companion is debug-signed for testing.

## 1. On Windows: transfer the bundle

Transfer `dskcpy-macos-source.zip` to the Mac using a USB drive or AirDrop through
another Apple device. Extract the `dskcpy-macos-source` folder. Keep all files
together. Do not copy the Windows EXE to run on the Mac. No cloud upload is needed.

## 2. On the Mac: install build dependencies

Open Terminal and install Apple's command-line tools if absent:

```sh
xcode-select --install
```

Finish that installation before continuing. If Homebrew is absent, follow the
installation instructions at [Homebrew](https://brew.sh/). Then:

```sh
brew install ffmpeg sdl3 meson ninja pkgconf node
brew install --cask android-platform-tools
```

Use native arm64 Terminal (not Rosetta). Node must be 22.12 or newer. Dependency
installation needs internet access; it downloads dependencies, not your source
or diagnostics. `npm ci` uses the supplied lockfile. No Android Studio/Gradle
installation is needed on this Mac because the matching APK is included.

## 3. On the Mac: build and start

In Terminal, type `cd ` (including the space), drag the extracted
`dskcpy-macos-source` folder into Terminal, then press Return. Run:

```sh
bash tools/macos-build.sh
bash tools/macos-start.sh
```

The build checks bundle hashes, compiles the Mac source, runs native and dashboard
tests, copies the APK beside the native build, and builds the dashboard. It stops
at the first failure. An ordinary Homebrew `scrcpy` binary cannot replace this
fork. All generated files stay inside the extracted folder. The script does not
install a background service or change permissions automatically.

Open [the local dashboard](http://127.0.0.1:27183) **on the Mac**, not on the phone.
Keep Terminal open. If the port is already used, stop your earlier dskcpy launcher;
do not stop an unrelated service. For subsequent runs, only the start command is
needed. The dashboard must show `macOS · experimental`.

## 4. First test: Mac to Android over USB

1. Unlock Android, enable USB debugging, connect a data-capable cable, and approve
   the Mac's debugging prompt. Select USB in the Mac dashboard.
2. Click **Start streaming**. This installs/updates the included companion APK
   without intentionally clearing app data. If a different signing key prevents
   update, stop and report the error; do not uninstall and lose settings blindly.
3. On the Mac, allow screen recording under **System Settings → Privacy &
   Security → Screen & System Audio Recording** (wording can vary). Allow
   **Accessibility** too for input. The entry may name Terminal or scrcpy.
   Only grant it to the launcher/binary you just built.
4. Stop, quit/reopen the launching Terminal if macOS requests it, run the start
   command again, and retry. Without Accessibility the stream is view-only.
5. Verify the whole desktop and cursor appear. Tap a harmless window, drag it,
   then use **two fingers** to scroll a long document. Check the corners for
   correct Retina coordinate mapping. Keep the Mac on its built-in display for
   this first pass; display hot-plug/resolution changes require reconnection.
6. On Android, press Home, wait 10 seconds, and return to dskcpy. Check fresh video
   and input return. Try twice. Stop in the phone toolbar, reconnect, then stop in
   the Mac dashboard. Neither should leave the mouse held down.
7. Check volume tap/hold/release and minimize/zoom on a disposable window. Long
   press an icon for its hint. Cancel the Close and Lock confirmations first.
   Only confirm those actions deliberately; macOS may pause capture while locked,
   and unlocking on the Mac/reconnecting may be necessary.
8. In Performance, record the encoder, resolution/FPS and displayed latency. The
   Mac measurement starts at encode submission and includes decode acknowledgement;
   it excludes capture wait and physical display scan-out.

Computer volume controls are separate from forwarding audio to the phone.

## Testing Mac desktop audio

Rebuild the latest source using the commands above; an old native binary will
still report audio unavailable. The existing audio-capable Android companion
does not need a new protocol version.

1. Start a stream, enable **Play desktop audio on phone** in Android dskcpy,
   and play a quiet, non-protected audio clip on the Mac. Check the phone's media
   volume. Keep volume low because the Mac continues playing too.
2. Activity should report `Desktop audio: ScreenCaptureKit -> Opus`. This proves
   encoder initialization, not audible playback; confirm the sound on the phone.
3. Toggle the phone-audio button off/on. It should mute/resume only the phone,
   without a burst of old sound. Test quick off/on toggles too.
4. Go Home on Android, wait 10 seconds, and return. Audio should be silent while
   away and resume with current content. Repeat, then stop/reconnect the stream.
5. Repeat over Wi-Fi with USB disconnected. Internet audio uses the same private
   VPN session but needs its own physical test. Record dropouts or stale sound,
   not only whether the encoder log appears.

If audio is unavailable, check Screen & System Audio Recording permission and
that FFmpeg includes `libopus` (`ffmpeg -encoders`). Toggle phone audio to retry.
Protected media may not be capturable. `--no-audio` disables host audio capture.
No microphone permission or microphone output is requested. The capture callback
retains at most one sample buffer, rejects oversized chunks, and never performs
network I/O. Separate audio acknowledgements cannot unblock the video window.

## 5. Then test wireless modes

- **Wi-Fi / Connect IP:** use Android 11+ Wireless debugging on the same LAN.
  Pair using the pairing address/code, then connect using the separate connection
  port shown on Android's main Wireless debugging page. Disconnect USB and test.
  The pairing port and the connection port are not interchangeable.
- **Internet:** start Tailscale on both devices and make the phone visible to
  the Mac's network (same account, accepted invitation or device share with
  appropriate network policy). In Android dskcpy, start an Internet session and
  enter its temporary secret only in the Mac dashboard's Internet tab. This
  mode needs no ADB/USB after APK installation. Do not post the secret in chat.
  Test it only after USB succeeds. No router forwarding/public ADB is needed.

## Reporting results safely

Tell me whether **build**, **video**, **tap/drag**, **two-finger scroll**,
**Home/return**, and **Stop/reconnect** passed, plus the displayed latency.
If the build fails, copy the first compiler error block and a few surrounding
lines; remove your username and folder path. If streaming fails, share the
relevant Activity error after removing device identifiers, addresses, keys and
private desktop content. Logs/screenshots are not uploaded automatically.

## Implementation notes and sources

The capture queue keeps one newest pixel buffer; encoding is serialized and the
wire permits at most two unacknowledged frames. Hardware-only H.264 uses Apple's
low-latency rate-control mode, High profile, no B-frame reordering, and explicitly
requested recovery IDRs. Annex-B SPS/PPS are sent once as configuration and
in-band on IDRs, avoiding repeated Android decoder reconfiguration.

Apple documents [ScreenCaptureKit capture](https://developer.apple.com/documentation/ScreenCaptureKit/capturing-screen-content-in-macos)
and the [High-profile requirements of low-latency VideoToolbox](https://developer.apple.com/documentation/videotoolbox/kvtvideoencoderspecification_enablelowlatencyratecontrol).
Dependency names follow Homebrew's [SDL3](https://formulae.brew.sh/formula/sdl3),
[FFmpeg](https://formulae.brew.sh/formula/ffmpeg) and
[Android platform-tools](https://formulae.brew.sh/cask/android-platform-tools).
Mac VPN discovery forces CLI mode according to the
[Tailscale CLI documentation](https://tailscale.com/docs/reference/tailscale-cli?tab=macos).

# Reverse display (experimental)

On Windows, `--reverse-display` streams a physical Windows monitor to the
Android device and sends touch events on the Android surface back to Windows.
The video path uses Desktop Duplication, a low-latency H.264 encoder, the
existing scrcpy ADB tunnel, and Android `MediaCodec` output directly to a
surface.

With the updated dskcpy companion on Android 6+, Home, Back, or switching apps
pauses video and keeps the existing session. Returning resumes on a new video
surface without reconnecting. The foreground notification lets you return or
**Stop session**; the phone toolbar also has a dedicated **■ Stop session**
button (distinct from **× Close active Windows window**). Removing the phone app
from Recents, force-stopping it, or losing the connection still ends the session.
Update both sender and APK; older senders cannot pause capture while away.

Reverse display must currently be built from source. Windows is the primary
host; an opt-in experimental [Mac host](macos-host.md) also exists. It mirrors a
physical monitor; it does not create a new Windows
display or implement Windows **Extend** mode. A true virtual display requires a
separate Windows Indirect Display Driver (IddCx).

## Quick start

Enable USB debugging, connect the device, then run:

```bash
scrcpy --reverse-display --max-size=1920 --max-fps=60
```

Choose the transport explicitly when needed:

```bash
scrcpy --reverse-display --connection=usb
scrcpy --reverse-display --connection=wifi
scrcpy --reverse-display --connection=ip:192.168.1.20:5555
```

The local dskcpy dashboard provides the same USB, Wi-Fi, and direct-IP
choices, encoder presets, device discovery, generated commands, live logs, and
capture-to-decode telemetry:

```bash
cd gui
npm ci
npm run build
npm start
```

Open <http://127.0.0.1:27183>. The service binds to localhost and launches the
native process without a shell.

The default reverse-display bitrate is tuned for desktop text (about 12 Mbps
at 1080p60). To override it explicitly, for example on a fast USB connection:

```bash
scrcpy --reverse-display --max-size=1920 --max-fps=60 --video-bit-rate=16M
```

The monitor index is zero-based and follows the order reported by Windows:

```bash
scrcpy --reverse-display --reverse-display-index=1
```

For interactive latency, USB/ADB is preferred over Wi-Fi. Keep
`--max-size=1920` for readable desktop text; lower it or the
`--video-bit-rate` only if the Windows encoder or Android decoder cannot
sustain the selected frame rate. `--video-encoder` selects the host
FFmpeg encoder in this mode (for example `h264_nvenc`, `h264_amf`, `h264_qsv`,
or `h264_mf`), rather than an Android `MediaCodec` encoder.

## Android desktop controls

The Android setup app uses Material 3 components with four destinations: USB,
Wi-Fi (including direct IP), Internet, and Settings. Navigation stays below the
page on compact displays and becomes a leading rail on wide displays. Settings
saves only the phone's audio and touch defaults, never connection secrets.

The companion places a compact control rail in unused letterbox space. It
uses a side rail, bottom bar, or compact grid and keeps 48 dp touch targets.
Cutouts, system bars and gesture areas are excluded from control placement.
If letterbox space is insufficient it overlays an edge of the desktop. Seven
frequent controls stay visible: volume down/up, phone audio, touch, Stop, More,
and Hide. More slides up a matching icon tray beside or above the main controls,
not a list dialog. On tiny windows the tray replaces the main palette rather
than clipping or overlapping it. Its Back button (or Android Back) collapses it
without leaving the stream. Hiding controls or leaving the app also collapses
the tray. The controls provide:

- desktop volume down/up: tap once, or hold for repeat after 450 ms at 100 ms intervals;
- desktop mute and a separate phone-audio toggle;
- minimize, maximize/restore, and close for the active Windows window;
- Windows lock, guarded by a confirmation dialog;
- touch-input enable/disable and Stop session; and
- hide/show for the control rail.

Closing the active window is also confirmed. Every button has an Android
content description and focus/ripple feedback. Holding any control icon shows a
toast explaining its current action, including updated audio/touch toggle labels.
Volume shows its hint once when repeating begins; other holds only explain and
do not activate the action. Volume repeat stops on release, drag-out, cancellation, loss
of focus, hiding the toolbar, or leaving the app. Touch disabling applies only to
the desktop surface, so the rail remains usable to turn touch back on.

## Desktop audio

Updated Windows sender and Android companion builds mirror system playback by
default over USB, ADB Wi-Fi/direct IP, and the authenticated Internet transport.
The phone explicitly negotiates audio, so older receivers remain video-only.
Use `--no-audio` to disable host capture for a session, or turn off **Play desktop
audio on phone** in the phone's Settings. The live phone-audio toggle does not
mute Windows; the desktop mute control does. Phone hardware volume keys control
the receiving speaker. Computer playback is not automatically silenced.

WASAPI loopback captures the default Windows playback endpoint, encoded as Opus
at 48 kHz stereo / 128 kbps with 10 ms frames. Android uses its Opus decoder and
AudioTrack. Audio and video share the existing framed connection but have
separate bounded queues and acknowledgement flow control. Stale audio is
discarded to avoid a growing backlog. No microphone permission or audio-file
recording is used. Home/Back pauses both streams; returning resumes the retained
session and mute preference. Losing audio focus pauses phone playback.

The opt-in Mac host now has an experimental ScreenCaptureKit audio path using
the same Opus framing and Android player. It requests 48 kHz stereo system audio,
not microphone capture, and keeps video and audio capture callbacks separate.
One bounded capture buffer and four unacknowledged 10 ms packets prevent growing
queues. Mute/background transitions discard partial samples, including rapid
pause/resume cycles. Audio failure reports unavailable while video can continue;
`--no-audio` disables Mac audio capture. Audible playback still needs a physical
Mac test; see the [Mac audio checklist](macos-host.md#testing-mac-desktop-audio).

Protected/exclusive-mode content or an unavailable output device may not be
capturable. Decoder/output failures disable audio without intentionally stopping
video. Changing the default Windows output may require toggling phone audio or
reconnecting. This is not a measured physical audio-latency or perfect A/V-sync
guarantee; packet loss can stall the shared TCP transport.

## Requirements and limitations

For separate internet connections, the dashboard also provides an experimental
[VPN-backed Internet mode](internet-mode.md) with a temporary session key. This
path does not require ADB or USB debugging after the companion is installed.
The USB/Wi-Fi/direct-IP modes described above continue to use ADB.

 - Windows 10 or later with Desktop Duplication available.
 - An H.264 encoder exposed by the FFmpeg build. The implementation prefers
   NVENC, AMD AMF, Intel Quick Sync, and Media Foundation before software
   H.264 when available.
 - Android 5.0 (API 21) or later with USB debugging enabled.
 - A source build of scrcpy. The build creates a debug-signed companion APK;
   the host installs it automatically for this mode. The companion owns a
   normal Android Activity window, so no overlay permission is required and
   Android 16 does not have to accept a WindowManager session from the ADB
   shell UID.
 - Touch injection targets the selected Windows monitor and the current
   interactive desktop, including multi-touch contacts. Pen/stylus data,
   Windows Ink, recording, V4L2, and Android virtual-display selection
   are not part of this first slice.

The mode deliberately keeps buffering small and disables B-frames. “Zero
latency” is not physically possible: capture, encode, USB transport, decode,
and display each contribute delay. The goal is the lowest practical latency
without allowing an unconsumed video socket to grow memory without bound.

## Platform support

| Path | Current implementation |
| --- | --- |
| Windows desktop to Android | Native video, touch and system audio; USB, ADB Wi-Fi/direct IP, and authenticated VPN Internet mode |
| macOS desktop to Android | Opt-in experimental source backend: ScreenCaptureKit/VideoToolbox video, mouse/scroll, system controls and ScreenCaptureKit/Opus audio. Wireless video is user-reported working; audio playback, broader hardware and latest telemetry validation remain incomplete. See [Mac test guide](macos-host.md). |
| Desktop to iPhone/iPad | No iOS receiver is present; the Android APK is not an iOS app |
| Web app | Working localhost control dashboard, not a browser media receiver or remote-hosted service |

Upstream scrcpy platform support does not make this fork's Windows reverse
capture, audio and input code portable automatically. The new Mac backend is
compiled only with `-Dreverse_macos=true`; ordinary Mac builds still reject
reverse hosting. Its separate native capture/input implementation needs manual
Apple-hardware validation. This source implementation is not a verified Mac
release and does not imply parity with Windows touch/audio or SuperDisplay.

A future [WebRTC](https://www.w3.org/TR/webrtc/) receiver could share browser
video/audio and a control data channel across Android, iOS and desktop browsers.
It still needs a native host for desktop capture/control, session authentication,
explicit input consent, transport integration and physical Safari/device tests.
This is a proposed extension, not existing web/iOS streaming support. The
dashboard intentionally remains bound to localhost.

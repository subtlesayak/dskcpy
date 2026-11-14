# Browser receiving (experimental)

View a Windows/Mac desktop in a receiving browser, with optional audio and
input. No companion APK is installed. The native host still captures the desktop;
a webpage alone cannot capture it or inject operating-system input.

[Start](#start) · [Connection choice](#choose-a-connection) ·
[Private VPN](#mac-browser-sharing-over-an-existing-private-vpn) ·
[Controls](#controls-and-lifecycle) ·
[Mac window/typing](#mac-window-sharing-and-desktop-keyboard) ·
[Troubleshooting](../FAQ.md)

| Page | Open it where? | Purpose |
| --- | --- | --- |
| Dashboard, normally `http://127.0.0.1:27183` | On the host computer | Choose capture/connection settings and create invitations. Keep it private. |
| Generated receiver link, receiver port normally `27180` | On the receiving device, or a local preview tab | Authenticate, play media and return permitted input. Remote links use trusted HTTPS. |

WebRTC carries H.264/Opus media; authenticated WebSocket signaling carries
control. WebCodecs/WebSocket playback remains available for Android USB tunnels.
Chrome and Edge are the initial targets; Safari/iPhone/iPad needs physical
qualification. USB browser tunneling is Android-only.

## Start

1. Build and launch the host using [Windows setup](windows-host.md) or
   [Mac setup](macos-host.md). Use that platform's configured launcher/terminal;
   bare `npm start` does not automatically select a Mac build.
2. Open the dashboard **on the computer**. Under **Browser receiver**, choose
   **This computer** for preview or **USB cable** for an authorized Android device.
   Set up trusted HTTPS/private media before choosing a remote mode below.
3. Select **Create link and code**. On a separate receiving device, scan the QR
   with its camera and open the link. For local preview, open **Receiver link**,
   paste **Connection code**, and select **Connect**.
4. Confirm readable video. Enable playback when the browser asks, and use a
   harmless input target. Select **Disconnect** in the receiver or
   **Stop browser stream** in the dashboard to end sharing.

For USB, connect a data-capable cable, enable debugging, unlock Android and
approve the host first. The generated localhost address works **on that connected
Android device** through its owned ADB reverse tunnel; keep the cable connected.

The invitation expires after five minutes and permits one connection. Its QR
credential is in a URL fragment, removed from the current history entry before
authentication; the ordinary receiver link is code-free. QR invitations use a
`/join` page so a reused tab loads the current handler. Capture starts only
after authentication. Treat the QR/code as access to the shared desktop.

An authenticated browser can resume after refresh or a brief absence, up to two
minutes. Explicit Disconnect, desktop Stop, host shutdown or expiry requires a
fresh invitation. Correct a failed host start before creating another code.

## Choose a connection

| Dashboard choice | Requirements |
| --- | --- |
| **This computer** | Loopback preview, no certificate. Keyboard forwarding is omitted to prevent synthetic input feeding back into its own field. |
| **USB cable** | Android browser, authorized USB debugging, ADB and an available owned reverse tunnel. No Wi-Fi or APK. |
| **Same Wi-Fi** | Reachable LAN, trusted HTTPS receiver origin and explicitly selected private WebRTC media interface; no ADB pairing. |
| **Direct IP** | Trusted HTTPS for the exact private address/port plus private media reachability. Plain HTTP is not a remote fallback. |
| **Internet / VPN** | Authorized private peer access, trusted HTTPS and private WebRTC UDP reachability. A carrier/public mobile IP alone is insufficient. |

Remote setup has two parts: `DSKCPY_VIEWER_ORIGIN` identifies the trusted HTTPS
receiver, and `DSKCPY_VIEWER_RTC_BIND` selects this host's reachable private IPv4
media interface. A working HTTPS page alone does not establish media reachability.
Configure these in the terminal that starts the service. Finish any active
stream before restarting an existing service with changed settings.

Native Android Internet mode is a different flow: the **phone app** generates
its secret. A browser invitation is generated on the **host computer**.
See [native Internet setup](internet-mode.md) for the former.

## Mac browser sharing over an existing private VPN

After building the native host and GUI, run `bash tools/macos-browser-start.sh` in
Terminal on the Mac. It reads the connected Tailscale account, selects its private
IPv4 interface for media, and verifies a trusted HTTPS Serve route on port 8443
forwarding only to the receiver on loopback port 27180. It does not change accounts,
create shares, install Tailscale or modify Serve. Use
`bash tools/macos-browser-start.sh --check` for a read-only readiness check.

If a dashboard is already running, end its stream and stop that service before
switching launchers. The Node launcher can reuse an existing service, which keeps
its old environment and will not pick up this launcher's private browser settings.

The receiving device needs access through the same authorized tailnet or an
accepted machine share. With different accounts, share the Mac to the recipient
account and accept the invitation there. A VPN installation alone does not grant
access. Keep Tailscale connected on both devices.

After inspecting existing Serve configuration, a separate private HTTPS mapping
can be added deliberately with
`tailscale serve --bg --https=8443 http://127.0.0.1:27180`. Preserve unrelated
mappings and do not enable Funnel. The launcher refuses a missing or mismatched
route rather than replacing it. Custom tailnet rules must permit the HTTPS route
and private WebRTC UDP traffic; firewall/access rules are not modified automatically.

Choose **Connect → Browser receiver → Internet / VPN**, create a link and one-use
code, then scan the QR on the receiving device while Tailscale is connected.
Alternatively, open the receiver link and enter its code there.
Tap Audio off to explicitly enable sound. Touch on enables pointer/touch input.
The host still requires Screen & System Audio Recording and control permissions.

For a manually managed deployment, `DSKCPY_VIEWER_RTC_BIND` selects one private IPv4
interface for WebRTC. Its default is loopback for local tests. There is no public
STUN/TURN server or all-interface media listener. The receiving browser must reach
that interface over the authorized private network. The HTTPS configuration below
still applies to signaling and receiver assets.

## Private Internet/VPN with Tailscale Serve

This is optional configuration performed by the user. It is not enabled by
dskcpy. Both devices must have access to the host through the private network;
different accounts require explicit sharing/invitation and access rules.

1. Inspect existing `tailscale serve status` before changing any proxy mapping.
2. Configure a private HTTPS proxy to **receiver port 27180**, not control port
   27183. For an otherwise unused Serve configuration, the command is:

   ```sh
   tailscale serve --bg http://127.0.0.1:27180
   ```

3. Set `DSKCPY_VIEWER_ORIGIN` to the HTTPS **origin** printed by Serve, without a
   path. Restart the dashboard so it loads the setting. For example, in PowerShell:

   ```powershell
   $env:DSKCPY_VIEWER_ORIGIN = 'https://desktop.example.ts.net'
   $env:DSKCPY_VIEWER_RTC_BIND = '100.64.0.10' # Replace with this host's private VPN IPv4.
   # Keep Windows native/runtime settings from windows-host.md in this terminal.
   npm start --prefix gui
   ```

4. Choose Internet / VPN and create an invitation. Open its HTTPS address on the
   receiving browser while connected to the private network.

Do not enable **Funnel**, forward a router port, or proxy the desktop controller.
The key allows both viewing and input; share it only with the intended receiver.
Tailscale HTTPS may require account-admin configuration. See the official
[Serve guide](https://tailscale.com/docs/features/tailscale-serve).

## Wi-Fi or direct-IP HTTPS

Use an existing trusted HTTPS reverse proxy forwarding only the receiver port,
and set `DSKCPY_VIEWER_ORIGIN` to that proxy's origin. Alternatively, dskcpy can
serve HTTPS directly with an **already provisioned** certificate/key:

```powershell
$env:DSKCPY_VIEWER_ORIGIN = 'https://192.168.1.20:27181'
$env:DSKCPY_VIEWER_TLS_BIND = '192.168.1.20'
$env:DSKCPY_VIEWER_RTC_BIND = '192.168.1.20'
$env:DSKCPY_VIEWER_TLS_PORT = '27181'
$env:DSKCPY_VIEWER_TLS_CERT = 'D:\Certificates\receiver-cert.pem'
$env:DSKCPY_VIEWER_TLS_KEY = 'D:\Certificates\receiver-key.pem'
npm start --prefix gui
```

Keep the Windows native/runtime settings from [Windows setup](windows-host.md)
in the same PowerShell terminal. On Mac, use equivalent `export NAME=value`
settings and the configured native-only Node launcher from [Mac setup](macos-host.md#browser-only-build-without-an-apk).

Addresses and certificate paths above are examples. Use the host's actual private
address and your own certificate. Direct TLS starts only when a remote browser
invitation is requested; it binds the explicit private IPv4 interface, never
`0.0.0.0`. The receiver assets remain available after Stop, but there is no media
or input access without a new invitation. Exiting the service closes listeners.
The local dashboard remains bound to loopback. IPv6 direct binding is not yet
implemented. Any firewall rule must be explicitly managed by the user.

The browser must trust the issuer and the certificate must match the exact host
or IP in the URL. dskcpy does not install certificate authorities, create signing
keys, disable validation, or bypass browser warnings. If certificates are not
available, use USB, private Tailscale HTTPS, or the native Android receiver.

## Controls and lifecycle

- Touch on/off switches between desktop input and view-only. Pointer cancellation,
  focus loss, pause and disconnect release pressed contacts.
- On a touchscreen, tap to click and drag with one or two fingers to scroll.
  Scroll gestures send bounded wheel events, not pressed mouse-button drags.
  Under More, switch **Drag: scroll** to **Drag: select** when selecting text or
  dragging desktop items. Two fingers still scroll in that mode. Mouse/pen drags
  retain direct input, and browser mouse-wheel events are forwarded too. Update
  the native host and restart the dashboard for the new scroll message support;
  the macOS handler requires a fresh native build and manual device validation.
- Pause/Resume stops capture while paused; returning from a hidden tab requests a
  fresh keyframe. Switching away suspends capture and releases held contacts.
  Returning within five minutes, including after a page reload, reconnects the
  same browser to the existing native stream. No old video frames are replayed.
  After five minutes away, the session ends and a new code is required. A network
  failure may take up to ten seconds to detect before this grace period starts.
- Resume uses a separate, host-only, HttpOnly, SameSite=Strict cookie scoped to
  the receiver connection path (Secure over HTTPS). The connection code is never
  saved. The cookie cannot start a new capture: it only reattaches the browser to
  its approved, still-live session. It is invalidated on Disconnect, desktop
  Stop, native exit, protocol violation or expiry. Sessions have a twelve-hour
  maximum lifetime. Blocking cookies prevents reload recovery. Background
  continuity on Safari/iOS still requires physical-device verification.
- The video fits the available viewport without cropping or stretching. Full
  screen requests landscape orientation after entering fullscreen, from either
  portrait or landscape, and releases the lock on exit. If the browser refuses
  rotation, an inline message explains how to rotate manually.
- Hide controls maximizes the video area. A compact, labeled Show controls icon
  stays in the black margin without covering desktop pixels. When neither
  margin has enough space for its 44-pixel touch target, a separate control row
  is reserved below the video.
- Volume on the main bar expands computer volume down/up controls with hold to
  repeat. Window expands minimize and maximize/restore controls for the active
  desktop window. These trays reserve space above the bar without covering the
  video; tap the same button or press Escape to close. Only one tray opens at a
  time. More keeps the drag-mode preference, session details and Disconnect.
- Audio begins muted and requires a user gesture. Muting affects browser playback,
  not the computer's output volume.
  A reload, or the browser suspending its audio engine, may require another tap
  on Audio off to resume sound.
  Delayed playback callbacks from an earlier mute, pause, background transition
  or disconnected session cannot change the current audio controls or show a
  stale error. A current playback denial restores mute and offers a retry.
- Close and Lock are deliberately not exposed in this experimental browser
  receiver. Matching full-desktop Mac and Windows hosts can advertise the
  optional keyboard capability described below.
- Disconnect and Stop end capture. USB cleanup removes only the tunnel created
  by this session; it refuses to overwrite existing ADB mappings.

## Mac window sharing and desktop keyboard

Build the native host and dashboard from this revision. The local dashboard
shows **Choose what to share** when the Mac binary advertises the new options.
**Refresh windows** reads the current local catalog without starting capture.
Select the exact window before creating an invitation. The local window catalog
is not sent to receivers; an optional switching list sends only the labels you
explicitly approve. Titles are not stored in logs or performance exports. Selection
also binds the current owning process, and native capture revalidates it. A missing
selection never silently falls back to the desktop.

Window sharing is a deliberately separate view-only mode with audio off.
ScreenCaptureKit captures only the selected window, including when another
window covers it. Resizing letterboxes into the original output canvas.
Minimizing, hiding or closing the window ends the session; create a fresh
invitation after selecting an available window. Touch, keyboard, host volume
and desktop-window actions are rejected at both bridge and native boundaries.
The owner can instead approve two to eight windows before creating the grant;
the receiver may switch only within that list. See [approved window switching](browser-window-switching.md)
for capture retirement, Stop/permission vetoes and memory-only last-viewed previews.
Target-relative window control and window audio remain unavailable.

For a full-desktop Mac or matching Windows session on a receiving device, select **Keyboard** and keep **Type on the
computer** focused. Physical navigation/function keys and shortcuts use paired
key events; ordinary text and completed IME composition use bounded Unicode
messages. The typing field supports up to 512 UTF-16 code units per commit,
split into UTF-8 packets of at most 512 bytes. Keyboard input does not read the
clipboard or save typed text. The separate [clipboard feature](browser-clipboard.md)
requires its own invitation permission and current-viewer opt-in. Explicit browser
paste goes through the same input limits.
Browser/OS-reserved shortcuts may remain local; protected Mac input fields may
reject synthetic input. These restrictions are not bypassed.
The **This computer** preview omits keyboard forwarding to prevent injected keys
from feeding back into its own focused typing field. Use a separate receiver
for keyboard tests; avoid opening its typing field on the host computer.

Blur, Touch off, pause, page hiding, connection replacement and Stop release
held keys. The Mac native host also checks Accessibility and session/display state.
If permission is revoked, input is blocked; pending releases are attempted after
permission returns. Actual held-key/permission recovery still requires hardware
verification. Windows additionally enforces input-desktop/integrity and owned-key
cleanup gates; see [Windows keyboard limits and qualification](windows-browser-keyboard.md).
Older native hosts without the required capability retain their previous behavior.

The optional native input extension keeps existing message IDs and media framing
unchanged: ID 8 is five bytes (type, down/up/cancel action, big-endian USB keyboard
usage, modifier bits); ID 9 is type, big-endian 16-bit UTF-8 length, and 1–512 text
bytes. Existing Android companions are unchanged. The browser bridge admits the
extension only for a native-capable authorized desktop session.

For a separate candidate build without replacing the launcher's working binary:

```sh
meson setup build-macos-features -Dcompile_server=false -Dreverse_macos=true -Dusb=false -Dbuildtype=debug
meson compile -C build-macos-features
meson test -C build-macos-features --print-errorlogs
```

When your current session can stop, use the Node launcher in the terminal with
its existing private HTTPS/media settings:

```sh
export SCRCPY_GUI_BINARY="$PWD/build-macos-features/app/scrcpy"
export SCRCPY_ICON_DIR="$PWD/app/data"
# Remote mode also needs your existing DSKCPY_VIEWER_ORIGIN and DSKCPY_VIEWER_RTC_BIND.
node gui/scripts/launch.mjs
```

`tools/macos-browser-start.sh` always selects `build-macos/app/scrcpy`; it does
not preserve a `SCRCPY_GUI_BINARY` override for this alternate directory.

Window selection is also available through
`--list-reverse-windows` and `--reverse-display --reverse-window=<id>`; IDs are
ephemeral local choices, not remembered identities.

## Bounded WebCodecs recovery

The WebCodecs path checks the host's H.264 profile and stream dimensions before
allocating a decoder. A hardware decoding error permits one software retry only
when the browser reports support for the same configuration. Decoder reclamation
and stalled output can recover on the existing authorized connection, with a
maximum of three automatic recovery attempts per connection. Pause/resume does
not reset that budget or switch a software decoder back to hardware.

Recovery retains codec configuration, discards pending frames with cumulative
acknowledgements, and requests a fresh host keyframe; it does not replay pixels.
At most three submitted frame timestamps are retained. Capability checks and
the first decoded output each have a five-second deadline. Unsupported formats,
exhausted retries and recovery timeouts end the session with a visible error.
Suspension, replacement configuration and Stop invalidate late callbacks.

The WebRTC sender requests keyframes only for routed PLI/new FIR feedback, with
the existing request throttle. Bitrate feedback does not interrupt delta frames.
These behaviors have automated lifecycle and local transport coverage; they do
not establish physical Safari, device or different-network compatibility.

## Latency and validation boundaries

There is no re-encoding in the Node bridge, no video recording, and no public relay.
WebRTC packetizes native H.264/Opus into DTLS-SRTP media. Mac browser sessions
select hardware H.264 Baseline without B-frame reordering for interoperability;
native receivers retain their existing High-profile low-latency mode. Rebuild
the Mac host as well as the GUI. This is not completion of the separate native
datagram roadmap phase.
Native video pacing remains bounded; browser decoder queues and audio scheduling
are bounded too. Stalled sockets fail closed instead of buffering indefinitely.
WebRTC retains at most one video frame and one audio packet being sent; dropping
video requests a new keyframe. Close, expiry, reconnect and shutdown revoke the
media peer, without queued-frame replay. The legacy WebSocket media path uses
TCP. Neither path guarantees zero latency.

WebRTC native acknowledgements mean RTP send completion or intentional drop,
not browser decoding. The controller does not show them as decode RTT; Activity
labels them as WebRTC-send measurements. No physical latency is claimed.
For WebCodecs, the dashboard metric measures video decode acknowledgement, not physical
motion-to-photon latency. Opus can adjust decoded timestamps for pre-skip; audio
acknowledgements use the original packet timestamp as input leaves the bounded
decode queue and do not contribute to the video latency metric.

Automated tests cover authentication, origin/Host checks, expiry, media framing,
ACK validation, reload/reconnect without relaunching capture, resume revocation,
decoder suspension and stale callbacks, orientation requests, control placement,
USB tunnel ownership and service cleanup. An opt-in Windows native test checks
that each resume promptly emits a real H.264 IDR frame instead of waiting for the
regular keyframe interval. Update and rebuild the native host as well as the
dashboard to receive native resume fixes. See the
[validation log](reverse-display-validation.md) for actual browser/native tests
and limitations. A desktop test does not prove Safari or mobile-network behavior.

Protocol references: [WebCodecs](https://www.w3.org/TR/webcodecs/),
[H.264 registration](https://www.w3.org/TR/webcodecs-avc-codec-registration/), and
[Opus registration](https://www.w3.org/TR/webcodecs-opus-codec-registration/).

## WebRTC verification boundary

The November 2026 candidate passes real private loopback ICE/DTLS/SRTP H.264 and
Opus packet tests, authentication/control isolation tests and receiver lifecycle
regressions. The actual browser receiver rendered a synthetic 640×360 H.264 pattern
locally and recovered after reload and Pause/Resume. Synthetic media is not Mac
desktop capture, audible playback or a physical mobile/VPN test.

Safari on actual iPhone/iPad, Android browser audio/input and different-network
operation require separate physical results. Capability checks do not prove every
brand, model or browser. Mac desktop keyboard/IME has source and automated
coverage; actual keyboard layouts, soft keyboards and IMEs remain device gates.

The native hosts emit 10 ms Opus packets. WebRTC uses a 48 kHz sample clock with
at least 480 ticks per packet, including packets dropped during an in-flight send;
native enqueue/ACK timestamps are not audio sampling timestamps. Larger mute or
route-change gaps remain gaps. Automated burst/wraparound regressions pass, but
audible device audio and route recovery still require physical qualification.
See the [audio-clock qualification record](testing/mac/browser-audio-clock.json).

# Browser receiving (experimental)

dskcpy can send the native desktop H.264 stream to a browser using WebCodecs and
WebSocket. Optional Opus audio and authenticated touch input share the same
connection. This is a media receiver, separate from the localhost dashboard.
No APK is needed for this receiver. Native iOS software is not included.

## Start

Build the native host, then update and start the dashboard:

```sh
npm ci --prefix gui
npm run build --prefix gui
npm start --prefix gui
```

Open the displayed control address on the computer. Under **Connect → Browser
receiver**, choose a connection mode, then **Create browser session**. Open the
receiver address on the receiving device and enter the temporary key. The key
expires after five minutes, permits one connection, and is never put in a URL,
log, browser storage, or saved settings. Capture starts only after authentication.
If the page is refreshed or the connection ends, create a fresh key.

| Mode | Connection and requirements |
| --- | --- |
| Local test | Open the receiver on the host computer. Loopback HTTP needs no certificate. |
| USB | Android browser, USB debugging authorized, and ADB on the host. A temporary `adb reverse` tunnel carries the browser connection over USB. Open the displayed **localhost** address on the Android device. No Wi-Fi or APK is required. |
| Wi-Fi | Both devices on a reachable LAN. Use a trusted HTTPS hostname or IP address configured below. No ADB, USB, or pairing is used. |
| Direct IP | Connect to the configured HTTPS IP address, including its port. The certificate must cover that IP and be trusted by the receiving device. Plain HTTP is not a supported fallback. |
| Internet / VPN | Use a reachable private VPN and trusted HTTPS receiver address, for example Tailscale Serve. No ADB is used. Carrier NAT/public mobile IP alone is not enough. |

These modes change how the browser reaches the receiver; they do not change the
native codec or bypass authentication. USB browser tunneling is Android-specific;
it is **not iPhone USB support**. Safari/iPhone/iPad media, gestures and background
behavior still require physical-device testing. Browsers without WebCodecs fail
with a visible capability message instead of a black video surface.

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
$env:DSKCPY_VIEWER_TLS_PORT = '27181'
$env:DSKCPY_VIEWER_TLS_CERT = 'D:\Certificates\receiver-cert.pem'
$env:DSKCPY_VIEWER_TLS_KEY = 'D:\Certificates\receiver-key.pem'
npm start --prefix gui
```

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
- Pause/Resume stops capture while paused; returning from a hidden tab requests a
  fresh keyframe. A suspended or terminated browser may lose its connection and
  require a new invitation. Background continuity on iOS is not promised.
- Audio begins muted and requires a user gesture. Muting affects browser playback,
  not the computer's output volume. More controls contains computer volume
  (including hold/repeat) and minimize/maximize controls, not a modal dialog.
- Close and Lock are deliberately not exposed in this experimental browser
  receiver. Desktop keyboard forwarding is not implemented yet.
- Disconnect and Stop end capture. USB cleanup removes only the tunnel created
  by this session; it refuses to overwrite existing ADB mappings.

## Latency and validation boundaries

There is no re-encoding in the Node bridge, no video recording, and no public relay.
Native video pacing remains bounded; browser decoder queues and audio scheduling
are bounded too. Stalled sockets fail closed instead of buffering indefinitely.
WebSocket uses TCP: loss and relay paths can increase latency. This is not a
zero-latency or WebRTC implementation.

The dashboard metric measures video decode acknowledgement, not physical
motion-to-photon latency. Opus can adjust decoded timestamps for pre-skip; audio
acknowledgements use the original packet timestamp as input leaves the bounded
decode queue and do not contribute to the video latency metric.

Automated tests cover authentication, origin/Host checks, expiry, media framing,
ACK validation, USB tunnel ownership and service cleanup. See the
[validation log](reverse-display-validation.md) for actual browser/native tests
and limitations. A desktop test does not prove Safari or mobile-network behavior.

Protocol references: [WebCodecs](https://www.w3.org/TR/webcodecs/),
[H.264 registration](https://www.w3.org/TR/webcodecs-avc-codec-registration/), and
[Opus registration](https://www.w3.org/TR/webcodecs-opus-codec-registration/).

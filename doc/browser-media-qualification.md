# Browser media qualification

`desktop/test/browser-media-ui.mjs` runs the production authenticated receiver,
SRD parser, browser decoder and (in WebRTC mode) werift sender with generated
640 × 360 H.264 baseline video and 48 kHz stereo Opus. A bounded fake native
collector receives all control packets. It never runs the real host, captures
screens/cameras/microphones, reads the system clipboard or sends desktop input.

FFmpeg with libx264/libopus is a test prerequisite. Its installed version is
recorded; it does not replace the pinned FFmpeg used for native release builds.
The fixture generates its own temporary files and removes only those files.
Video permits two pending acknowledgments; audio permits four. A fixture must
obey flow control rather than flood the production broker's bounded queue.

Install the repository's locked GUI and desktop dependencies, then:

```sh
PLAYWRIGHT_BROWSERS_PATH=desktop/.browsers node desktop/node_modules/playwright/cli.js install chromium webkit
PLAYWRIGHT_BROWSERS_PATH=desktop/.browsers node desktop/test/browser-media-ui.mjs chromium webrtc
PLAYWRIGHT_BROWSERS_PATH=desktop/.browsers node desktop/test/browser-media-ui.mjs chromium webcodecs
PLAYWRIGHT_BROWSERS_PATH=desktop/.browsers node desktop/test/browser-media-ui.mjs webkit webcodecs
```

Each run checks actual decoded color pixels, explicit audio enable/mute/resume,
touch down/up, a balanced shortcut, exact UTF-8 text, held-key cleanup during
reload, decoded video after reconnect, initial mute and clean Disconnect. WebRTC
records inbound Opus RTP counters; WebCodecs records native AudioDecoder output.
The test mutes the video element or routes Web Audio through a zero-gain node.
It does not qualify audible playback or physical latency. Reports contain only
counters and candidate categories, without SDP, addresses, codes or identities.
The explicit WebCodecs test disables RTC only inside its owned page. The
additional automatic-recovery and native-only lanes are documented in
[browser media recovery](browser-media-recovery.md).

## Audio state after reload

The integration checks caught a WebCodecs resume ordering bug. A cached stream
header can arrive while the existing host session is suspended, causing its
initial audio-off command to be ignored. The receiver now reapplies audio intent
after the explicit resume for both transports. A fresh muted page turns native
audio off; a WebCodecs page can enable it only after prior explicit consent and
while its AudioContext is running. Pause keeps capture muted. This change does
not upgrade or restart an installed host automatically.

## Recorded limits

On the development Mac, Chromium WebRTC and WebKit WebCodecs pass these synthetic
checks. WebKit WebRTC still fails before video: ICE gathering remains pending
with one mDNS candidate. A separate native WebKit peer-pair data-channel probe
connects. Testing the sender on the existing LAN interface, a diagnostic full-ICE
sender and bounded/early-answer candidates did not establish media. The failing
experiments are preserved locally; none of those product changes is shipped.
The root cause remains unresolved. The `webkit auto` lane now records whether
the actual RTC attempt works or recovers to WebCodecs; recovered receiving must
not be counted as a passing WebKit RTC lane.

On macOS 15 CI, the same WebKit 27.2 automatic lane received native RTC video
and Opus without fallback at source adcfe531. This environment-specific result
does not explain the local development-machine failure or qualify Safari/iOS.
The [adaptive-video candidate](adaptive-browser-video.md) adds a generated-media
lane with injected congestion and a fake native sink, preserving this distinction.

Playwright's WebKit engine is not branded Safari. Engine versions and platform
codec availability differ, so these checks do not qualify Safari, iOS, Android,
real software keyboards, private-VPN reachability, permissions or hardware audio.
[Playwright browser documentation](https://playwright.dev/docs/browsers#webkit)
explains those differences. Separate physical tests remain required before
claiming support or activating an update on a user's remote host.

## ICE-lite SDP scope

The pinned werift 0.27.0 serializer emits `a=ice-lite` inside media sections.
[RFC 8839 §5.3](https://www.rfc-editor.org/rfc/rfc8839.html#section-5.3)
defines this flag at session level only. The host now moves that known generated
flag before the first media section and consolidates duplicate copies. All other
SDP lines, including candidate addresses, credentials, fingerprints, codecs and
ordering, remain unchanged. Invalid or missing host-generated ICE-lite offers
fail closed. There is no new ICE server, interface discovery, public relay,
trickle signaling, client answer rewrite or change to authentication.

A regression on the real generated two-track offer fails before this correction;
serialization, idempotence, bounds and real private-peer media checks pass after
it. This standards correction alone has not established WebKit WebRTC media.
A diagnostic WebKit answer reaches stable signaling and parses the offered UDP
candidates, but its statistics show no remote candidates or candidate pairs.
Both media and data-channel werift offers stall, while a native WebKit peer pair
connects. The connection failure remains open; it must not be labeled a codec
failure, a proven OS-permission cause or a Safari compatibility fix.

# Automatic browser media recovery

A compatible receiver first tries WebRTC. If setup times out, negotiation fails
or the RTC connection fails, it can switch once to the existing WebCodecs path
using its current authenticated capture. The receiver reconnects automatically;
it does not need a new invitation or restart the native host. The selected mode
is retained for later reloads through the existing session-status response.

Both the controller and receiver must be updated to enable this feature. A page
refresh against an older controller keeps the old contract. Do not update an
installed service while a remote user relies on it without agreement.

## Negotiation and boundaries

A receiver with VideoDecoder and EncodedVideoChunk offers the optional
`dskcpy.receiver.media-fallback.v1` WebSocket subprotocol. Only an authenticated
socket selecting that protocol receives the `mediaFallback` capability. Older
viewers, older controllers and native-RTC-only browsers get no new recovery
messages. USB still selects its existing WebCodecs route directly.

The viewer may send the fixed `media-fallback` request. A negotiated controller
may also recover from an RTC sender failure. The controller pauses video, mutes
capture, cancels held touch/keys, disables clipboard transfer and drains bounded
in-flight acknowledgments before retiring the RTC epoch. It changes only the
media mode and acknowledges that change before closing the old viewer socket.
An acknowledgment is needed because the tested WebKit engine omitted the
service-restart close code. Invalid, unnegotiated and repeated requests fail
closed; switching back to RTC in the same session is not supported.

The existing HttpOnly same-origin resume cookie, host/origin checks, capture
scope, view-only policy, revocation, original lifetime and suspension deadline
remain in force. No token is exposed to JavaScript or stored in browser storage.
There is no new capture grant, native process, public relay, certificate bypass,
interface discovery or change to SRD/native input protocols. Recovery uses only
the original session: if that session ended, the receiver will not silently ask
remembered access to start a new capture. The user must choose to reconnect.

After changing media, audio starts muted and requires a new audio-button tap.
Typing composition and held input are cleared rather than replayed. A viewer
that is away or paused defers a client-initiated change until return/resume.
Playback gesture denials offer their existing retry instruction and do not
trigger a transport change. Explicit Stop, Disconnect, permission failure and
session expiry remain terminal. Physical background/PiP behavior during a media
change still needs device testing.

## Verification

Broker and receiver regressions cover negotiation, same-capture/cookie resume,
legacy denial, view-only input restrictions, cumulative acknowledgment cleanup,
late RTC answer/frame failures, canceled setup, pause/away deferral, missing
close metadata and denial of a new remembered capture after session termination.
Closing a viewer retires its generation immediately, before the reconnect delay.

The generated-media suite adds:

```sh
PLAYWRIGHT_BROWSERS_PATH=desktop/.browsers node desktop/test/browser-media-ui.mjs chromium fallback
PLAYWRIGHT_BROWSERS_PATH=desktop/.browsers node desktop/test/browser-media-ui.mjs chromium connected-fallback
PLAYWRIGHT_BROWSERS_PATH=desktop/.browsers node desktop/test/browser-media-ui.mjs chromium native-only
PLAYWRIGHT_BROWSERS_PATH=desktop/.browsers node desktop/test/browser-media-ui.mjs webkit auto
```

`fallback` injects an RTC setup error while keeping actual H.264/Opus decoding.
`connected-fallback` first establishes real RTC receiving and enables test-muted
audio, then holds a fake-native key and injects the sender failure callback while
closing its owned RTC peer. It verifies recovered video, key release and native
audio mute. This is fault injection, not a physical network-loss test.
`native-only` removes WebCodecs APIs and verifies healthy native RTC without the
optional capability. `auto` uses the actual engine's RTC attempt and records
whether RTC works or recovery was needed. A recovered run verifies one initial
code message, none on resume, one native capture throughout, decoded pixels,
explicit audio/mute, a mapped touch tap, mouse drag/release, wheel input, exact
Unicode, reload and Stop. Physical touch dragging/two-finger gestures remain
separate device tests. Sound is test-muted;
these checks do not qualify audible playback or physical input latency.

On the development Mac, WebKit recovered from its actual pending-ICE failure to
WebCodecs. This does not fix the underlying WebKit RTC issue or qualify Safari,
iOS, other physical devices or different networks. Those remain separate gates.

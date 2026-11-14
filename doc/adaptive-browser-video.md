# Adaptive browser video candidates

The updated Mac host can reduce video bitrate and encoded frame rate when the
receiving browser reports sustained network, queue or decoder pressure. Quality
can recover slowly when measurements stay healthy. Resolution and capture scope
stay fixed. This is a source candidate, not a hardware-qualified deployment.

In the dashboard's Performance page, **Adjust browser video automatically**
controls the next stream. The selected bitrate and FPS remain upper limits.
The beginner desktop shell requests automatic video on capable hosts. In the
receiver's Options, the same labeled switch can restore manual limits. An
[explicit automatic/manual choice](browser-video-preference.md) is remembered
in this browser for the current receiver origin and restored only after the next
authenticated, capable stream is ready. The status shows the last settings reported by the native
encoder, as targets/caps rather than measured throughput. The switch is disabled
while paused or unavailable. Older native hosts retain manual mode. The separate
[Windows candidate](windows-adaptive-video.md) uses checked encoder replacement;
its additional native marker is required before enabling it.

## Capability and authority

The native Mac opt-in is `--reverse-adaptive-video`, with the help marker
`browser-adaptive-video-v1`. It requires a full-desktop reverse socket, a manual
bitrate of 0.5–64 Mbps and the experimental Mac backend. It cannot be used for
window capture or native Android transport. The controller requires native
capability plus owner configuration; it never infers support from browser APIs.

The authenticated `adaptiveVideo` capability is optional. Only a current viewer
that sends `video-quality-subscribe` receives new status messages. Older cached
viewers receive no unknown message type. The browser sends bounded JSON counter
deltas, never arbitrary native encoder values. General browser input validation
continues to reject quality actions. The controller alone selects appended
system actions 12/13/14: original, balanced, reduced. Existing two-byte system
action framing, media framing, SRD version and Android actions 0–11 are unchanged.
These new action values are an opt-in extension, not an unchanged native contract.

The native host independently computes each target from immutable launch limits:

| Level | Encoded FPS cap | Bitrate target |
| --- | --- | --- |
| Original | Owner's limit | Owner's limit |
| Balanced | Smaller of 30 or owner's limit | 60% of owner's limit |
| Reduced | Smaller of 15 or owner's limit | 30% of owner's limit |

Reduced rates have a 0.5 Mbps floor and never exceed the owner-selected cap.
On Mac, the encode thread changes VideoToolbox's AverageBitRate property and its own
frame pacing. Capture continues to retain only its newest frame. There is no
encoder/capture restart, geometry change, permission request, audio transition,
input cancellation, new invitation or added public listener. A failed property
setter preserves the last applied FPS/settings, disables adaptation and reports
unavailability; it does not terminate the stream. A callback-based native test
checks rejected targets and failed application without altering prior settings.
Actual VideoToolbox rate-control behavior still needs physical qualification.

## Measurements and lifecycle

Every two seconds, a capable receiver samples only video counters. RTC uses
inbound decoded/dropped frames, decode time, packet-loss deltas and selected-pair
RTT. WebCodecs uses decoded/discarded counters, bounded pending queue and enqueue
to output residence time, which includes decoder buffering/draining. Unknown
measurements stay unknown. These measures are not physical touch-to-display
latency, and decoder residence is not pure decoder CPU time. No addresses,
candidate identifiers, SDP, audio data, application contents or browser storage
are collected.

The controller checks schema/ranges, sequence and a minimum 750 ms cadence.
Two pressure samples can reduce one level; reductions are at least five seconds
apart. Ten healthy samples are needed to raise one level. Idle desktop intervals
cannot raise quality. RTT is compared with the observed path baseline, so a
constant long-distance delay alone is not classified as congestion. Thresholds
are provisional and need repeatable physical network/decoder workloads.

Pause, background, reconnect, capture replacement and transport handoff discard
measurement history. Retired async reads cannot publish after an immediate
pause/return. Old viewers and stopped native children cannot update a new epoch.
The native status comes only from the current child through fixed bounded stdout
metadata, separate from logs. Audio consent, keyboard/clipboard policy, held
input and the original authorization/recovery deadlines retain their contracts.

## Verification and remaining gates

Node fixtures cover hysteresis, idle/relative RTT, malformed/reordered samples,
cadence, pause/return generation retirement, subscription/view-only/native gates,
fixed actions, manual restore and stopped-child metadata. Native target/application
fixtures run without capture or OS input, including sanitizer builds.

`desktop/test/browser-media-ui.mjs chromium adaptive` uses actual generated
H.264/Opus decoding with a fake native sink and injected congestion advisories.
It checks reduced/original commands, continuous test-muted audio transport,
retained held input, accessible keyboard switching, 320px/RTL layouts, exact text,
mapped input, reload and Stop. The same flow can run as `webkit adaptive`.
It does not measure real native bitrate changes, audible quality, latency,
different-network adaptation, physical touch or a mobile software keyboard.
No live service is upgraded by these tests. Physical Mac/phone/Safari, Windows
encoder/driver qualification, output routes, original Android blockers and release gates remain open.

References: [Apple VTSessionSetProperty](https://developer.apple.com/documentation/videotoolbox/vtsessionsetproperty(_:key:value:)),
[WebRTC statistics](https://www.w3.org/TR/webrtc-stats/).

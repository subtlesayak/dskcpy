# Experimental Windows browser video adaptation

The Windows candidate accepts `--reverse-adaptive-video` on a full-desktop
reverse socket, within the existing 0.5–64 Mbps manual limit. Its separate help
marker is `browser-adaptive-windows-v1`, in addition to `browser-adaptive-video-v1`.
The controller requires both Windows markers, explicit owner configuration and
the existing authenticated quality subscription. Older Windows binaries already
mention the Mac flag in help; that text alone must never enable this feature.
Window capture, native Android transport and old binaries remain outside it.

The existing fixed levels retain immutable launch caps: original, at most 30 FPS
and 60% bitrate, at most 15 FPS and 30% bitrate, with a 0.5 Mbps floor. Existing
actions 12–14 request only these levels. Native requests are coalesced and actual
encoder attempts are at least five seconds apart. Requests admitted while paused
or stopped cannot begin preparation or release held input. The existing measured-feedback policy
and explicit manual restore remain unchanged.

Windows does not infer successful NVENC live reconfiguration from context fields
or an accepted frame. The capture thread drains its old ACK window, retains the
working encoder and privately opens a same-codec candidate with the requested
nominal bitrate/FPS. Pixel format and Media Foundation hardware/software mode are
retained. Profile/level are fixed to the original H.264 negotiation. Exactly one
immediate key packet is allowed; delayed or extra packet warm-up is rejected.

Before publishing, the candidate must provide bounded complete SPS/PPS and an
actual IDR in the picture, match the negotiated profile/level, and decode in the
public software H.264 decoder to the exact capture dimensions. Decoder allocation
is capped to their macroblock alignment; parameter sets are limited to 64 KiB and
32 entries, and the picture to 16 MiB. Configuration cannot supply an old picture
in place of the IDR. No capture, hardware decoder or OS input is used by this gate.
Only parameter sets are copied for configuration; encoded pictures are not cached.

Stop, pause and a coalesced request are checked again before publication. A failed
open, format/packet/configuration or decode check discards the candidate, retains
the old usable encoder/settings, disables automatic adjustment and reports
unavailable. A compatible candidate publishes fresh parameter sets and a keyframe
on the existing media connection before replacing the old encoder. Capture
geometry, stream-relative timestamps, authorization, audio and input stay intact.
A transport write failure after publication is fatal; it is not reported as a
safe rollback. Targets are accepted codec settings and host FPS caps, not measured
physical bitrate or latency.

FFmpeg/driver calls are synchronous and cannot be forcibly cancelled through the
public API. The existing stall watchdog still applies. The bounded frame/packet
count does not guarantee uninterrupted operation if a driver hangs in open,
encode or teardown. Hardware resource limits may prevent two encoder contexts;
that is an unavailable adjustment, retaining manual operation on preparation
failure. Actual Windows driver timing, sustained rate control, audible audio,
held-input behavior and recovery require physical qualification before deployment.

The required Windows CI fixture compiles the production encoder factory,
normalization and transaction bodies against real software FFmpeg and fake
publication effects. It verifies private validation, unchanged old-encoder
usability after rejected preparation, cancellation/coalescing after open, exact
geometry/PTS, successful publication and fatal write failures. Both LF/CRLF forms
are checked. Native tests exercise a generated in-memory IDR, cropped geometry,
profile/size rejection and SPS/PPS-only extraction. These tests never capture a
screen, inject OS input, grant access or update an installed host. A passing
software fixture does not qualify an actual GPU encoder or an end-user device.

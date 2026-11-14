# Browser RTC codec parameter updates

The private RTC sender retains bounded H.264 SPS/PPS configuration separately
from encoded pictures. It adds missing parameter sets to keyframes, preserving
the access-unit delimiter and placing SPS before PPS. Existing sets and picture
data are not duplicated. This supports encoders that supply parameter sets only
through the native configuration packet, or supply just SPS in a keyframe.

When a native configuration packet changes parameters within the negotiated
profile and level, the existing sender accepts the new sets and waits for an IDR.
It retains the peer, RTP sequence/SSRC, audio sample clock, authenticated session,
native capture and held input. A keyframe already in flight cannot satisfy the
new configuration epoch. Only SPS/PPS are retained; old pictures are never cached
for replay. Configuration input is limited to 64 KiB and 32 parameter sets, with
both SPS and PPS required for updates. Startup remains compatible with an
SPS-only initial configuration when PPS arrives in the first keyframe. An invalid or changed negotiated profile is rejected
before replacing the last working configuration. The existing negotiated media
failure policy then determines recovery; no new capture consent is created.

The generated-media check uses two software H.264 encoder outputs at 640 by 360.
FFmpeg's trace_headers verifies SPS/PPS IDs 0 for the first and 1 for the second.
The initial keyframe omits PPS, and replacement keyframes omit both sets, forcing
the sender to supply the separate configuration. An actual headless Chromium
decoder must render the replacement's blue pixels on the same peer while a test
modifier and generated Opus remain active. Reload, Unicode input, mute and Stop
are also checked. These checks use generated media and fake native input. They
do not qualify audible playback, real applications, a phone or Safari hardware.

This is a prerequisite for Windows encoder replacement, not Windows adaptive
streaming itself. Windows still uses manual video settings. Candidate encoder
preparation, verified first IDR/configuration, bounded rollback, fixed geometry,
timestamps, actual hardware bitrate/FPS and network behavior remain separate
implementation and qualification gates. No installed host is updated by tests.

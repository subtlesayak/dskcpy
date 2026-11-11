# Bounded Mac audio feeding

The audit's P1 audio work adds an original worker-side feed routine. A fresh
4,800-frame (100 ms at 48 kHz) capture chunk previously passed to the bulk push
API was immediately trimmed to four 480-frame packets (40 ms). The worker now
feeds one codec frame at a time and waits for the existing four-packet ACK window
to drain, retaining the same PCM buffer and 80 ms receive-age cutoff. Capture
callbacks still only enqueue bounded samples; mute/Stop cancels feeding and
does not flush a tail. Existing bulk-push callers keep their behavior.

Deterministic fake-clock/ACK tests reproduce the old 2,880-frame trim, transmit
all ten packets with progressing ACKs, bound a stalled receiver by the age
cutoff, and stop on mute. These are simulated encoder/worker tests, not audible
playback or physical latency measurements. No protocol/window-size change or
receiver implementation is required.

The Mac worker logs rate/channel/sample-layout changes and cumulative
current-encoder packet, stale-frame, full-window and catch-up trim counts every
two seconds while PCM is processed. Capture-queue overflow is counted across
encoder epochs. Counters contain no device names or identifiers; encoder counts
restart on encoder recreation. These counts localize source-side loss, not
receiver underflows or end-to-end playback quality.

Pending physical gate: use a quiet harmless test sound with one identified
native/receiver artifact; verify audible playback, mute, route/device changes,
Home/return and 30–60 minutes on USB and local Wi-Fi separately (private VPN
separately when available). Record audible dropouts, source hashes, transport
and sample duration. Never substitute decode ACK success for audible quality,
or label decode RTT as physical touch-to-display latency.

The unrelated historical Android display-socket startup stall still needs the
matching source/APK handoff and independent repeated-start testing. A successful
retry or the browser decoder-drain fix does not close that gate.

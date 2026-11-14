# Browser capture recovery (Mac candidate)

A matched Mac native host and controller can replace a capture after a known
display change or sleep event while retaining the browser's existing session
authorization. This is a fresh native process, immutable SRD1 header and media
epoch. It does not modify an old encoder's geometry in place or change SRD1 or
Android input/media formats. It is not installed or activated on the office host.

The native help capability `browser-capture-recovery-v1` gates the controller.
Only full-desktop Mac browser sessions opt in; window/view-only streams, older
hosts, Windows and Android-native sessions do not acquire capture restart.
After input/media cleanup, a fixed stdout marker reports `display-change`,
`sleep`, or non-recoverable `permission-lost` / `user-stop`. No display, window, device or
network identity or user text is included. Unknown markers never start capture.

The broker briefly retains its existing cookie/origin/lifetime while the owner
classifies native exit. It releases input and drops cached media/ACKs while
waiting for the controller. Only a confirmed recovery closes the old viewer
socket with standard restart code `1012`; all server-ended browser sessions use
a terminal code so
cached viewers do not enter automatic remembered-device fallback.
Only native exit `2` with an explicit eligible reason may rebuild. The controller
waits for the child's `close` event, after stdio is drained, then reprobes and
spawns the same authorized profile on a fresh loopback native socket. Existing
browser resume reconnects without a new invitation. A new header updates all
dimensions; WebRTC gets a new peer/offer/answer, and old asynchronous callbacks
cannot acknowledge or close the new capture. Pending typing is cleared, Touch
off remains off, and the existing audio choice is reapplied through normal gates.
Fresh WebRTC capture explicitly restores the prior audio choice, including after
Pause/Resume; a new native process otherwise starts muted. Keyframe feedback is
gated by explicit video pause so an RTCP request cannot silently resume capture.

Native shutdown classification is bounded to 15 seconds; a new native connection
has its existing limit of 10 seconds. A resumed browser attempt allows up to 30 seconds
inside the original five-minute resume deadline. At most three capture restarts
are allowed per 30 seconds; neither a restart nor a reload extends the session's
overall lifetime. Missing native reasons expire authorization rather than loop.
No authenticated viewer returning within the normal resume bound means sharing
ends; a fresh invitation or previously approved remembered browser is then needed.

User Stop, Disconnect, revocation, permission loss and shutdown veto recovery.
Known OS Stop and permission loss also pause remembered access on the host.
Normal server close `1000` is terminal in the updated receiver. Approved-device
fallback after transport loss remains available; it does not automatically
override a server-ended session. Explicit remembered reconnect remains separate.
The native classifier retains late user-stop events during geometry teardown and
checks capture permission again before publishing its final reason. The host
does not request permissions, change TCC/security settings, elevate, change a
private route or enroll a device as part of recovery. Physical OS stop-callback
timing and permission races still require explicit device qualification.

Automated qualification uses pure native classification and owned fake-host
TCP/process fixtures: new dimensions, cleanup, origin-bound cookie retention,
discarded old media/input, bounded retries, unknown/permission/Stop exclusions,
and cancellation during readiness. Real Chromium covers portrait/landscape,
WebCodecs transport and fresh WebRTC offer/answer exchanges using synthetic
headers/input. These checks do not prove physical screen, audio, phone keyboard,
sleep/wake, display hot-plug or output-route recovery. Test those on a matching
installed candidate only in an agreed maintenance window.

References: [Node child close versus exit](https://nodejs.org/api/child_process.html#event-close),
[Apple capture permission preflight](https://developer.apple.com/documentation/coregraphics/cgpreflightscreencaptureaccess()).

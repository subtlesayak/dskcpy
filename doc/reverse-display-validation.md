# Reverse-display regression validation

Automated checks run locally without sending frames, input, secrets, account
metadata, or diagnostics to external services. The pull-request workflow builds
and tests clean hosted checkouts; it does not run desktop capture or physical
device tests, and does not publish a release.

## Automated checks

From the repository root:

```sh
npm --prefix gui test
npm --prefix gui run build
meson setup .tmp/native-validation --buildtype=debug -Dcompile_server=false
meson compile -C .tmp/native-validation
meson test -C .tmp/native-validation --print-errorlogs
./gradlew :server:testDebugUnitTest
```

On Windows, run Gradle with `gradlew.bat` and use an MSYS2 MinGW environment
for Meson. Set `ANDROID_HOME` to the installed SDK. If PowerShell blocks npm's
script shim, use `npm.cmd`. Existing Gradle caches can be used with `--offline`.

The service tests exercise real loopback HTTP requests with simulated child
processes: malformed targets, concurrent starts, failed launches, readiness
failures, cancellation, disconnect recovery, graceful stop, forced fallback,
and event-stream shutdown. Runtime tests cover custom assets, PATH resolution,
loader failures, and transport-specific requirements. Native watchdog tests
use a controlled clock for missing, duplicate, future, partial, and complete ACKs.

For clean Android packaging, configure separate empty Meson directories with
`-Dcompile_app=false`, once with `--buildtype=debug` and once with
`--buildtype=release`. Compile each, confirm both `server/scrcpy-server` and
`server/reverse-display.apk` exist, and run the SDK's `apksigner verify` against
each companion. The debug companion should match Gradle's debug APK byte for
byte. The server artifact is intentionally different in release builds.
Both outputs are declared in Meson and installed under `share/scrcpy`.

## Optional native loopback smoke test

Set `SCRCPY_NATIVE_INTERNET_TEST=1` and run
`node --test gui/server/native-internet.test.mjs` on Windows.
`SCRCPY_TEST_BINARY` can select an explicit freshly built client.
The test captures desktop frames into loopback memory only, discards them,
sends frame ACKs, and exercises disconnect/stop/timeout handling. It sends no
touch, keyboard, clipboard, close-window, or lock actions. It is not a phone test.

## Physical-device checks — manual, not covered by unit tests

Use a consenting test phone and a disposable desktop window. Record the host
build, encoder, phone/Android version, transport, result and observed delay
locally. Do not include session secrets or screenshots of private desktop content.

| Scenario | Procedure | Expected result |
| --- | --- | --- |
| Disconnect during drag | Drag within the disposable window, then disconnect USB or stop the phone session before lifting the finger. | Touch contacts and mouse fallback release; ordinary mouse movement does not continue dragging. |
| Stop during drag | Repeat the drag and select Stop in the dashboard. | Input releases during graceful exit; a subsequent stream starts normally. |
| Decoder/ACK stall | Suspend the receiving test decoder while keeping its connection open. | Host reports a stall after approximately ten seconds, closes transport and releases input. Dashboard offers Reconnect. |
| Idle desktop | Stream an unchanged desktop for at least 30 seconds. | No false stall while all sent frames have been acknowledged. |
| Monitor changes | Change resolution/orientation or unplug the selected secondary monitor. | Either video remains correct or the stream exits visibly; it never silently injects into an unintended monitor. Record unsupported configurations. |
| USB/Wi-Fi repeat | Start and stop three times on each transport; test an unauthorized and an offline phone. | No orphan helpers; accurate authorization errors; fresh starts remain possible. |
| Two-account cellular | With both owners' consent, share the receiving phone, accept the invite, and connect while it uses mobile data. Use a long fresh secret. | Mutual authentication, desktop video, intended touch input, and session cancellation work. Revoke the share after the test. |
| Network loss | Disable the phone VPN or interrupt the route during streaming. | Session closes or the host watchdog detects stalled progress; a new Internet session is required. |

Physical display latency, cellular reliability, Windows input behavior and vendor
decoder compatibility require these checks before claiming production readiness.

## Verified background resume — 2026-09-05

Implemented a started/bound connected-device foreground service for the Android
receiver. The network session and decoder no longer belong to the Activity.
On Android 6+, a private parking surface preserves the decoder while SurfaceView
is absent; pending output is discarded and acknowledged. Ordered pause/resume
commands stop host capture and refresh the desktop when the phone returns.
Pause also releases held contacts; lifecycle messages cannot be dropped by a
full touch queue. Explicit phone Stop has a clean protocol shutdown.

Local checks with a consenting Samsung SM-S721B:

- USB: three Home/Back-return cycles retained the same sender and restored video,
  including a 13-second background interval beyond the normal stall timeout.
- Tailscale Internet mode: authentication while the phone was away, then three
  Home/Back-return cycles passed with the same sender. Disabled touch stayed
  disabled; re-enabling worked. This run used Wi-Fi, not cellular data.
- Waiting Internet session: Copy, Home and return preserved the same 12-word
  secret. Cancel cleared it. No secrets were logged or persisted by the test.
- Expanded Samsung notification: Stop ended the active Internet stream with
  desktop exit 0, no error, no remaining foreground notification, and the phone
  returned to setup. Final dashboard state was idle.
- ADB screenshots confirmed a visible desktop after returning over USB and
  Internet. These are local-only test artifacts, not publication assets.
- Android build and 72 JVM tests passed; 13 C test executables passed; 34 Node
  tests plus all four opt-in native loopback scenarios passed.

Installed APK and local companion SHA-256:
`7E408A59A4C03D321124661BBC701E78206A44A895A3E70D4FB55946D6C27E76`.

The QA harness was corrected to respect retained touch settings, expand the
Samsung notification, and avoid reusing HTTP sockets after blocking ADB calls.
Those harness failures were not stream-disconnect evidence.

Not claimed: reconnection after process death, force-stop, Recents removal,
VPN/network failure, cellular resume on this build, or compatibility with every
vendor decoder. Desktop audio was not supported at that checkpoint; the audio
implementation and subsequent validation below supersede that limitation.

## Material 3 and desktop-audio update — 2026-09-05

UI audit findings addressed:

| Finding | Implementation |
| --- | --- |
| All transports mixed into one long page; USB lacks its own instructions | Dedicated USB, Wi-Fi/direct-IP and Internet destinations |
| No place for persistent receiver preferences | Fourth Settings destination with real saved audio/touch switches |
| Custom platform theme, text glyph controls and inconsistent states | Material 3 dark theme, Material buttons/cards/radios/switches/dialogs, local vector icons, selected state, ripple and focus outline |
| Volume long-press only describes the button | Cancelable 450 ms hold / 100 ms repeat policy, native click and keyboard paths |
| Controls shrink to 36 dp and less-used actions push Stop out of view | 48 dp controls, scrollable overflow, Stop/touch/Hide before window actions |
| Setup chrome ignores safe areas and orientation | Inset-aware bottom navigation, leading rail on wide displays, scrollable wrapping content |

Material components use the existing Java Views stack, not a video renderer or
Compose rewrite. The better-ui, better-layout and better-accessibility reviews
influenced distinct action states, navigation hierarchy and non-overlapping
48 dp targets.

Automated checks: 85 Android JVM tests passed (including repeat cancellation,
bounded audio queues, multiplexing, separate ACKs and audio-toggle ordering),
13 native test executables passed, 46 desktop Node tests passed, and all four
opt-in native Internet loopback scenarios passed. The four opt-in scenarios
were also correctly skipped during the default Node run.
Android lint completed with zero errors and 20 warnings (including existing
internationalization, API/dependency and launcher-icon items). API guards for
surface switching and the Android 6/7 parking-surface constructor were corrected;
those older Android versions have not been physically tested.

Physical Samsung checks: all four destinations render their own content;
Settings switches toggle and retain their state across Home/return; landscape
uses a navigation rail; navigation stays reachable at 200% system text. Local
ADB screenshots were inspected. Temporary font/rotation test settings were
restored. TalkBack speech, switch access, RTL localization and other phone
models were not fully tested; these checks are not an accessibility certification.

Before the UI migration, USB audio was captured as non-silent Windows loopback,
encoded as Opus, decoded to non-silent Android PCM and submitted to AudioTrack.
The user confirmed hearing the synthetic test tone on the phone. Phone mute
survived Home/return, unmute restarted playback, enabled audio resumed after
Home, and phone Stop ended with exit 0. Tests used a locally generated quiet
tone, not microphone recording or saved desktop audio.

On the Material build, physical phone controls changed the actual Windows
endpoint volume: short tap, repeated up/down holds, stopping on release, and
drag-out cancellation all passed. Measured button bounds met 48 dp. The test
restored the original Windows endpoint volume and mute state.

The final audio review corrected two resume hazards: an existing paused
AudioTrack must explicitly play again even without a fresh configuration, and
pausing should clear stale sound without deleting pending configuration.
Configuration arriving during a queue wait now takes priority over data.
USB logs confirmed subsequent playback generations after unmute and Home;
an ADB command timeout interrupted one QA run after playback had restarted.
Internet audio verification was blocked at setup because the phone reported
no private VPN address (Wi-Fi enabled, mobile data disabled). This is not
evidence of a failed authenticated Internet audio stream.

The full USB check subsequently passed on the final installed build: non-silent
capture and playback, retained mute across a 13-second Home interval, unmute,
enabled audio/video Home-return, and phone Stop with exit 0 / no dashboard error.
After Tailscale was enabled, Internet setup automation was interrupted by a
different app taking the foreground. The QA helper now checks foreground package
before interacting and supports scrolling the landscape setup page.

Final installed APK / colocated companion SHA-256:
`C58CAF1D605BCD8D1A33C66235A5ADB7E0AA2636DC34A5D0EAB058AF19565407`.

## Adaptive controls and slide-up tray — 2026-09-05

The preceding scrollable rail could still put lower actions offscreen. The new
layout keeps seven frequent 48 dp controls visible, switching between a side
rail, bottom bar and compact grid. Geometry excludes cutouts, visible system
bars and mandatory gesture insets. Pure geometry tests cover a 56-size matrix,
and the secondary tray adds both left-to-right and right-to-left cases.

The initial More list dialog was replaced, at user request, with a matching
non-modal icon tray that slides upward. It appears beside/above the main rail;
tiny windows temporarily replace the primary palette, retaining a Back control.
Only Close and Lock retain confirmation dialogs. Android Back collapses the
tray without backgrounding the session. Leaving the app or returning to setup
resets expansion. Local ADB screenshots were visually checked; screenshots
containing desktop content are private test artifacts, not publication assets.

Physical Samsung checks passed for seven primary and six secondary 48 dp
targets, complete onscreen bounds, non-overlap of primary controls, hide/show,
touch toggles, expansion/collapse, Android Back, and cancelling Close/Lock.
The test did not close Windows applications or lock the computer.

The authenticated VPN Internet audio check now passes: non-silent Windows
loopback capture, Opus decode to non-silent Android PCM, AudioTrack playback,
retained phone mute across a 13-second Home interval, unmute, enabled audio/video
Home-return with the same sender process, and phone Stop with exit 0 / no
dashboard error. This verifies the Internet transport, not a controlled cellular
latency benchmark, physical A/V synchronization, or every VPN route.

Android assembly and 96 JVM tests pass; lint has 0 errors and 23 warnings.
All 13 native test executables and four opt-in native Internet loopback cases
pass. The final APK includes a small cleanup that also resets an expanded tray
when the stopped session returns to setup.

Final installed APK / colocated companion SHA-256:
`08C028211E71B50F914205BEA661E8B39ADCD674D2D9EABEA3248FFB882D9345`.

The final installed build also passed the full USB check: tray controls and Back,
non-silent desktop-to-phone audio, retained mute, enabled audio/video Home-return,
and clean phone Stop. The dashboard ended idle with exit 0 and no error.

The desktop dashboard also reproduced a navigation overflow at 200% text:
Activity extended beyond the right edge. Navigation now wraps into a two-row
grid at large text sizes, grows in height,
preserves icon sizes and respects bottom safe-area padding. The desktop rail
stays available while content scrolls. During browser verification a separate
status-feed defect was found: a snapshot larger than the socket high-water mark
caused immediate destruction of a healthy EventSource connection. The service
now coalesces pending snapshots and resumes on drain, keeping one queued snapshot
per client instead of buffering every update. An oversized-snapshot/burst test
verifies continued delivery and coalescing. All 47 default Node tests pass; four
native cases remain opt-in in that default run and pass separately as above.

Playwright Chromium navigation checks on the localhost production build pass at
1440x900, 1100x320, 900x600, 820x600, 390x844, 320x568, and 390x844 with 200% root
text. Connect, Device, Performance and Activity each update their route, heading
and selected state. Page identity, meaningful content, no framework overlay,
no console errors/warnings and sidebar geometry checks pass after the service
fix. Browser plugin was unavailable, so the installed Playwright runtime was
used without adding dependencies. Browser screenshots and the temporary helper
remain outside the repository. This is not a physical Safari/iPhone or Mac test.

Platform inspection confirms the reverse host still rejects non-Windows
platforms; no iOS receiver or browser media receiver exists. The web dashboard
is a localhost controller only. The proposed Mac and WebRTC work is documented
under Platform support in reverse-display.md and is not marked implemented.

### Icon-hold explanations

All streaming control icons now share current-action toast feedback. Audio/touch
toggle hints read the live content description rather than the initial label.
An expanded More control explains how to hide the extra tray. Volume's repeat
scheduler emits one hint at the start of each hold and preserves repeated input;
short taps and cancelled holds do not emit that hint. A new hint replaces the
previous control hint, and leaving the app dismisses it.

The updated build and 99 Android JVM tests pass, including once-per-hold feedback
and cancellation. Lint remains 0 errors / 23 warnings. ADB screenshots visually
confirm More, muted phone audio and volume-up explanations. Device automation
also confirms that holding More, Close and Stop does not activate those actions,
audio hints preserve the current state, volume tap/hold/release and drag-out
cancellation work, and 48 dp volume targets remain intact. Windows volume and
mute were restored after testing. Screenshots containing desktop content remain
local-only.

Latest installed APK / colocated companion SHA-256:
`0D1CC7E623379E579AEA52BD0777082F40B60FBA9A27178ED06FB3AD52D1C7FE`.

### Experimental macOS host source slice — 2026-09-05

This entry supersedes the earlier statement that no Mac backend exists. Added
an opt-in Objective-C ScreenCaptureKit/VideoToolbox backend, selected only by
`-Dreverse_macos=true`. It sends the existing framed H.264 protocol, emulates
mouse/drag and two-finger scrolling, handles desktop actions and receiver
pause/resume, and reports audio forwarding unavailable. Its High-profile,
hardware-only low-latency configuration follows Apple's encoder constraints.
Ordinary non-opt-in Mac builds and Linux remain blocked for reverse hosting.

**Not verified here:** Apple SDK compilation, permission prompts, actual Mac
capture/encoding/input, Mac transports and Safari. The manual test target is an
M3 running the user-reported macOS Tahoe 26.5.1. A successful Windows build or
simulated Mac dashboard is not evidence of native Mac operation. See the
source-bundle instructions and checklist in macos-host.md.

Verified locally on Windows:

- Native release build succeeds; 14 C test programs pass, including bounded
  AVCC-to-Annex-B conversion, Retina/negative-origin mapping and sizing helpers.
- All four native Internet loopback tests pass (disconnect, Stop, owner exit,
  missing ACK stall). The harness now requests receiver refreshes so an unchanged
  desktop is not mistaken for a broken sender; it neither moves the user's mouse
  nor writes captured pixels to disk. Earlier runs timed out because they assumed
  at least three changing desktop frames.
- Android assemble, 99 JVM tests and lint pass; lint reports 0 errors/23 warnings.
  Phone text is now host-neutral. Rebuilt companion SHA-256:
  `A5E84561820FA4E5349A091B526E56154DE81FF8F773ECE382F8E4834CE78C45`.
  It is copied beside the desktop build and included in the source bundle; no
  new physical Android install/stream test was performed for these string edits.
- Dashboard TypeScript and production build pass. The Node suite covers Mac
  compiled-capability detection, encoder restrictions, Tailscale CLI-only mode,
  and shell-script syntax/non-Mac guards, alongside existing transport tests.
- Local Chromium QA passes seven Windows viewport/text configurations and five
  mocked-Mac cases (1440x900, 390x844, 320x568, 390x844 at 200% text, and missing
  Mac build). Page identity, meaningful content, all navigation destinations,
  console health, encoder selection and disabled missing-build state were checked.
  Screenshots exposed cramped feature labels and collapsing icons at large text;
  the existing CSS now uses separated flexible columns and text-scaled icons.
  The rerun passes spacing, icon size, sidebar geometry and overflow assertions.
  Browser plugin unavailable; installed Playwright used, with temporary scripts
  and screenshots outside the repository. This is not Mac/Safari testing.
- The local packager uses an explicit source allowlist, leaves source files
  intact, normalizes archive text to LF, excludes Git/caches/private settings and
  signing keys, and checks every ZIP payload hash. The extracted source bundle's
  Node suite is also tested independently. No code or diagnostics are uploaded.

### Mac startup assertion found by manual testing

The user's Mac Activity screenshot confirms an ADB wireless connection, Android
companion launch, hardware VideoToolbox initialization and receiver startup.
It then reports `Assertion failed: (strlen(name) <= 15)` in `sc_thread_create`.
The Mac-only caller supplied `reverse-mac-video` (17 bytes), exceeding the common
thread wrapper's limit of 15. This is a host startup defect, not evidence of a
wireless pairing failure. No private identifiers from the screenshot are copied
into this record.

The worker name is now `rev-mac-video` (13 bytes). A new Node regression scans
literal thread names in C and Objective-C call sites, explicitly requiring Mac
backend coverage even when tests run on Windows. It failed on the original
17-byte name before the fix. End-to-end Mac video/input remains pending a user
retest of the corrected source build; the Windows environment cannot execute
the native Mac worker.

### Live Mac telemetry after the successful wireless retest

The user subsequently reported that the corrected Mac wireless stream works.
Their next screenshot showed Performance still on Connecting, an unknown
encoder and no latency while video was playing. This is manual evidence of
working Mac wireless video, not a completed input/transport test matrix.

The shared logger wrote INFO/DEBUG records to stdout without flushing. Unlike
the Windows entry point, the Mac entry point did not disable stdout buffering;
a dashboard child process therefore held these records until its pipe buffer
filled or the process exited. The logger now flushes each complete record.
No capture, transport, encoding or input behavior was changed. The UI also says
it is waiting for the first decode acknowledgement when a process is already
running, rather than asking the user to start that same stream.

A no-capture C fixture uses the production logger with deliberately fully
buffered stdout. The regression failed before the fix: the control service
could not observe its encoder while the child was alive. After the fix it sees
the encoder and then decode-ack telemetry independently, before process exit.
It also checks Stop retains the last value and restart clears stale telemetry.
The fixture's 12.5 ms value is synthetic, not a Mac/network latency benchmark.

Verified locally for this update:

- Native release build and all 14 C test programs pass.
- Node suite: 54 pass, four opt-in native cases skipped, no failures. The four
  native Internet loopback cases pass separately (disconnect, Stop, owner exit,
  missing-ACK stall).
- Dashboard TypeScript and production build pass.
- Playwright Chromium on Windows passes the real local control API and
  EventSource flow at 1440x900 and 390x844. A native logger fixture replaces
  capture/ADB only. Wi-Fi Start -> Connecting/waiting -> encoder -> Live/latency
  -> Stop/last value -> reload -> restart/cleared value -> Cancel all pass.
  Page identity, meaningful content, no framework overlay, clean console,
  screenshots and horizontal-overflow checks pass. The displayed test value
  rounds to 13 ms. Screenshots were visually inspected and remain outside the
  repository. Browser plugin unavailable; installed Playwright used instead.

No new physical Android install/test or Apple SDK build was performed for this
update. Actual telemetry from the user's Mac, Safari and real connection timing
remain manual verification items. The existing companion APK is unchanged.

## Browser receiving and connection modes (2026-09-06)

The receiver is separate from the controller: fixed assets plus a WebSocket
bridge to the native SRD1 stream. Each explicit invitation grants one browser
view/control access using a 192-bit key, expires after five minutes and is not
stored in public state or browser storage. Network hosting is never enabled
automatically. USB uses an owned ADB reverse tunnel; remote modes require a
configured HTTPS proxy or trusted certificate on an explicit private interface.

Verification in this slice:

- 69 Node tests pass, including fragmented media framing, in-band NVENC SPS/PPS,
  original Opus input timestamp ACKs, authentication, origin/Host rejection,
  expiration, single-client ownership, cancellation, USB tunnel ownership and
  authenticated TLS/WebSocket. Four separate opt-in native Internet cases remain
  skipped in the ordinary suite. The TLS test generates a disposable issuer and
  validates against it explicitly; it does not disable certificate checks or
  install a certificate authority.
- Production TypeScript/Vite build passes. Receiver JavaScript syntax checks pass.
- A real Windows NVENC stream renders at 1920x1080 in the Chromium-based in-app
  browser over loopback. Video pause/resume, audio enable/mute, Touch off, More
  controls, Escape and Disconnect were exercised. More than 1,700 video frames
  decoded across the pause/resume checks. Native process cleanup was checked.
- The live test exposed NVENC's in-band SPS/PPS and Opus timestamp adjustment;
  the receiver now extracts parameter sets from the first IDR and acknowledges
  original audio packet timestamps as they leave its bounded decoder queue.
- Browser console checks reported no application warnings/errors on the passing
  live path. A 390x844 receiver layout was visually inspected without horizontal
  clipping. Direct-IP without HTTPS shows an actionable setup error.

Not verified here: audible browser playback as heard by a person, physical USB
Android-browser streaming, real Wi-Fi/IP/VPN round trips, iOS/Safari, Mac capture,
desktop hot-plug, physical motion-to-photon latency, or long-duration soak tests.
Live loopback decode ACKs are **not** phone latency measurements. No real captured
desktop frames, session keys or TLS private keys are committed or published.

Setup and limitations: [browser receiver](browser-receiver.md).

## Mac desktop audio and clean CI builds (2026-09-06)

The experimental Mac host now captures system audio through ScreenCaptureKit and
uses the existing Android Opus player. Its worker discards stale/oversized chunks,
uses a four-packet acknowledgement window and recreates encoder state after
mute/background transitions. Audio capture callbacks never perform network I/O;
audio and video acknowledgements have separate watchdogs.

Automated evidence for the audio slice:

- Windows native release build and all 15 native test programs pass locally.
- The dashboard production build passes; 54 Node tests pass locally, with four
  opt-in Windows capture/Internet cases not run in this slice.
- An Apple-silicon GitHub runner compiles the opt-in Mac host and passes all 16
  native tests. The new CoreMedia test uses synthetic interleaved and planar
  stereo buffers, verifies converted sample values, and rejects unsupported
  rates, channel counts and excessive sample counts. The Opus test encodes and
  decodes actual packets and checks stale samples, mute cleanup and backpressure.
- The CoreMedia test first failed with `ArrayTooSmall` when an overallocated
  list was supplied. Querying and using CoreMedia's exact required list size
  fixed it; allocations are still bounded by two audio channels.
- Native Mac pipe telemetry reaches the dashboard before process exit. No
  capture permissions, recording or physical Android device is used by CI.
- Android debug/release packaging, companion signature checks, JVM tests and the
  standalone no-Gradle server build pass in CI after explicit SDK setup and
  separation of app-only Material UI classes from the standalone server.

This does **not** verify audible Mac-to-phone playback, mute/resume timing on a
physical device, Safari/iOS receiving or motion-to-photon latency. Follow the
[Mac audio checklist](macos-host.md#testing-mac-desktop-audio) before treating the
audio path as hardware-validated. Windows' existing WASAPI capture implementation
and the Android audio wire protocol are unchanged.

API references: Apple's [system-audio output](https://developer.apple.com/documentation/screencapturekit/scstreamoutputtype/audio)
and [CoreMedia buffer-list sizing](https://developer.apple.com/documentation/coremedia/cmsamplebuffergetaudiobufferlistwithretainedblockbuffer(_:bufferlistsizeneededout:bufferlistout:bufferlistsize:blockbufferallocator:blockbuffermemoryallocator:flags:blockbufferout:)).

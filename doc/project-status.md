# Project status and verification

Updated **25 November 2026 (IST)**. This is a dated development snapshot;
draft branches and their CI results may advance after this update.
Prebuilt Android, Mac and Windows [preview downloads](downloads.md) are
available. Desktop apps are unsigned; Mac is not notarized. There is no qualified
stable desktop release yet. The downloads contain source `ed8d33ef`.
The newer changes below are available in source. A build, simulated regression
or short device test qualifies only the behavior it exercised.

## Merged implementation baseline

| PR | Merged source | Change |
| --- | --- | --- |
| [#60](https://github.com/subtlesayak/dskcpy/pull/60) | `113f53b5` | Installable browser receiver, offline saved-computer list, same-window pairing and trusted-HTTPS LAN pairing. Browser setup over a network works without ADB. Each new stream still requires host approval and an active route to the host. |
| [#62](https://github.com/subtlesayak/dskcpy/pull/62) | `2eda11d9` | An authorized Android USB launch survives Activity recreation and is delivered once the receiver is visible and the service is bound. The wire protocol and Android version code are unchanged. The historical display-socket stall still needs a physical reproduction. |
| [#61](https://github.com/subtlesayak/dskcpy/pull/61) | `23aed2ea` | New Mac packages write and verify numeric bundle versions while preserving the preview label in source and release metadata. |


[PR #55](https://github.com/subtlesayak/dskcpy/pull/55) merged as
[`4b4e3e32`](https://github.com/subtlesayak/dskcpy/commit/4b4e3e329ec29fd2941ad934bbec7547003c16ea),
with reviewed head `982fd3b5`. It integrates the three paired-only handoff
commits through `f588240d` above documentation baseline `e2fa022a`. It adds host
approval for every new paired stream, verified host identity and a multi-computer
browser directory. Review fixes cover pending-request reload/cancellation and
same-capture recovery after a lost first authentication reply. Documentation-only
commits may postdate this implementation baseline.

The [21 November release-preparation PR #58](https://github.com/subtlesayak/dskcpy/pull/58)
merged as `1c75248d`, with compiled source `ed8d33ef`. It supplies artifact version
`0.1.0-preview.20261121`, Android code 50003, target-runner app archives and
retained native notices. A narrow Windows packaging fix recognizes the OS LDAP
DLL only when the actual System32 file exists. Capture, audio, input and protocol
implementations are unchanged. [Preview installation](downloads.md) is separate
from qualifying a stable release.

The earlier core baseline
[`d3822b42`](https://github.com/subtlesayak/dskcpy/commit/d3822b4202429a10757710a7ac4e34e0f4e90e90)
contains all eight PRs **#45 and #47–#53**, including the original cumulative
acknowledgement fix `30d55b66`. Native and Android receiver code are unchanged by
the paired-computer review.
Merging source does not install a new app, replace an active receiver or
qualify physical hardware.

| Area | Implemented changes |
| --- | --- |
| Guided host and access | The [desktop app prototype](../desktop/README.md) guides Android USB and private-network setup. Actual native Mac input-permission status is shown separately from shell readiness. Owned-service setup/Quit is serialized, with an atomic idle-retirement veto for active sharing. Remembered access and account-free USB/LAN paths remain available. |
| Paired computers | A saved browser can request a new stream; the host must explicitly Allow or Deny each one. Persistent verified host identity supports a local multi-computer directory, rename, signed address checks and selective Forget. An address change requires pairing again. Directory reload/cancellation recovery does not renew approval or stop an established stream. See [pairing and consent](remembered-browsers.md). |
| Browser input | Matching Mac and [Windows hosts](windows-browser-keyboard.md) support opt-in desktop keyboard and committed text. [Trackpad](browser-trackpad.md), [local zoom](browser-view-zoom.md) and [shortcut buttons](browser-shortcuts.md) are implemented. [Text clipboard transfer](browser-clipboard.md) requires separate invitation permission and current-viewer opt-in; remembered access excludes it. |
| Recovery and video quality | Classified Mac display/sleep recovery, receiver audio-intent restoration, [negotiated media fallback](browser-media-recovery.md), bounded codec parameter updates and duplicate-Resume input protection are implemented. [Adaptive video](adaptive-browser-video.md), checked [Windows encoder replacement](windows-adaptive-video.md) and local video preferences remain subject to driver/device qualification. |
| Mac windows | The owner can approve [two to eight windows](browser-window-switching.md) for temporary receiver switching. Previews stay in receiver memory. Control remains off. Optional [application audio](browser-window-audio.md) is off by default, covers the selected window's entire application and requires explicit consent; it never falls back to desktop or microphone audio. |
| Separate presentation/controller | The [experimental prototype](external-display-controller.md) is off by default. Separate authenticated media/input roles, secondary click on matching native hosts, status-only recovery after End presentation and host role status are implemented. Stop requires explicit confirmation. Casting and physical background/audio behavior remain unqualified. |
| Receiver audio and access expiry | Android retains bounded partial PCM writes and unaccepted codec input, clears stale audio epochs and avoids a fixed healthy-output flush. Pending cumulative video/audio acknowledgements retain the greatest timestamp independently. Remembered approval expiry also ends active capture within its original grant. These are source/software fixes, not a physical stutter diagnosis. |
| Builds and diagnostics | Separate [Apple-silicon and Intel Mac builds](mac-host-architectures.md), pinned dependencies, payload manifests and startup diagnostics are implemented. The primary Werift notice is included and verified in both Terminal and desktop packages. Minimum-OS, installation, signing and physical media qualification remain open. |
| Artifact identity and upgrades | Android version code is **50003** for the 21 November preview, distinct from inherited wire version **4.1** and reverse protocol **1**. A read-only preflight checks APK package, version and signing-certificate compatibility. Existing Android-to-computer operation is retained. |

The integration review also fixed stale Mac audio callback admission after
mute/re-enable, legacy SPS/PPS caching for receiver reconnects, and misleading
receiver-port-conflict guidance. This review additionally preserves the original
view across a typing close/reopen before the pending layout is restored. See [Build identity and compatible upgrades](artifact-upgrades.md)
for source/artifact identity and signing-lineage limits. An Android version bump
cannot make a differently signed APK a compatible update.

## Automated verification

### 25 November merged source

[CI 45607156335](https://github.com/subtlesayak/dskcpy/actions/runs/45607156335)
passed all eight jobs on `2eda11d9`, including native tests and packaging on
both Mac architectures, Windows native and GUI, Android debug and release, and
generated browser media. [PR #62 CI](https://github.com/subtlesayak/dskcpy/actions/runs/45431625787)
recorded 117 Android tests across 19 suites, including the three pending-launch
cases.

[CI for `23aed2ea`](https://github.com/subtlesayak/dskcpy/actions/runs/45610162388)
is tracked separately. A local unsigned Apple-silicon package from that revision
has bundle versions `0.1.0` and `5.0.3`. Both UI builds, hidden Electron IPC
with a fake host and runtime verification after fresh ZIP extraction passed.
Chromium and WebKit also passed the paired-computer fixture from the merged
source, including address verification, re-pairing with fresh host approval and
same-capture recovery after a lost authentication reply. These checks used
disposable browser profiles and simulated capture. Normal app launch,
physical Android startup and Safari on iPhone/iPad remain open.


### 21 November downloadable preview

[CI 44910819236](https://github.com/subtlesayak/dskcpy/actions/runs/44910819236)
passes **all eight jobs** on `ed8d33ef`: both GUI platforms, both Android variants,
Windows native/desktop, hosted generated browser media, and both Mac native
architectures. Mac normal, ASan/UBSan and pinned builds each pass 34 tests per
architecture. Windows passes 27 native tests and five callback/runtime probes.
The Android suite passes 114 tests across 18 suites with no failures, errors or
skips. Local checks also pass 20 identity/dependency and eight packaging/ADB tests.

The first release attempt rejected `wldap32.dll` as an unknown dependency. Its
fix preserves real-file and exact-name checks and rejects missing files,
directories and lookalike names. Both Windows and Mac app ZIPs are extracted and
payload-checked on their own CI runners. Windows retains 179 native notice files
and an exact-version index for 84 runtime-package owners.

Final release assembly adds only the separately verified signed Android APK and
matching server, with manifest entries for those assets. Six synthetic archive
cases verify preservation and reject altered payloads, unsafe paths/links,
undeclared files and an incorrect APK hash. All other original app/notice bytes
are preserved. Each archive contains the exact set of 79 shipped server/receiver
sources: Mac bytes match Git directly; Windows matches after only its CI
checkout's CRLF-to-LF normalization. No other source-content change is accepted.
The final extracted Apple-silicon package also passes payload, native-help,
backend-load and ADB-version checks without starting capture or the host app.

Android50003's signature and alignment pass; every original unsigned payload
entry is preserved, and its signer matches the verified prior50002 APK. The
comparison permits an upgrade; it is not an installation/data-retention test on
a physical phone. No key is uploaded. Mac/Windows apps remain unsigned and Mac
is not notarized. Source identities, package checksums, actual validation and
license/source references accompany the [preview downloads](downloads.md).

### Paired-computer review

The reviewed integration passes **556 Node tests**, with seven optional skips
and the unchanged native log-pipe fixture enabled. Both UI builds pass. The
actual two-host HTTPS/WSS fixture passes in Chromium and WebKit, including
browser restart, wrong-binding denial, pending reload/cancel, unresponsive-tab
timeout, host denial/approval, same-session reload, signed address changes and
selective Forget. Offline directory-origin selection is tested in Chromium;
WebKit runs that directory online. Sixteen broker tests cover approval and
identity boundaries, including cancellation/expiry during awaited preparation,
single-use approval and protection of established streams from stale cancellation.

The pending-reload cancellation regression timed out before the review fix and
passes afterward. The first repair also exposed an early cancellation result;
the final fix recovers only the owning browser's pending request ID and awaits
the host acknowledgement. These are disposable profiles, fake capture and
fixture-only certificate exceptions; no live app, device or system trust changed.
A separate fault test drops the first authentication reply after host approval.
Before the final fix, reload left the receiver on the join page; both engines
now resume the same capture without a new approval. This simulated fault does
not establish the cause of the earlier physical Home/return failure.
CI also exposed a codec-fixture ordering race: two tests could send media before
the fake native header. A controlled 25 ms header delay reproduces the failures;
waiting for the parsed header fixes them without altering codec assertions,
timeouts or production media code.

[Final paired CI 44322632765](https://github.com/subtlesayak/dskcpy/actions/runs/44322632765)
completed with **all eight jobs passing** on reviewed head `982fd3b5`:

- Both Linux and Windows GUI checks/builds, Windows native/desktop checks, and
  hosted Mac Chromium/WebKit generated-media and paired-computer flows.
- Both Android package variants and **114 full-SDK tests across 18 suites**,
  with zero failures, errors or skips. Build-test signing does not establish
  compatibility with an existing phone installation's signing key.
- Fresh Apple-silicon and Intel Mac builds, each passing **34 normal, 34
  ASan/UBSan and 34 pinned-dependency native tests**, plus unsigned portable and
  desktop payload verification and hidden fake-IPC checks.

The tested synthetic merge `00167973` and actual merge `4b4e3e32` share tree
`48c9dc780e11384eaa0cce4ef2d07515c2bb9015`. Both downloaded Mac archives independently
verify **5,981 payload files**, the exact **79 shipped server/receiver sources**,
executable bits and the primary Werift notice against that tree:

| CI candidate | ZIP SHA-256 |
| --- | --- |
| Apple silicon | `a1b5a2ad4a4bc90c17ec32e808ac2061cb5d052e7d05d69253ba241831222fc2` |
| Intel | `bd1465c0bb37031ebb99a7400c4e118f2f3bc8ab2372c9d2e5a569faf091d702` |

Downloaded code was not executed or installed. Local unsigned Terminal/desktop
stages verified 5,981/5,991 files, including 98 first-party, five native and 40
required desktop source files. Their recorded source is `68955667`, whose runtime
matches the final review; only the codec test fixture and documentation changed
after it. These local stages are distinct from the fresh final CI archives.
The earlier core results below retain their own source and run identities.

### Earlier core platform qualification

The final 18 November core review passes **549 Node tests**, with seven
optional skips and the built native log-pipe fixture enabled. Both UI builds
pass. Local Apple-silicon and hosted Intel builds each pass **34 native tests**
in every normal, ASan/UBSan and pinned configuration.

Full Android SDK/Gradle validation passes **114 tests across 18 suites**, with
zero failures, errors or skips, including all nine sender and eight PCM-tail
cases. Both Android build variants, declared outputs, build-test signature and
identity checks, and standalone-server compilation pass. Build-test signing does
not establish compatibility with the key used for an existing phone installation.
Windows passes 27 native tests and five required callback/runtime probes, plus
unsigned desktop payload and hidden fake-IPC checks.

[Final integration CI 44289460747](https://github.com/subtlesayak/dskcpy/actions/runs/44289460747)
finished with **six successful jobs and two infrastructure cancellations**.
The ARM-native and Mac browser-media jobs acquired no runner and executed no
test steps; their annotations identify hosted Mac ARM capacity constraints.
The overall workflow is not green. All Mac browser-media test commands and
equivalent ARM native, sanitizer, pinned-package and fake-IPC checks passed
locally on the exact reviewed source. Local builds reused cached pinned
dependencies. The CI synthetic merge `4bc093cf` and merged `d3822b42` baseline have identical trees;
this evidence does not cover unmerged follow-ups.

Generated/fake-effect browser checks cover nine ordinary media-transport cases,
24 typing, 11 window-switching, nine WebKit video-preference, three test-muted
application-audio, four trackpad, ten presentation/controller and eight host
status/Stop flows. Six owned-loopback HTTPS cases verify real browser cookies,
restart/resume, revocation, approval expiry and active-capture expiry. Their
self-signed certificate exception is confined to disposable browser contexts;
it does not qualify system certificate trust.

Actual Android audio-player source also compiles against cached API36 Java APIs
with a declared identity-only BuildConfig fixture. Thirty-eight selected JUnit
cases pass; two cumulative-acknowledgement ordering assertions failed before
the original fix. This direct-Java check is separate from full SDK/Gradle CI.

The downloaded Intel CI archive independently verifies all 5,976 payload files,
including the exact set of 74 shipped server/receiver source files, executable
bits and primary Werift notice. Local unsigned Terminal and desktop stages
verify 5,976 and 5,986 files respectively; the desktop payload checks 93
first-party, five native and 35 required source files. Downloaded code was not
executed, and neither candidate was installed or activated by this review.

The previous #38–#44 review passed all eight jobs in
[run 44041666101](https://github.com/subtlesayak/dskcpy/actions/runs/44041666101).
That earlier result does not turn a later capacity cancellation into a pass.

These tests use generated media, fake native effects or software decoding where
specified. They do not establish physical input, audible playback, real encoder
driver behavior or touch-to-display latency. A failed or capacity-cancelled job
is not a pass, and a pass on one architecture does not qualify another.

CI candidates are short-lived intermediate artifacts, with no developer signing,
notarization or release publication. Their manifests retain source identity and
explicit qualification limits. A CI artifact is not automatically the same
artifact as a locally repaired, physically tested app. Older CI and artifact
counts remain in the [11 November snapshot](https://github.com/subtlesayak/dskcpy/blob/8052ce8ca9a7eab48eb3f3f027369cc3af843561/doc/project-status.md).

## Follow-ups included in this implementation

PR #6 merged on 12 November. The following source work is now integrated;
its original submitted heads are retained here to distinguish earlier candidate
evidence from the combined review. An approved local installation alone does
not qualify a release:

| PR | Implementation scope | Original submitted source |
| --- | --- | --- |
| [#38](https://github.com/subtlesayak/dskcpy/pull/38) | Effective native Mac input-permission status, instead of relying only on the desktop shell's readiness. | `6e5aedc1` |
| [#39](https://github.com/subtlesayak/dskcpy/pull/39) | Reversible last-tap typing framing and landscape space for a user-positioned floating keyboard. The browser cannot position the system keyboard. | `bada804d` |
| [#40](https://github.com/subtlesayak/dskcpy/pull/40) | Explicit, off-by-default selected-application audio with Mac window sharing; window input stays denied. | `d92cca17` |
| [#41](https://github.com/subtlesayak/dskcpy/pull/41) | Owned-service setup/Quit serialization and atomic idle-retirement veto. | `cf2483b9` |
| [#43](https://github.com/subtlesayak/dskcpy/pull/43) | Primary runtime notice included in Terminal packages and safely reused by desktop staging. | `4300e39f` |
| [#44](https://github.com/subtlesayak/dskcpy/pull/44) | Optional bounded Mac caret/field geometry for typing framing, separately subscribed and gated. No text contents or reported secure fields are exposed. | `037dde29` |
| [#45](https://github.com/subtlesayak/dskcpy/pull/45) | Fractional touch scrolling and adjustable speed; deterministic native-header fixture ordering. | `f42dca3c` |
| [#47](https://github.com/subtlesayak/dskcpy/pull/47) | Browser Stop confirmation. The equivalent #48 change is preserved once. | `c6295ff9` |
| [#48](https://github.com/subtlesayak/dskcpy/pull/48) | Default-off separate presentation/controller roles and negotiated secondary click. | `e6c44435` |
| [#49](https://github.com/subtlesayak/dskcpy/pull/49) | Status-only controller recovery after End presentation. | `6ed7d2cd` |
| [#50](https://github.com/subtlesayak/dskcpy/pull/50) | Narrow host role status and explicit host Stop confirmation. | `93a08ca0` |
| [#51](https://github.com/subtlesayak/dskcpy/pull/51) | Real-browser HTTPS remembered-access matrix. | `3d5cf005` |
| [#52](https://github.com/subtlesayak/dskcpy/pull/52) | Original approval deadline also bounds active capture. | `7eda814f` |
| [#53](https://github.com/subtlesayak/dskcpy/pull/53) | Reconciled prepared Android partial-write/epoch audio patch; combined review adds cumulative ACK ordering fix. | `83dbfad4` |
| [#55](https://github.com/subtlesayak/dskcpy/pull/55) | Per-stream host approval, verified host identity and paired-computer navigation; review fixes pending cancellation and interrupted first-authentication recovery. | Paired handoff `f588240d`; reviewed integration `982fd3b5` |
| [#58](https://github.com/subtlesayak/dskcpy/pull/58) | Versioned preview archives, matching Android identity and native dependency notices; narrow System32 WinLDAP packaging fix. | `ed8d33ef` |

Local checks, hosted-runner capacity cancellations and separate integrations are
different evidence. The combined typing layout, actual AX providers and
application-audio behavior still require physical qualification. The browser
does not control the system keyboard's position or replace its IME.

## Unmerged follow-ups

The following PRs are under review as of this snapshot.

| PR | Change and local evidence |
| --- | --- |
| [#63](https://github.com/subtlesayak/dskcpy/pull/63) | Releases held mouse input when the phone controller rotates. Chromium and WebKit passed generated presentation flows. Physical rotation and casting remain open. |
| [#64](https://github.com/subtlesayak/dskcpy/pull/64) | Refreshes busy-host availability before enabling retry and keeps the approval countdown accurate across clock differences. Chromium and WebKit passed disposable paired-computer flows. |
| [#65](https://github.com/subtlesayak/dskcpy/pull/65) | Runs check-only launcher diagnostics without probing the dashboard port. All 17 focused tests passed. |
| [#66](https://github.com/subtlesayak/dskcpy/pull/66) | Verifies the capture-recovery deadline with a controlled timer and real loopback sockets. This updates the test fixture. |
| [#67](https://github.com/subtlesayak/dskcpy/pull/67) | Refreshes Mac screen and control permission status on focus and normal status updates. Browser fixtures exercised simulated grants. Actual macOS grants and relaunch still need a hardware check. |

The following development checkpoints remain separate from the merged source and
the preview downloads.

| Development area | Recorded implementation and automated evidence |
| --- | --- |
| Background recovery and Gaming | `30fb845b` combines same-capture recovery, relative mouse/keyboard input and a latency workload. Generated browser tests release held input and require a fresh user gesture for Pointer Lock after recovery. Physical game input and input-to-photon measurements remain open. |
| Private access and video preferences | `d05a2c8d` combines private password access with recovery/Gaming; `08dce4e5` adds named credentials and `e5946870` adds bounded per-pair video preferences. Chromium/WebKit HTTPS sign-in, resume and revocation checks pass. This is local development; the published paired flow still requires host approval for each new stream. |
| Presentation and packaged host | `6bb4ecba` adds presentation audio/controller recovery tests: 20 generated scenarios pass across Chromium/WebKit and WebRTC/WebCodecs. `a6e0a67d` adds a default-off, per-invitation phone-controller choice in the desktop host; 587 Node tests pass with eight skips, seven service cases and four renderer layouts. Both GUI builds, unsigned Apple-silicon payload and hidden fake-IPC checks pass. Generated silent-output audio does not qualify audible playback or casting. |

A private test bundle for host `a6e0a67d` and the matching development-signed
Android version 50002 was extracted and verified against its checksums, payload
manifest and APK signature. It was not published to GitHub Releases. A disposable
Android 16 ARM64 emulator accepted the APK as an in-place update over version
50001, retained the app UID and a seeded audio preference after launch, and
completed three cold ADB display-socket handshakes. This is **emulator evidence**,
not a physical phone pass or a reproduced startup-stall diagnosis.

Development installer images also remain separate. These checkpoints do not
qualify a signed/notarized Mac release, physical presentation/casting, audible
route recovery, sustained sessions or the broader hardware matrix. Their review,
integration and physical gates stay on the [roadmap](roadmap.md).

Further 21 November local records identify candidate `43a9a35b`, combining
separate Gaming fixtures with route-readiness changes `588bd33d`, `33c4572a`
and `673c0920`. PR #60 brought network-only browser setup to the default branch
while retaining ADB checks for USB. The combined candidate's 591 Node passes
with eight skips, both UI builds, extracted-payload and utility-IPC checks apply
to that local build. Separate generated-pixel VideoToolbox
tests exercised encoder-property acceptance and bounded worker pacing; they do
not qualify screen capture, network delivery or physical input-to-display latency.

The same local record reports a disposable, unmodified Electron 45.3.1 timing
out before app JavaScript, in macOS application initialization waiting for a
synchronous clipboard-service reply. A hidden Launch Services probe also timed
out. This is a local environment/startup limitation, separate from the passing
hosted release CI and payload checks. A normal-desktop host-window launch still
needs qualification; no system-service restart or live-session disruption is
implied by this diagnosis.

## Candidate-specific physical evidence

### Locally repaired source92 Mac app

The human reported visible video, working touch, committed phone text in an
owned test window, and automatic keyboard opening with the receiver option
enabled on a local app from source `92c49def`. This followed a combined local
package/signature repair and app-specific permission reset/regrant. The steps
were not isolated causal tests; the earlier native Accessibility denial despite
shell-ready status remains relevant to permission telemetry and install identity.

This is one historical local candidate's evidence. It does not qualify a later
combined source, a CI download, audible application audio, signing/upgrade durability or
the new landscape layout. No signed desktop release follows from this result.

The separately approved installed `bada804d` candidate subsequently received
human confirmation of a stable picture for 20 seconds and working touch/text
over a private VPN across different networks/mobile data. Two-finger scrolling
moved immediately but too little distance; sensitivity is under separate
investigation. This is not a measured latency result. New-layout readability,
focused AX geometry and audible application audio are not qualified by that report.

### Separately approved paired-browser installation

The installed `7a7a5914` derivative received a human report of an approved paired
join with Android Edge over Wi-Fi through a private Tailscale connection. A
repeat Home/return resumed the same paired stream. An earlier Home/return
showed the connection-code page; its exact cause remains unconfirmed. This is
candidate-specific picture/session evidence, not an audio or measured latency
result. The review's pending-request reload/cancellation and lost-authentication
recovery fixes were not installed or physically tested by this review.

### Earlier USB browser audio and input candidate

The following results were reported by the human and receiver task for **one
Mac/Android browser candidate over USB/WebCodecs**. They apply to this identified
combination, including receiver code that was unmerged at that test checkpoint:

```text
Native source: 4ec8e7fcaec7b4d558220afecdd54b494d6795aa
Native SHA-256: f837ddf4a81139b360b47ab22fedc18af8de96102f741fb380d7c47f8a2d0bcc
Loaded receiver: 1d303ab5
```

| Check | Recorded result |
| --- | --- |
| Continuous system audio | Human confirmed continuous sound for one five-minute, 48 kHz stereo tone workload. |
| Receiver mute/resume | Passed. |
| Android Home for 10 seconds, then return | Video, touch and continuous audio recovered. |
| Pointer input | Taps, scrolling and a 16.8-second held drag with proper release were observed in an owned test window. |
| Text and key release | Accented Latin and emoji were received; no pressed physical keys/modifiers remained after closing the phone keyboard. CJK was unavailable and unverified. |

The source/input records are retained in the receiver branch's
[audio qualification](https://github.com/subtlesayak/dskcpy/blob/c37f86316e813f90025db535a7bb535ba7155ec9/doc/testing/mac/receiver-audio-scheduling.json)
and [input fixture receipt](https://github.com/subtlesayak/dskcpy/blob/c37f86316e813f90025db535a7bb535ba7155ec9/doc/testing/mac/input-check.json).
Private screenshots and raw event samples stay local.

The audio pass is human listening evidence. Packet/ACK counters alone do not
prove continuous playback. The capture-queue counter increased from 32 to 34
in the recorded soak snapshots, so this is not a zero-drop or lossless claim.
No physical touch-to-display latency trial series, median or p95 was measured;
decode-acknowledgement RTT remains a different measurement.

## Remaining qualification gates

- Effective native permission reporting, correct app-copy identity, regrant and
  recovery behavior on the final packaged candidate.
- Combined typing-layout usability and selected-application audio isolation,
  audible switching/output-route recovery, plus exact target-relative window
  input. Window control remains off and application audio requires explicit opt-in.
- Longer USB sessions and 30–60 minute audible workloads; repeat stop/reconnect
  and input-release checks on the final combined source.
- Local Wi-Fi/direct IP and private VPN separately, including audio, network
  loss and recovery. Private-route preflight is not a transport/device pass.
- Output-device changes, mute/background transitions and permission changes
  on the identified final candidate.
- Display resolution/disconnect/reconnect and suspend/resume recovery on real
  devices, plus Windows hardware encoder rate/resource behavior.
- Safari/iPhone/iPad, broader IME/shortcut behavior and additional devices.
- A same-key Android upgrade that preserves data, plus the matching private
  Android source/APK handoff needed for the historical display-socket startup stall.
- Clean-machine testing on every declared supported Mac OS before describing
  the hosting candidate as a portable release; actual install/upgrade/startup,
  signing and notarization need their own qualification.

Earlier source/physical records remain in [Mac testing history](testing/mac/README.md).
The [roadmap](roadmap.md) remains the full implementation and qualification plan.
A successful retry, five-minute USB result, local repair or build does not
complete the overall hardware-verification goal. The historical Android
display-socket startup stall still has no reproduced cause or verified fix.

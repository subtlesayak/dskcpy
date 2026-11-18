# Project status and verification

Updated **18 November 2026 (IST)**. This is a dated development snapshot;
draft branches and their CI results may advance after this update.
dskcpy requires a source build; no signed, ready-to-install desktop release is
available. A build, simulated regression or short device test qualifies only
the behavior it actually exercised.

## Merged implementation baseline

The merged implementation baseline is
[`d3822b42`](https://github.com/subtlesayak/dskcpy/commit/d3822b4202429a10757710a7ac4e34e0f4e90e90),
which includes all eight PRs **#45 and #47–#53** above `ab2c2f93` and the earlier
#16–#44 baseline. It has the same tree as the reviewed `cd9ae1e1` candidate,
including the original cumulative-acknowledgement fix `30d55b66`.
Documentation-only updates may postdate this commit.
Merging source does not install a new app, replace an active receiver or
qualify physical hardware.

| Area | Implemented changes |
| --- | --- |
| Guided host and access | The [desktop app prototype](../desktop/README.md) guides Android USB and private-network setup. Actual native Mac input-permission status is shown separately from shell readiness. Owned-service setup/Quit is serialized, with an atomic idle-retirement veto for active sharing. Remembered access and account-free USB/LAN paths remain available. |
| Browser input | Matching Mac and [Windows hosts](windows-browser-keyboard.md) support opt-in desktop keyboard and committed text. [Trackpad](browser-trackpad.md), [local zoom](browser-view-zoom.md) and [shortcut buttons](browser-shortcuts.md) are implemented. [Text clipboard transfer](browser-clipboard.md) requires separate invitation permission and current-viewer opt-in; remembered access excludes it. |
| Recovery and video quality | Classified Mac display/sleep recovery, receiver audio-intent restoration, [negotiated media fallback](browser-media-recovery.md), bounded codec parameter updates and duplicate-Resume input protection are implemented. [Adaptive video](adaptive-browser-video.md), checked [Windows encoder replacement](windows-adaptive-video.md) and local video preferences remain subject to driver/device qualification. |
| Mac windows | The owner can approve [two to eight windows](browser-window-switching.md) for temporary receiver switching. Previews stay in receiver memory. Control remains off. Optional [application audio](browser-window-audio.md) is off by default, covers the selected window's entire application and requires explicit consent; it never falls back to desktop or microphone audio. |
| Separate presentation/controller | The [experimental prototype](external-display-controller.md) is off by default. Separate authenticated media/input roles, secondary click on matching native hosts, status-only recovery after End presentation and host role status are implemented. Stop requires explicit confirmation. Casting and physical background/audio behavior remain unqualified. |
| Receiver audio and access expiry | Android retains bounded partial PCM writes and unaccepted codec input, clears stale audio epochs and avoids a fixed healthy-output flush. Pending cumulative video/audio acknowledgements retain the greatest timestamp independently. Remembered approval expiry also ends active capture within its original grant. These are source/software fixes, not a physical stutter diagnosis. |
| Builds and diagnostics | Separate [Apple-silicon and Intel Mac builds](mac-host-architectures.md), pinned dependencies, payload manifests and startup diagnostics are implemented. The primary Werift notice is included and verified in both Terminal and desktop packages. Minimum-OS, installation, signing and physical media qualification remain open. |
| Artifact identity and upgrades | Android version code is **50002**, distinct from inherited wire version **4.1** and reverse protocol **1**. A read-only preflight checks APK package, version and signing-certificate compatibility. Existing Android-to-computer operation is retained. |

The integration review also fixed stale Mac audio callback admission after
mute/re-enable, legacy SPS/PPS caching for receiver reconnects, and misleading
receiver-port-conflict guidance. This review additionally preserves the original
view across a typing close/reopen before the pending layout is restored. See [Build identity and compatible upgrades](artifact-upgrades.md)
for source/artifact identity and signing-lineage limits. An Android version bump
cannot make a differently signed APK a compatible update.

## Automated verification

The final 18 November combined review passes **549 Node tests**, with seven
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

Local checks, hosted-runner capacity cancellations and separate integrations are
different evidence. The combined typing layout, actual AX providers and
application-audio behavior still require physical qualification. The browser
does not control the system keyboard's position or replace its IME.

## Unmerged follow-ups

Development installer images, paired-computer navigation/identity, host approval
for each new stream and Gaming mode are separate ongoing work. They are not
capabilities or qualified releases of the merged baseline above. Their remaining
implementation and physical checks stay on the [roadmap](roadmap.md).

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

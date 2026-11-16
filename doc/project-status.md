# Project status and verification

Updated **16 November 2026 (IST)**. This is a dated development snapshot;
draft branches and their CI results may advance after this update.
dskcpy requires a source build; no signed, ready-to-install desktop release is
available. A build, simulated regression or short device test qualifies only
the behavior it actually exercised.

## Merged implementation baseline

The implementation baseline is
`8052ce8ca9a7eab48eb3f3f027369cc3af843561`, including merged PRs #16–#37.
Documentation-only updates may postdate this commit. Merging source does not
install a new app, replace an active receiver or qualify physical hardware.

| Area | Implemented changes |
| --- | --- |
| Guided host and access | The [desktop app prototype](../desktop/README.md) guides Android USB and private-network setup. Remembered browser access, explicit invitations, an owned-receiver link check and bounded startup history are implemented. Account-free USB/LAN paths remain available. |
| Browser input | Matching Mac and [Windows hosts](windows-browser-keyboard.md) support opt-in desktop keyboard and committed text. [Trackpad](browser-trackpad.md), [local zoom](browser-view-zoom.md) and [shortcut buttons](browser-shortcuts.md) are implemented. [Text clipboard transfer](browser-clipboard.md) requires separate invitation permission and current-viewer opt-in; remembered access excludes it. |
| Recovery and video quality | Classified Mac display/sleep recovery, receiver audio-intent restoration, [negotiated media fallback](browser-media-recovery.md), bounded codec parameter updates and duplicate-Resume input protection are implemented. [Adaptive video](adaptive-browser-video.md), checked [Windows encoder replacement](windows-adaptive-video.md) and local video preferences remain subject to driver/device qualification. |
| Mac windows | The owner can approve [two to eight windows](browser-window-switching.md) for temporary receiver switching. Last-viewed previews stay in receiver memory. Window sharing remains view-only with audio off in this baseline. |
| Builds and diagnostics | Separate [Apple-silicon and Intel Mac builds](mac-host-architectures.md), pinned dependencies, runtime notices, payload manifests and startup diagnostics are implemented. Minimum-OS, installation, signing and physical media qualification remain open. |
| Artifact identity and upgrades | Android version code is **50002**, distinct from inherited wire version **4.1** and reverse protocol **1**. A read-only preflight checks APK package, version and signing-certificate compatibility. Existing Android-to-computer operation is retained. |

The integration review also fixed stale Mac audio callback admission after
mute/re-enable, legacy SPS/PPS caching for receiver reconnects, and misleading
receiver-port-conflict guidance. See [Build identity and compatible upgrades](artifact-upgrades.md)
for source/artifact identity and signing-lineage limits. An Android version bump
cannot make a differently signed APK a compatible update.

## Automated verification

All **eight** jobs passed for implementation baseline `8052ce8c` in
[master verification run 43571452662](https://github.com/subtlesayak/dskcpy/actions/runs/43571452662):

- Dashboard/backend checks and production builds on Linux and Windows.
- Windows: 26 native tests and four required production probes, with zero skips.
- Android debug/release packaging, actual APK identity/signature inspection,
  unit tests and the standalone server build.
- Apple silicon and Intel separately: 30 native tests in each normal,
  ASan/UBSan and pinned build; unsigned package verification and fake-host IPC.
- Generated H.264/Opus media in Chromium and WebKit: nine media scenarios,
  six Chromium window-switching flows and five WebKit window-switching flows.

These tests use generated media, fake native effects or software decoding where
specified. They do not establish physical input, audible playback, real encoder
driver behavior or touch-to-display latency. A failed or capacity-cancelled job
is not a pass, and a pass on one architecture does not qualify another.

CI candidates are short-lived intermediate artifacts, with no developer signing,
notarization or release publication. Their manifests retain source identity and
explicit qualification limits. A CI artifact is not automatically the same
artifact as a locally repaired, physically tested app. Older CI and artifact
counts remain in the [11 November snapshot](https://github.com/subtlesayak/dskcpy/blob/8052ce8ca9a7eab48eb3f3f027369cc3af843561/doc/project-status.md).

## Draft follow-ups outside the baseline

PR #6 merged on 12 November; it is no longer pending. The following work is
still in separate drafts at this snapshot and is outside the merged baseline.
A separately approved local candidate installation does not merge its branch
or qualify a release:

| Draft | Candidate scope | Recorded source |
| --- | --- | --- |
| [#38](https://github.com/subtlesayak/dskcpy/pull/38) | Effective native Mac input-permission status, instead of relying only on the desktop shell's readiness. | `6e5aedc1` |
| [#39](https://github.com/subtlesayak/dskcpy/pull/39) | Reversible last-tap typing framing and landscape space for a user-positioned floating keyboard. The browser cannot position the system keyboard. | `bada804d` |
| [#40](https://github.com/subtlesayak/dskcpy/pull/40) | Explicit, off-by-default selected-application audio with Mac window sharing; window input stays denied. | `d92cca17` |
| [#41](https://github.com/subtlesayak/dskcpy/pull/41) | Owned-service setup/Quit serialization and atomic idle-retirement veto. | `cf2483b9` |

Check each draft's latest source and terminal CI before review. Local checks,
hosted-runner capacity cancellations and separate integration experiments are
different evidence. The draft typing layout and application-audio behavior
still require physical qualification.

## Candidate-specific physical evidence

### Locally repaired source92 Mac app

The human reported visible video, working touch, committed phone text in an
owned test window, and automatic keyboard opening with the receiver option
enabled on a local app from source `92c49def`. This followed a combined local
package/signature repair and app-specific permission reset/regrant. The steps
were not isolated causal tests; the earlier native Accessibility denial despite
shell-ready status remains relevant to permission telemetry and install identity.

This is one historical local candidate's evidence. It does not qualify `8052ce8c`, a CI
download, drafts #38–#41, audible application audio, signing/upgrade durability or
the new landscape layout. No signed desktop release follows from this result.

The `bada804d` typing candidate subsequently entered a separately approved local
activation test. Installation and permission-grant steps alone are not a pass;
physical results for its new layout remain pending at this snapshot.

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
- Draft typing-layout usability and selected-application audio isolation,
  audible switching/output-route recovery, plus exact target-relative window
  input. Current merged window mode remains view-only with audio off.
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

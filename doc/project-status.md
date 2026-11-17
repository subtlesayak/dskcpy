# Project status and verification

Updated **17 November 2026 (IST)**. This is a dated development snapshot;
draft branches and their CI results may advance after this update.
dskcpy requires a source build; no signed, ready-to-install desktop release is
available. A build, simulated regression or short device test qualifies only
the behavior it actually exercised.

## Merged implementation baseline

The implementation baseline is
`faef20ef7488c5933257b56b0ec24f4edb0d0566`, the combined implementation review
checkpoint for PRs #38–#41, #43 and #44 above the earlier #16–#37 baseline.
Documentation-only updates may postdate this commit. Merging source does not
install a new app, replace an active receiver or qualify physical hardware.

| Area | Implemented changes |
| --- | --- |
| Guided host and access | The [desktop app prototype](../desktop/README.md) guides Android USB and private-network setup. Actual native Mac input-permission status is shown separately from shell readiness. Owned-service setup/Quit is serialized, with an atomic idle-retirement veto for active sharing. Remembered access and account-free USB/LAN paths remain available. |
| Browser input | Matching Mac and [Windows hosts](windows-browser-keyboard.md) support opt-in desktop keyboard and committed text. [Trackpad](browser-trackpad.md), [local zoom](browser-view-zoom.md) and [shortcut buttons](browser-shortcuts.md) are implemented. [Text clipboard transfer](browser-clipboard.md) requires separate invitation permission and current-viewer opt-in; remembered access excludes it. |
| Recovery and video quality | Classified Mac display/sleep recovery, receiver audio-intent restoration, [negotiated media fallback](browser-media-recovery.md), bounded codec parameter updates and duplicate-Resume input protection are implemented. [Adaptive video](adaptive-browser-video.md), checked [Windows encoder replacement](windows-adaptive-video.md) and local video preferences remain subject to driver/device qualification. |
| Mac windows | The owner can approve [two to eight windows](browser-window-switching.md) for temporary receiver switching. Previews stay in receiver memory. Control remains off. Optional [application audio](browser-window-audio.md) is off by default, covers the selected window's entire application and requires explicit consent; it never falls back to desktop or microphone audio. |
| Builds and diagnostics | Separate [Apple-silicon and Intel Mac builds](mac-host-architectures.md), pinned dependencies, payload manifests and startup diagnostics are implemented. The primary Werift notice is included and verified in both Terminal and desktop packages. Minimum-OS, installation, signing and physical media qualification remain open. |
| Artifact identity and upgrades | Android version code is **50002**, distinct from inherited wire version **4.1** and reverse protocol **1**. A read-only preflight checks APK package, version and signing-certificate compatibility. Existing Android-to-computer operation is retained. |

The integration review also fixed stale Mac audio callback admission after
mute/re-enable, legacy SPS/PPS caching for receiver reconnects, and misleading
receiver-port-conflict guidance. This review additionally preserves the original
view across a typing close/reopen before the pending layout is restored. See [Build identity and compatible upgrades](artifact-upgrades.md)
for source/artifact identity and signing-lineage limits. An Android version bump
cannot make a differently signed APK a compatible update.

## Automated verification

The combined implementation review passes 32 local Mac native tests in each
normal, ASan/UBSan and pinned build; 504 Node tests pass with seven optional skips.
Both UI builds pass. Generated-media checks cover 24 Chromium/WebKit typing
flows and three application-audio flows; five owner-consent and six native
permission-guidance UI cases use fake effects.

The combined cross-platform workflow and exact source results are on
[PR #44's checks](https://github.com/subtlesayak/dskcpy/pull/44/checks). Always match
the tested head and terminal result. The earlier `8052ce8c` baseline passed all
eight jobs in [master run 43571452662](https://github.com/subtlesayak/dskcpy/actions/runs/43571452662);
that historical pass does not qualify a later integration or installed app.

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

Local checks, hosted-runner capacity cancellations and separate integrations are
different evidence. The combined typing layout, actual AX providers and
application-audio behavior still require physical qualification. The browser
does not control the system keyboard's position or replace its IME.

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

# Project status and verification

Updated **11 November 2026 (IST)**. This is a dated development snapshot.
dskcpy requires a source build; no signed, ready-to-install desktop release is
available. A build, simulated regression or short device test qualifies only
the behavior it actually exercised.

## Merged source

The recorded master baseline is
`2249d848cd33ca39cb6aeb043a1c6c6fc64110d5`.

| Area | Implemented changes |
| --- | --- |
| Mac audio and control lifecycle | [PR #7](https://github.com/subtlesayak/dskcpy/pull/7) feeds fresh PCM through the existing bounded window and prevents active Resume/IDR requests from restarting Opus or releasing held input. Real pause/resume, mute and route cleanup remain in place. |
| Artifact identity and upgrades | Android version code is **50002**. Fork artifact identity is separate from inherited wire version **4.1** and reverse protocol **1**. An explicit read-only preflight verifies APK package, version and signing-certificate compatibility. |
| Mac hosting package | A separate Apple-silicon hosting build targets macOS **13.0**, with pinned static dependencies, Opus encoding, GUI/browser assets, licenses and a hashed manifest. System-link and deployment-target checks pass; clean-machine macOS 13 compatibility remains unverified. |
| Windows runtime and regression checks | [PR #8](https://github.com/subtlesayak/dskcpy/pull/8) discovers UCRT64/legacy runtime libraries while preserving explicit overrides. It also adds bounded message-parser vectors; ordinary Mac PR verification now includes ASan/UBSan. |

See [Build identity and compatible upgrades](artifact-upgrades.md) for commands,
signing-lineage limits and the separate unsigned hosting candidate. The existing
Android-to-computer client packaging remains available. An Android source-version
bump cannot make a differently signed APK a compatible update.

## Automated verification

All six jobs passed for the merged baseline in
[master verification run 43022713935](https://github.com/subtlesayak/dskcpy/actions/runs/43022713935):

- Dashboard/backend checks and production builds on Linux and Windows.
- Native Windows tests and loading the actual UCRT64 executable.
- Android debug/release packaging, actual APK identity/signature inspection,
  unit tests and the standalone server build.
- Mac native tests, ASan/UBSan, a full isolated static-source hosting build,
  packaged check-only readiness and CI artifact creation.

The Mac suites contain 20 native test executables. Focused regressions include
10,000 duplicate active Resume requests, 8,192 bounded native message vectors,
and downloader connection-reset/checksum-refusal cases. These are automated or
simulated checks; they do not establish audible quality or physical latency.

The [PR #7 verification artifact](https://github.com/subtlesayak/dskcpy/actions/runs/43020338689)
had all **5,937** payload sizes and SHA-256 hashes independently checked.
CI candidates are short-lived intermediate artifacts, with no developer signing,
notarization or release publication. Their manifests retain source identity and
explicit qualification limits. The physically tested binary below was built
separately; a CI artifact is not automatically the same device-tested artifact.

## Pending receiver work

[PR #6](https://github.com/subtlesayak/dskcpy/pull/6) remains separate from this
master snapshot. It contains browser decoder-drain recovery, compact side
controls/fullscreen keyboard fitting, authorized USB auto-open, bounded audio
scheduling and fresh-document invitation navigation.

Its source review and device tests continue in the receiver task. At checkpoint
`c37f8631`, review reproduced a launcher preflight false-positive for a directory
supplied as the native executable; correction and latest-head validation are
tracked in PR #6. A newer private-route candidate is under separate physical
testing. These pending changes must not be described as released or already
included in the master browser receiver.

## Physical USB browser evidence

The following results were reported by the human and receiver task for **one
Mac/Android browser candidate over USB/WebCodecs**. They apply to this identified
combination, including pending receiver code:

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

- Longer USB sessions and 30–60 minute audible workloads; repeat stop/reconnect
  and input-release checks on the final combined source.
- Local Wi-Fi/direct IP and private VPN separately, including audio, network
  loss and recovery. Private-route preflight is not a transport/device pass.
- Output-device changes, mute/background transitions and permission changes
  on the identified final candidate.
- Safari/iPhone/iPad, broader IME/shortcut behavior and additional devices.
- A same-key Android upgrade that preserves data, plus the matching private
  Android source/APK handoff needed for the historical display-socket startup stall.
- Clean-machine testing on every declared supported Mac OS before describing
  the hosting candidate as a portable release.

Earlier source/physical records remain in [Mac testing history](testing/mac/README.md).
The [roadmap](roadmap.md) retains later browser-engine CI, diagnostics, control,
trust and adaptation work. A successful retry, five-minute USB result or build
does not complete the overall hardware-verification goal.

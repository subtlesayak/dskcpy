# Mac host hardware testing

For the November browser candidate and merged upgrades, see
[Current project status and verification](../../project-status.md). This page
retains the earlier Android-app receiver and privately transferred snapshot history.

The physical results below were observed on 20–21 October 2026 using privately
transferred source snapshots. They do not qualify every browser/device. The Mac
source fixes were subsequently applied to this repository and built/tested on
11 November 2026; no physical test was rerun by preparing this commit.

The most recent USB tests used the original controller and companion APK
SHA-256 `d1cb90e300faa4847b4b46a9e315c96c4694063aaf2b3b54d8d59ec836a4c12a`,
version 50001, with native build
`6645f72dcabee3483f1db035ed43bd4aa019660a739154aef546ab89193e811f`.
The earlier Wi-Fi/recovery tests used native build
`7981322af07b51a2899b10f783ed3c347384d9df687313fccd318dd910e35697`.
The native candidates are preserved locally. The three included source patches
were applied to this repository in order: audio buffering, display recovery, then
input-session guard. Unrelated received refactoring was not copied over. Rebuild
rather than copying the old binaries; their hashes describe different source baselines.

| Physical check | Observed result | Limits |
| --- | --- | --- |
| Wi-Fi video and input | Readable; tap, drag and two-finger scroll passed | Android receiver; does not prove browser or remote-network access |
| USB normal input | Phone taps produced Calculator 123; independently read on Mac | Original companion, input-guard native |
| Control permission OFF | User could not touch; Calculator remained 123; video decode ACKs continued | Terminal control permission, not screen recording |
| Control permission restored ON | Input recovered with the same stream; one phone tap 6 changed 12325 to 123256, user and native UI confirmed | Prior report 1235 differed from observed 12325; discrepancy preserved, not attributed |
| Resolution change | 1920×1080 → 1600×900 → 1920×1080; readability/input alignment confirmed | Earlier recovery native |
| Sleep/wake | Video and touch recovered automatically on repeat | Audio needs final-candidate repeat |
| Display cable | Phone recovered video/touch automatically | Physical monitor required cable/input/power recovery |
| OS Stop Sharing | Video stayed stopped; native exit 0, no automatic reconnect | Specific delegate marker absent; callback path unproven |
| Audio, mute, Home/return | Short checks passed; sustained USB/Wi-Fi stutter returned | Audio is unresolved; receiver source candidate needs matching signed APK and audible regression |
| Screen-recording permission | Switch OFF observed; OS says existing Terminal keeps capture until quit | User restart/denial/regrant test pending; control permission restored ON |

A targeted existing ADB TCP connection drop recovered automatically in 7.66 s.
This is a transport-fault test, not a physical Wi-Fi outage. Decode ACK measures
encode-submission-to-decode round trip, never physical touch-to-display latency.

Automated evidence on received snapshots: 23 native tests passed; 213 backend
tests passed with 28 optional skips; TypeScript/Vite build passed. The Android
audio source candidate passed 33 selected JUnit/API checks, not a full APK build.
Those counts are historical snapshot results, not test results for this commit.

## Remaining qualification

- Physically requalify the rebuilt repository native host.
- Screen-recording denial/regrant, held-input and post-stop queued-action checks.
- Wired audio-output change and sustained audible USB/Wi-Fi tests using a
  certificate-verified compatible Android audio candidate.
- Browser video, audio, touch, mouse and lifecycle tests across actual Safari,
  Chrome/Edge and Firefox receivers; private-network access tested separately.
- Physical Wi-Fi outage; VPN and Apple receiver hardware qualification.
- Intermittent Android pre-display-socket startup stall: reproduced twice; retry
  success does not close it. Coordinate Android lifecycle changes with Windows.

Detailed sanitized observations are in the JSON files beside this document.
No device/network identifiers, keys, personal paths or raw logs are included.

## Repository build — 11 November 2026

Base commit: `b74226c2`. Mac patches applied to seven source/test paths without
changing the native wire protocol or Android lifecycle code. Native build passed;
all 16 native tests passed, including Mac audio FIFO and encoder-capacity tests.
Backend suite: 106 passed, 6 optional skips, 0 failures. TypeScript/Vite production
build passed. See `repository-build.json` for source/build hashes.

The current Homebrew libraries emit deployment-target linker warnings: they were
built for macOS 27 while this project targets macOS 13. This locally linked build
is not a portable macOS 13 binary. No binary or dependencies are committed.

The added queue preserves fresh captured audio within the existing bounded
window; it does not establish a fix for audible Android stutter. Display geometry
changes request reconnection; explicit user Stop Sharing ends capture, and
terminal session states reject queued input/window/volume work. Browser WebRTC
interoperability and remote-network testing are separate ongoing work.

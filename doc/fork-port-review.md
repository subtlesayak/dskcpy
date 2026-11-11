# Fork and companion-project port review

## Updated review — 2026-11-11

Implementation follow-up: dskcpy now has an original bounded WebCodecs recovery
controller in `gui/receiver/video.mjs`, exact-configuration capability checks,
one supported software fallback and generation-safe lifecycle integration.
The WebRTC adapter uses the installed sender's semantic PLI/FIR event instead
of interpreting all PSFB packets as keyframe requests. Recovery discards pixels,
drains ACKs and waits for a new IDR. No reviewed implementation was copied and
no package was added for this follow-up. Because the references were previously
inspected, this is not a formally source-isolated clean-room certification.
Larger window-capture, keyboard and audio-format milestones remain as described
below; the original review records the pre-implementation gaps.

Read-only source review; no third-party implementation was copied, no candidate
was built or hardware-tested, and no stream or network configuration was changed.
This is a targeted shortlist, not an exhaustive review of the scrcpy fork network.
GitHub searches were followed by default-branch comparisons of six selected direct
forks and source inspection of relevant browser projects. Repository activity and
README compatibility claims are not independent hardware evidence.

### Local baseline and existing work

The Git checkout's committed baseline is `ac221b1a`, based on
public master `b74226c2`. It has additional uncommitted Mac/browser/WebRTC work.
Its Meson project version is 4.1; the separately received v2 source tree declares
5.0.1. Reconcile those source identities before applying upstream patches; do not
overwrite the current checkout with a fork or assume both trees contain the same
upstream fixes.

Current source already includes authenticated browser receiving, bounded queues,
visibility/return handling, input cancellation, Mac system audio, recovery/input
guards and native SPS/PPS injection on IDRs. In-progress browser code also includes
werift H.264/Opus WebRTC, an explicit private interface, no public STUN/TURN,
`playsinline`, and a Mac Baseline-profile option. These are source observations,
not new physical qualification. LAN discovery and opt-in retries already exist;
the historical recommendations below should not restart that work.

### Prioritized adaptations

1. **WebRTC negotiation and recovery tests — highest immediate value.** Direct
   fork [behlock/scrcpy-hw](https://github.com/behlock/scrcpy-hw) at
   `86e3f27e1535301d7d97f62833f2433e886ba7fb` adds an Apache-2.0 native
   libdatachannel sender. Its useful details are waiting for an open media track
   and IDR, placing SPS/PPS and IDR in one access unit, source-PTS RTP timestamps,
   packetization-mode selection, sender reports and a bounded NACK cache.
   dskcpy already injects SPS/PPS and uses werift's RTP sender, which already
   implements RTCP sender reports and NACK handling. Adapt regression cases and
   verify negotiation rather than adding a second RTP stack.
   The current adapter requests a keyframe for every RTCP type 206 packet;
   narrow that to PLI/FIR feedback and test other feedback types. Validate actual
   SPS/profile/level against the negotiated format, large fragmented IDRs,
   packet loss, reconnect and Safari mDNS/private-route candidates.
   [Sender source](https://github.com/behlock/scrcpy-hw/blob/86e3f27e1535301d7d97f62833f2433e886ba7fb/app/src/webshare/webrtc_peer.c).
   Do not copy its absent authentication, public-STUN workaround, hardcoded
   lower-than-actual H.264 level, latency claims or video-only/live-edge hacks.

2. **Recover WebCodecs without ending the approved session.** MIT-licensed
   [Tango/ya-webadb](https://github.com/yume-chan/ya-webadb) at
   `d22e9dc3c9d53178f4cf88cd757253f7ce780b10` handles browser-reclaimed decoders,
   checks software-decoder support after a hardware-decoder error, and separates
   decode/render queues and counters. dskcpy retains configuration and rebuilds
   codecs on return, but its decoder error callback ends the session and it
   does not call `VideoDecoder.isConfigSupported`. Adapt exact-config preflight,
   one bounded supported software retry, and explicit reclamation/IDR recovery.
   Preserve generation guards, authorization and bounded memory; do not import
   an unbounded GOP replay cache. Test delayed old callbacks, denied software
   support, configuration changes and repeated reclaim/return.
   [Decoder state machine](https://github.com/yume-chan/ya-webadb/blob/d22e9dc3c9d53178f4cf88cd757253f7ce780b10/libraries/scrcpy-decoder-webcodecs/src/video/utils/video-decoder-stream.ts),
   [render flow control](https://github.com/yume-chan/ya-webadb/blob/d22e9dc3c9d53178f4cf88cd757253f7ce780b10/libraries/scrcpy-decoder-webcodecs/src/video/render/flow-control.ts).

3. **Mac window capture and geometry — next platform feature.** None of the
   sampled direct scrcpy forks provided a verified Mac-host capture replacement.
   Apple's [ScreenCaptureKit sample](https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-in-macos)
   demonstrates desktop-independent window filtering, frame content rectangles
   and scale metadata, and updating a running filter/configuration. OBS at
   `fe1ed7955f300efd17fc59f65938388e43d8bb06` provides a further source reference
   for window geometry, resizing and failure handling in
   [mac-sck-common.m](https://github.com/obsproject/obs-studio/blob/fe1ed7955f300efd17fc59f65938388e43d8bb06/plugins/mac-capture/mac-sck-common.m).
   Start with explicitly selected fixed-canvas window capture; handle close,
   minimize and resize without falling back to the whole desktop. Live target
   changes also require encoder/header/input-coordinate handling: updating SCK
   alone does not make SRD1 geometry mutable. OBS is GPL-licensed; keep it a
   reference pending a licensing decision before copying code.

4. **Mac audio-format and route diagnostics — investigate, not a claimed fix.**
   Apple demonstrates reading the actual ASBD and AudioBufferList; OBS reads
   channels, sample rate and source presentation timestamps. dskcpy currently
   accepts only 48 kHz, stereo, float PCM. Instrument format changes, queue drops,
   discontinuities and output-route transitions; introduce bounded conversion
   only if observed formats require it. This does not establish the cause of the
   reported stutter or replace qualification of the prepared Android audio fix.
   Use harmless audio and independently verify USB, Wi-Fi, mute and route changes.

5. **WebRTC A/V negotiation reference, not a new backend.**
   [WebScreen](https://github.com/huonwe/webscreen) at
   `5dc2dbe96a0722f5a6b4cad44c3cb5decdd955ab` registers several H.264 profiles,
   Opus, RTCP feedback and related A/V stream IDs in
   [webRTCManager.go](https://github.com/huonwe/webscreen/blob/5dc2dbe96a0722f5a6b4cad44c3cb5decdd955ab/webservice/webRTCManager.go).
   Adapt the interoperability test matrix and common-clock/A/V-sync checks to
   werift. Running its server on macOS does not prove Mac desktop capture.
   It is AGPL-3.0; source copying needs a licensing decision. Do not adopt its
   default-public/default-unprotected deployment examples or public STUN.

6. **Keyboard correctness for the later input phase.** Open upstream
   [PR 7151](https://github.com/Genymobile/scrcpy/pull/7151), head `49848b82`,
   records the key-down action by scancode so releasing a modifier first does
   not lose the matching key-up. This is an Android-direction patch, not a
   drop-in Mac/browser keyboard implementation. Adapt the state invariant when
   adding browser keyboard/IME, including modifier order, layout changes,
   autorepeat and release-all on focus loss/Stop. Its reported device results
   are the contributor's evidence; macOS was untested.

### Other forks and upstream fixes checked

| Candidate | Current inspection | Decision |
| --- | --- | --- |
| NetrisTV/scrcpy `feature/websocket-server`, `a965ae3` | 14 commits ahead and 1,948 behind current upstream master; old custom Android/WebSocket server | Reference only; do not merge the obsolete base |
| NetrisTV/ws-scrcpy, `cd6cea6` | MSE, WASM and WebCodecs player alternatives; the WebCodecs player still has a support-check TODO and emits zero timestamps/all-key chunks | Optional fallback architecture reference; prefer current WebRTC work and Tango's decoder implementation |
| Mel0nFish/ws-scrcpy-enhanced, `32e58f9` | Adds audio and experimental WebRTC; README warns about authentication and compatibility gaps | No wholesale import; no demonstrated Mac-host/audio-stutter fix |
| MT-Taybii/scrcpy and DevlinW/scrcpy-qol default branches | Both 0 ahead / 70 behind current upstream master | No unique default-branch patch to port |
| rom1v/scrcpy default branch | One unique change involving Android AIDL/build wrappers; 425 behind | No Mac-host/browser priority |
| hitayou/scrcpy-gui2 default branch | 16 ahead / 71 behind; Python GUI/build/documentation changes | No Mac capture or media transport improvement |
| [Open PR 7067](https://github.com/Genymobile/scrcpy/pull/7067), head `ed673a94` | Contains Android audio-encoder RuntimeExceptions and cleanup failures | Review for inherited Android-to-PC mode; the reverse AudioTrack player already catches RuntimeException, so this is not a fix for its stutter |
| [Open PR 7124](https://github.com/Genymobile/scrcpy/pull/7124), head `42627545` | Recognizes multiword `no permissions` ADB state | Useful USB diagnostics, primarily Linux; below the Mac/browser priorities |

Comparison counts are against upstream master at review time, not against
dskcpy's custom reverse protocol. All inspected patches remain unintegrated.
Recommended order: negotiation/feedback regression cases, bounded WebCodecs
recovery, final-candidate physical browser tests, then Mac window capture and
evidence-led audio-format work. Preserve current work and coordinate shared
protocol/receiver ownership before implementing those larger changes.

## Historical review — 2026-09-05

Snapshot: 2026-09-05. Reviewed the 50 most-starred direct forks and 30 newest
forks returned by GitHub, then inspected selected repositories, release notes,
and source files. This is a shortlist, not an exhaustive scan of the fork network.
Repository push dates can reflect branch activity or upstream synchronization;
they do not prove a current protocol or a useful feature delta.

## Recommended candidates

| Priority | Project and activity | Relevant feature | Port assessment |
| --- | --- | --- | --- |
| 1 | [Escrcpy](https://github.com/viarotel-org/escrcpy), pushed September 1; Apache-2.0 | LAN discovery of ADB pairing/connect services and progress states | Best immediate fit. Public scanner code separates `adb-tls-pairing`, `adb-tls-connect`, and legacy ADB, deduplicates endpoints, and disposes discovery resources. Adapt this into the Node service and React connection screen. dskcpy already pairs by explicit address but has no discovery flow. Prefer an explicit discovery action and device selection; do not copy automatic broad probing or port-5555 fallback into Internet mode. Medium scope. |
| 2 | [scrcpy-vscode](https://github.com/izantech/scrcpy-vscode), July 19 release commit `4e362e4`; Apache-2.0 | Bounded reconnection, explicit connection states, manual-disconnect suppression | Its `DeviceService` has configurable retry limits, a fixed 1500 ms retry delay, and disposed/reconnecting guards. Adapt the state-machine idea into dskcpy's service, preserving Stop cancellation and keeping session secrets in memory. dskcpy currently exposes manual Reconnect. Medium scope; include disconnect/retry/Stop race tests. |
| 3 | [QtScrcpy](https://github.com/barry-ran/QtScrcpy), pushed August 20; v4.1.1 released August 12; Apache-2.0 | JSON control profiles with normalized coordinates, clicks and drags | The August 9 v4.1.0 release explicitly upgraded its server to scrcpy 4.1. Profile concepts are useful, but its Qt keyboard-to-Android-touch implementation runs in the opposite direction to reverse display. Adapt the schema for Android touch controls that issue Windows actions; this requires input protocol work, not a cherry-pick. Medium/large scope. Existing dskcpy performance presets are a separate feature. |
| 4 | [Tango / ya-webadb](https://github.com/yume-chan/ya-webadb), September 2 commit `f92c641`; MIT | TypeScript ADB and versioned scrcpy 4.1 parsing | Most relevant if adding Android-to-PC browser preview or a richer browser client. Source includes explicit 4.1 codec handling. Its stock scrcpy parser cannot decode dskcpy's custom reverse framing directly. Integrate selected libraries or write an adapter, retaining licenses. Large scope for a browser streaming feature. |

Escrcpy, QtScrcpy, Tango and scrcpy-vscode are related clients/wrappers rather
than direct Genymobile fork-network patches. Escrcpy also advertises private,
paid extensions; only the public scanner implementation was assessed here.

## Direct forks checked

- [NetrisTV/scrcpy](https://github.com/NetrisTV/scrcpy/tree/feature/websocket-server)
  is active: August 19 commit `a965ae3`, version `1.19-ws8`. Its WebSocket
  connection broadcasts video and releases the encoder when the last viewer
  leaves. However, GitHub comparison against v4.1 reports 14 commits ahead and
  1,877 behind. Treat it as an architectural reference for a future browser
  receiver, not a base to merge. Its custom framing and older Android server
  do not provide a drop-in Windows-to-Android transport.
- [hitayou/scrcpy-gui2](https://github.com/hitayou/scrcpy-gui2) has a September 4
  push timestamp, but its inspected default branch is exactly upstream v4.1
  (`2926c06`). No default-branch feature delta to port was found.
- [slickyincorp/slink](https://github.com/slickyincorp/slink) has September 4
  activity. The inspected latest commits rename documentation and Android
  identity. They do not demonstrate a reverse-display improvement.
- Popular forks last pushed in 2020-2024 were not prioritized over the current
  4.1 base. Root-only changes do not serve dskcpy's current companion workflow.

No reviewed fork supplied a verified drop-in replacement for dskcpy's Windows
capture, authenticated Internet bridge, or Android reverse-display receiver.
This finding is limited to the sampled repositories.

## Source pointers

- [Escrcpy public discovery implementation](https://github.com/viarotel-org/escrcpy/blob/1e87397da0535b825d5e2e87a53e08fa3896f4a9/desktop/electron/middleware/adb/helpers/scanner/index.js)
  and [discovery UI](https://github.com/viarotel-org/escrcpy/blob/1e87397da0535b825d5e2e87a53e08fa3896f4a9/desktop/src/views/device/components/wireless-group/discover-action/index.vue).
- [scrcpy-vscode session management](https://github.com/izantech/scrcpy-vscode/blob/4e362e4cf9ed96fc0bc15769b0c8707463d21aa3/src/DeviceService.ts).
- [QtScrcpy 4.1 server update](https://github.com/barry-ran/QtScrcpy/releases/tag/v4.1.0)
  and [key-map format](https://github.com/barry-ran/QtScrcpy/blob/dev/docs/KeyMapDes.md).
- [Tango 4.1 codec parser](https://github.com/yume-chan/ya-webadb/blob/f92c641d25af71c8b892efb1e6495bfeba9e1116/libraries/scrcpy/src/4_1/impl/parse-video-stream-metadata.ts).
- [NetrisTV WebSocket connection](https://github.com/NetrisTV/scrcpy/blob/a965ae33362d061ac83b697ba6b7df25d1dc00fc/server/src/main/java/com/genymobile/scrcpy/WebSocketConnection.java).

LAN discovery and bounded opt-in USB/LAN reconnection are now implemented in
the GUI service; see [usage and limits](../gui/README.md#wireless-discovery-and-recovery).
Discovery uses ADB's existing mDNS command instead of importing Escrcpy's scanner.
The session implementation preserves dskcpy's cancellation and single-use-secret
rules. Qt control profiles and Tango browser streaming remain future candidates.
No third-party implementation source was copied.

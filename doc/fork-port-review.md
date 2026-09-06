# Fork and companion-project port review

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

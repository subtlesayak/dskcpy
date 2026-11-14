# Mac input permission while sharing

The desktop shell's Accessibility preflight is not proof that the native capture
process can send input. A physical unsigned-app test reproduced video with no
touch or typing while the shell and System Settings showed control enabled.
Later diagnostics also identified saved requirements for an older app signature.

The native full-desktop capture process now reports its own `AXIsProcessTrusted`
result as fixed `DSKCPY_INPUT_PERMISSION ready|blocked` stdout records. It samples
on the existing 250 ms maintenance tick and writes only state changes. This does
not prompt, grant permission, send input, or expose field contents or app names.
Selected-window view-only and ended sessions publish no input status.

The service accepts records only from the current Mac full-desktop child and
capture generation. Stderr, malformed records, Windows and selected windows
cannot assert this permission. Status starts `unreported` and resets on capture
termination/replacement; old native hosts therefore cannot silently assert ready.
Reserved metadata stays out of raw logs, including partial records on exit.
Only the fixed enum crosses the desktop app's owned IPC.

During sharing, a blocked result replaces the positive control claim with Mac
permission guidance. Unreported status explicitly leaves control unverified.
Both offer **Open control permissions** and retain **Stop sharing**. A grant
reported by the same native process clears the warning without a restart. These
are permission results, not proof that a target application accepted an event.
There is no automatic permission reset, process replacement or reconnect.

## Software qualification

- Original service and shell snapshots fail the new fake-native regressions;
  the fixed source passes current-child, reset, malformed/stderr, Windows and
  selected-window cases without stopping capture.
- Actual native translation-unit tests intercept permission queries and OS
  events. Denied → granted, duplicate suppression and window/ended exclusions
  pass with zero OS events. All 30 normal, 30 ASan/UBSan and 30 pinned-static
  native tests pass. Dynamic development libraries target a newer OS; they do
  not qualify minimum macOS 13 support.
- Node suite: 467 total, 460 pass, seven optional skips, with the real no-capture
  logger fixture enabled. Both UI builds pass.
- Six owned headless UI cases cover 320 px, 620 px, 200% CSS zoom and LTR/RTL.
  Shell-ready/native-blocked guidance appears, opening mocked permissions never
  stops sharing, a native grant clears it, and Stop remains available.

This source is separate from the human-tested source92 app repair. That local
ad-hoc bundle-sealing, normal-path replacement and app-only permission reset
restored touch, committed typing and opt-in automatic keyboard opening on the
identified app. It does not physically qualify this new telemetry binary,
Developer ID/notarization, stable upgrades, other Macs, Windows or audible audio.
No live app or receiver is updated by these source checks.

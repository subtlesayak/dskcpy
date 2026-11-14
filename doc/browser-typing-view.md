# Readable phone typing

Opening Keyboard temporarily frames the last accepted desktop tap. When a
docked phone keyboard leaves only a short strip, the receiver enlarges that
area instead of shrinking the entire desktop into a thumbnail. **Zoom while
typing** turns this framing off or on. Closing Keyboard restores the previous
zoom and normalized pan position, including after viewport/orientation changes.

The target is a local tap coordinate, not a discovered Mac text-field boundary.
No field contents or Accessibility geometry are requested. With no known tap,
the receiver does not guess a target. New source geometry discards stale targets.
Typing magnification is bounded at 10×; ordinary Move view gestures retain their
existing 4× limit. Existing transformed coordinates still map to the source frame.

In a sufficiently wide landscape viewport, **Floating keyboard layout** places
the desktop beside a reserved typing area (on the right in LTR). Use the phone
keyboard's own Floating and drag controls to put it there, if available. The
browser does not move, replace or emulate the system keyboard. Narrow, portrait
or very short viewports fall back to the compact typing bar. Preferences stay in
the current page; typed text is not saved by this feature.
The floating-layout button stays available in wide docked landscape mode. Select
it to see the phone-keyboard instruction; the side area activates when the
keyboard stops consuming the available height.

The native keyboard/IME helper is unchanged. Touching the framing buttons keeps
the typing field focused; layout changes retain composition and paired keys.
The existing authentication, view-only, pause, background and input guards remain
in force. This is receiver-local framing, not target-relative Mac window input.

## Verification

`gui/server/typing-view.test.mjs` checks target visibility, normalized restoration,
no-target behavior, source reset, invalid geometry and turning zoom off/on.
`gui/server/view.test.mjs` checks separate typing/navigation limits.

`desktop/test/typing-view-ui.mjs chromium` and `webkit` run the actual receiver,
an owned broker, generated 1600×900 H.264 frames and a fake native input collector.
They model docked keyboard viewport changes and verify source-coordinate taps,
single Unicode text delivery, focus retention, prior-view restoration, no
horizontal overflow and separation of the floating-keyboard space. Scenarios
include landscape, portrait, RTL, 320 px and 200% CSS zoom. Generated desktop art
replaces decoded pixels only in the test; the decoder and transport remain real.
No actual Mac capture, phone IME, permissions or OS input are exercised.

On the combined native-permission/typing source, all six scenarios pass in each
engine. The Node suite passes 466 of 473 tests with seven optional skips and the
no-capture logger fixture enabled. Both UI builds pass. Native production code is
unchanged from the separately qualified input-permission source (30 normal,
30 ASan/UBSan and 30 pinned-static native tests); these are software results.

The media fixture sends configuration once and treats Resume/IDR idempotently.
Earlier header-only WebKit recovery and incorrect fixture configuration-loop
failures are retained separately, not counted as passing decoding tests.

Phone Edge/Gboard readability, native Floating placement, suggestion replacement
and orientation changes still need physical testing on this new UI. The existing
live app is not modified by these checks. The separately repaired earlier app's
touch, typing and automatic-keyboard results do not qualify this new layout.

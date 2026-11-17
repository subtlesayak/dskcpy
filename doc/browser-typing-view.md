# Readable phone typing

Opening Keyboard temporarily frames the host's insertion position when a
capable Mac supplies it, with the last accepted desktop tap as fallback. When a
docked phone keyboard leaves only a short strip, the receiver enlarges that
area instead of shrinking the entire desktop into a thumbnail. **Zoom while
typing** turns this framing off or on. Closing Keyboard restores the previous
zoom and normalized pan position, including after viewport/orientation changes.

The optional `browser-focus-geometry-v1` capability requires the native
`--reverse-text-focus-geometry`, base focus and full-desktop keyboard flags.
The Mac queries only an editable element's role, insertion-range bounds and,
when range bounds are unsupported, its rectangle. Numeric range indices stay
inside the native helper; it never reads field values, selected text or titles.
The focused process/element is rechecked before a rectangle is usable. Reported
secure subroles, invalid geometry, lost permission and changed focus yield no
geometry. Rectangles are clipped to the captured display and normalized to a
fixed grid; no process identity or global position crosses that boundary.

Only an authenticated, capable, explicitly subscribed receiver gets geometry.
The current viewer subscribes while its Keyboard panel is open. Pause, background,
recovery, blocked input, source retirement and socket replacement suppress it.
The controller consumes complete and unterminated reserved metadata separately
from user logs. Windows and older hosts keep last-tap framing. With neither a
known tap nor usable geometry, the receiver does not guess a target. A new tap
supersedes a queued rectangle for the prior field; source changes discard targets.
An active desktop contact retains its coordinate mapping until release.
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
the typing field focused and preserves its local text preview; layout changes
retain composition and paired keys. Touching the desktop or other tools still
clears that preview so a later suggestion cannot replace text at a new cursor.
Repeated layout notifications also retain a paired click when its input mapping
has not changed. An actual stage, frame or view-transform change still cancels
held contacts. Selected framing icons retain contrast while hovered.
The existing authentication, view-only, pause, background and input guards remain
in force. Geometry cannot enable input, clipboard access or window control.
This is receiver-local framing, not target-relative Mac window input. The native
SRD media/input wire layout is unchanged; geometry uses optional controller
metadata and browser JSON alongside the existing one-bit focus hint.

Apple documents [text-range bounds](https://developer.apple.com/documentation/applicationservices/kaxboundsforrangeparameterizedattribute)
and [unsupported-query errors](https://developer.apple.com/documentation/applicationservices/1461203-axuielementcopyparameterizedattr).
AX position and display bounds use the global top-left screen coordinate model;
physical Retina pixel dimensions are not used as the normalization divisor.
Actual provider behavior and Retina/multiple-display mapping remain physical gates.

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

Adding the `geometry` argument runs the same six layouts with host-supplied
synthetic caret rectangles away from the last tap. It checks actual target
framing and mapped clicks, ignores geometry while a contact is held, and retains
composition/focus and single Unicode delivery while a new target arrives. Both
modes also require typed text to remain visible across layout-button changes.
The native fixture compiles the production query against fake AX, permission
and frontmost-app functions, including secure fields, unsupported attributes,
malformed types, off-display carets and focus/permission changes. No real AX
object, field contents, pasteboard or input API is accessed by that fixture.

The earlier tap-only candidate's qualification remains artifact-specific.
On the geometry source, all six fallback and all six geometry scenarios pass in
each engine. The server/desktop and tools suites together pass 482 of 489 tests
with seven optional skips and the no-capture logger fixture enabled. Both UI
builds, 31 pinned-static native fixtures and all 31 address/undefined-behavior
sanitizer fixtures pass. The isolated production-query fixture also passes those
sanitizers. These checks do not qualify a signed app, minimum OS or physical media.

The media fixture sends configuration once and treats Resume/IDR idempotently.
Earlier header-only WebKit recovery and incorrect fixture configuration-loop
failures are retained separately, not counted as passing decoding tests.
The first PR CI also caught a cancelled WebKit tap after a redundant layout pass.
A deterministic receiver regression reproduces the down/cancel result before
the mapping guard; it now requires down/up across an unchanged layout and
down/cancel across a changed mapping. Generated flows inject that duplicate
notification between pointer down/up rather than hiding the failure with retries.

Phone Edge/Gboard readability, native Floating placement, suggestion replacement
and orientation changes still need physical testing on this new UI. The existing
live app is not modified by these checks. The separately repaired earlier app's
touch, typing and automatic-keyboard results do not qualify this new layout.

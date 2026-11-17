# External display and phone controller

Status: isolated browser/backend prototype, not a qualified casting feature. No phone, TV or
casting device is available for physical qualification as of 17 November 2026.
The existing receiver, trackpad, keyboard and private transport remain the base.

The prototype adds a disabled-by-default `presentationControl` receiver
capability, an independently authenticated controller socket and one input owner.
The ordinary receiver defaults are preserved. Owned loopback/fake-native tests
exercise role-bound one-use pairing, distinct HttpOnly cookies, no implicit
controller replacement, media isolation, input release, independent controller
expiry/leave, explicit whole-session Stop and native/media recovery. WebRTC
offers and frame/audio delivery remain with the presentation while the controller
is hidden. These are server/software checks, not a phone or casting test.

Separate browser views, guided mechanism selection, pointer sensitivity and
independent End presentation are implemented in this source prototype. The
desktop service negotiates it only when its own environment explicitly sets
`DSKCPY_EXPERIMENTAL_PRESENTATION=1`; the default is off. Window/view-only grants,
local preview and hosts without browser keyboard support cannot mint controller
access. No installed application or running service has been changed.

This needs matching server, receiver and native modules. Do not copy its browser
assets into an older running application. Negotiated secondary click is now
implemented in source; Windows native compilation, actual clicking, casting
and physical background/audio qualification remain open. The current human
decision is to preserve the working session and prepare candidates only.

## Intended flow

Choose **Use phone as touchpad and keyboard** from an authenticated full-desktop
receiver. Explain that the external display receives the Mac desktop and its
selected audio, while the phone provides input. Ask which display connection the
user will use, then show only the steps appropriate to that mechanism.

For the first Samsung trial, prepare a presentation-only page in Samsung
Internet and a controller-only page in a different browser application. Start
Smart View and select App Cast for the presentation application. The controller
page contains the touchpad, keyboard and session controls, without desktop media.
Switching tabs inside the cast application is not sufficient separation: the
cast target is the application, not a dskcpy tab selected by CSS.

This two-application workflow is an engineering hypothesis requiring the exact
device combination below. Samsung documents App Cast through Smart View and
lists Samsung Internet among supported applications, but that does not establish
dskcpy WebRTC playback, background execution or privacy behavior. [Samsung App
Cast documentation](https://www.samsung.com/ae/support/mobile-devices/s23-series-app-cast-feature/)

Keep setup credentials and pairing UI on the phone before presentation begins.
Offer **Share controller link** or **Copy controller link** after explicit
controller creation, with a masked manual-copy fallback. Each action requires a
separate gesture. Do not assume a browser can force another
browser to open, or require the user to scan a QR displayed on the same phone.
Never put an enrollment QR or connection secret over the cast desktop picture.

## Mechanism selection

| Mechanism | Proposed path | Qualification and limits |
| --- | --- | --- |
| Samsung Smart View → App Cast | Cast a presentation-only browser application; use another browser application for the controller | First physical target. Verify playback continues while using the other app and that keyboard, notifications and unrelated apps never appear on the external display. No browser feature probe proves this. |
| Browser Presentation API | Open the presentation URL in a separate receiving context after an explicit user action | Feature-detect in a secure context. API presence is not display availability or successful playback. The receiving context still needs an authenticated route to this host. |
| Browser directly on a TV/monitor/computer | Pair that browser as presentation-only and the phone as controller | Both contexts need private host reachability. Do not assume a TV can join the existing VPN or provision a new relay. |
| Full-screen phone mirroring | Explicitly labelled fallback | The phone UI and notifications may be mirrored. It does not satisfy separate-controller privacy or independent phone-app use. Never advertise it as app-only casting. |
| Video-element remote playback | Evaluate only on a compatible device | Media-element support alone does not prove that the existing WebRTC MediaStream or canvas path can be cast. No support claim until real playback is demonstrated. |

The [Presentation API specification](https://www.w3.org/TR/presentation-api/)
defines separate controlling/receiving contexts and exposes its interfaces in
secure contexts. The [Remote Playback API specification](https://www.w3.org/TR/remote-playback/)
operates on media elements and leaves the remote transport to the browser.
Neither specification guarantees support by the actual browser, display or
private-network route. These are alternatives to evaluate, not new required
accounts, public endpoints or infrastructure.

## Implemented server separation

The ordinary combined receiver retains its original single-peer lifecycle.
`gui/server/browser.mjs` and `gui/server/browser-session.mjs` add independent role
slots when this prototype is explicitly enabled. A controller does not reuse the
media attach path or replace the presentation peer.

The explicit `presentation` and `controller` role slots share one native
capture owner. Preserve the existing combined receiver as the default. An
external-display session has at most one presentation media peer and one active
controller input peer. The role is a server authorization property, not a URL
parameter, UI checkbox or user-agent string.

- The presentation receives media/configuration and may acknowledge its own
  media epoch. It cannot send mouse, key, clipboard or input-owner messages.
- The controller receives dimensions, capability/input-readiness and focus hints,
  but no media frames, RTC offer or audio playback. Existing committed-text and
  trackpad helpers supply its input. It cannot send decoder acknowledgements,
  video-pause commands or adaptive-video feedback.
- Media feedback and backpressure belong only to the presentation. Controller
  visibility must not reset the media sender, drain its pending acknowledgements
  or change its native capture state.
- Session-wide Stop remains authoritative and performs the current native
  input/media cleanup before retiring the owner. Preserve user-stopped capture,
  permission denial, window restrictions and bounded recovery rules.

## Authorization and input ownership

Create a second-role invitation only after a deliberate action by an
authenticated full-control receiver or the host. A view-only/window grant cannot
mint a control grant. A remembered viewer is not silently upgraded to a cast
controller or enrolled into another browser.

Use a new cryptographically random, short-lived, one-use role capability bound
to the exact session, origin, role, policy and session generation. Follow the
existing five-minute invitation bound and authentication-attempt limits. Carry
the capability in a fragment, remove it before the page loads other resources,
and submit it through the authenticated WebSocket exchange; never authorize a
GET or put credentials in query strings, logs, status or browser storage.
Store the capability digest server-side and compare it in constant time.

Issue distinct opaque HttpOnly, SameSite=Strict role cookies, Secure on HTTPS,
scoped to their role routes. Separate names and paths prevent two same-origin
tabs from overwriting the current generic resume cookie. Validate Host/Origin,
session generation, role and policy on each attach. The shared cast application
never receives the controller credential. Keep the existing bounded five-minute
away recovery and original session lifetime; a controller reattach does not
renew the session or restart an ended capture.

Only one input owner exists. Entering controller mode releases input from the
old combined peer before explicitly transferring ownership; the presentation
does not retain fallback input permission. A second controller is rejected as
busy; the current controller must leave before another invitation is created.
Ownership is checked on
every packet against both socket and generation, so stale queued input cannot
reach the native host after transfer. Reconnection gets a fresh input epoch and
starts with no held buttons or modifiers. Clipboard remains separately opted in
and is not enabled merely by pairing a controller.

## Independent lifecycle

The native Host app receives only fixed presentation/controller status booleans
through its utility-process IPC. It distinguishes a connected presentation,
an unavailable presentation and an ended presentation. Phone-control status
separately reports connected, paused, disconnected or not yet paired. These
states describe browser connectivity; they never claim that a physical TV is
casting. Ending the presentation leaves the remaining session stoppable without
asking for unnecessary mouse/keyboard permissions or claiming video continues.

Explicit **Stop sharing** in the Host window or menu-bar/system-tray menu asks
**Stop sharing this desktop?** with **Cancel** as the default and **Stop sharing**
as the confirming action. Cancel preserves the current session. Repeated clicks
share one pending question. Cancelling an unused invitation remains immediate;
programmatic cleanup and permission/native-stop handling do not wait for a
dialog. The existing browser power action also asks before ending the session.

### Host status and action copy review

| Severity | Location | Before | After | Why |
| --- | --- | --- | --- | --- |
| High, fixed | `gui/src/desktop/main.tsx` | Your screen is being shared after End presentation | Presentation ended; remaining session can be stopped | Distinguish ended media from remaining authorization. |
| High, fixed | `desktop/main.cjs`, `desktop/stop-action.mjs` | Explicit Host Stop immediately ends access | Cancel / Stop sharing confirmation | Avoid accidental termination from the window or tray. |
| Medium, fixed | `gui/src/desktop/main.tsx` | No phone-role status in the Host app | Phone controls connected, paused, disconnected or unpaired | Give a specific next action without claiming physical casting support. |

Copy decision: **Approve** for these inspected English status and action strings.
Chromium/WebKit generated flows cover keyboard traversal, visible Stop focus,
Cancel/Confirm, narrow/RTL and 200% CSS zoom layouts. A hidden packaged Electron
fixture exercises the real preload/IPC and packaged Stop helper with a synthetic
prompt. Actual native OS dialog behavior, assistive-technology announcements,
translation and physical casting remain **Not verified**; these checks do not
qualify an installed app or live device.

| Event/action | Controller effect | Presentation/session effect |
| --- | --- | --- |
| Controller blur, hidden, socket loss or leave | Immediately release held input; discard queued motion/text and clipboard work; retire input ownership as appropriate | Continue media if the platform permits; show controller-away status |
| Controller returns within its recovery bound | Reauthenticate its role, then explicitly acquire an empty input epoch | Keep the current capture and media epoch |
| Presentation hides during confirmed App Cast | No new input ownership | Platform behavior must be measured. Do not treat document visibility alone as proof that casting ended or ignore all lifecycle events globally. |
| Presentation disconnects/cast ends | Release input and disable it while the display is absent | Stop audio, retire RTC/ACK epoch, retain only bounded reconnect authorization; show display-disconnected status |
| Leave controller | Revoke this controller role, release input | Presentation stays visible; user may attach a new explicitly authorized controller |
| End presentation | Release/disable input, keep a status page | End media and its role authorization; do not claim that the whole host service has stopped |
| Stop session / native user-stop / permission denial / owner expiry | Revoke all role capabilities and cookies; release input | End native capture/media using existing cleanup and cancellation rules; no automatic unauthorized restart |

Avoid inferring casting state from browser visibility or orientation. Where an
OS-only App Cast state cannot be observed, make the setup choice explicit and
label status as unverified until the user confirms external playback. A hidden
controller always releases input regardless of any casting choice.

## Phone and display UI

The controller uses a large relative touchpad, an adjustable pointer sensitivity
control and the existing finger-scroll speed control. Keep tap-to-click,
explicit drag/release, two-finger scroll, a secondary-click action and the
keyboard toggle reachable with the software keyboard open. Reuse committed
Unicode/IME, Backspace, Enter, Tab, Escape, navigation keys and configured
modifiers; do not replace the tested Gboard editing helper.

Pointer sensitivity ranges from 0.25× to 4×; finger scroll speed ranges from
0.5× to 8×, with a 2× default. Only these numeric preferences are saved per
receiver origin. The dedicated pad uses uniform horizontal/vertical pointer
scaling, including a tall portrait pad. Sensitivity never changes scroll gain.

Secondary click uses an explicit button and a separately negotiated host
capability. It stays disabled with an explanation on older hosts. The ordinary
receiver offers its icon in Trackpad mode. There is no long-press heuristic or
reinterpretation of Android touch fields. Mac/Windows hardware qualification is
still required.

### Optional pointer-button protocol

`--reverse-pointer-buttons` advertises `browser-pointer-buttons-v1` and requires
the full-desktop browser keyboard/socket opt-in. Readiness requires the exact
flag, capability and supported host backend before a browser invitation can
enable it. Local preview, window/view-only and Android routes cannot enable it.
The controller authorization and input-owner checks apply to every packet.

| Byte | Meaning |
| --- | --- |
| 0 | Device-message type 11 |
| 1 | Action 0: one atomic secondary click; other values rejected |
| 2–5, 6–9 | Big-endian unsigned x and y in current captured-frame pixels |
| 10–11, 12–13 | Big-endian unsigned width and height, 1–16384 |

The message is exactly 14 bytes at the browser boundary. Coordinates must be
inside the exact current geometry. Native parsing supports fragmented transport
and validates the action, sizes and bounds again. SRD1 media framing, existing
system-action value 11 (audio disable) and all Android packet shapes are
unchanged. Type 11 was unused in the checked native enum and Java sender and
not reserved by the latest shared handoff; the native-input owner reported no
overlapping work. Later protocol owners must preserve this allocation.

Windows serializes admission, mapping and cleanup with its input mutex. A
partial SendInput result retains only the pending right-button release; it
never retries the press or moves to an old coordinate during cleanup. New
pointer input is blocked while release is pending, including across geometry
changes. Existing touch/keyboard cleanup and the regular native loop retry that
release. This uses the API's ordered batch and returned delivery count; actual
OS delivery and UIPI behavior remain hardware checks. [Microsoft SendInput
reference](https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-sendinput)

Mac prepares both right-button events before posting either; allocation failure
produces no half-click. State, geometry, full-desktop and Accessibility checks
guard posting, and a physically held secondary button prevents a new click.
Event construction is tested without CGEventPost or permission calls; this does
not prove OS delivery. [Apple mouse-event constructor](https://developer.apple.com/documentation/coregraphics/cgevent/init(mouseeventsource:mousetype:mousecursorposition:mousebutton:))

The presentation uses the display's viewport and preserves desktop aspect ratio
through orientation/resolution changes. It has no phone keyboard or normal
controller rail. Its audio is the only media playback route in this mode, with
explicit presentation mute and user-gesture activation when required. Controller
pages create no AudioContext or media element. The host may still play through
its local speakers; do not silently change the host's audio route or volume.

Show separate **Presentation connected** and **Controller connected** status,
with **Leave controller**, **End presentation** and **Stop session** actions that
match the lifecycle above. Full-screen mirroring must retain a clear privacy
notice rather than displaying a reassuring app-only-cast indicator.

These three explicit actions ask for confirmation. Cancel keeps the current
session. End presentation retires its media authorization and disables input,
while the controller remains authenticated on a status page with Stop sharing
available. Its HttpOnly cookie can restore that status-only connection after a
transient socket loss, within the original recovery/session bounds. Reconnecting
does not restore input, restart media or renew the ended presentation's expiry.
Detach/attach may still send input-release cleanup. Neither the ended
presentation nor native recovery may start capture
again under that old grant. The ordinary receiver's power button also asks
before ending the entire session; transport failures do not show that prompt.

An explicit, initially unchecked background-playback choice changes the
presentation's visibility policy for an App Cast trial. It is not detection that
casting is active. Controller visibility always releases input, and page unload
still closes/suspends its resources. Browser or OS suspension may stop playback.

The controller contains no video, canvas, audio element or AudioContext. Its
landscape keyboard layout keeps the pad on the left and the typing field,
Close button and physical arrow directions on the right. Portrait stacks them.
Native range controls, buttons and a shortcut selector provide keyboard paths;
Ctrl/Shift/Alt/Command selection applies only to an explicit Send shortcut.
Focus hints cannot interrupt Options or clear the preview during Gboard edits.

## Source and generated-browser checks

The source check includes 544 Node cases: 537 pass and seven optional skips.
Mac native tests pass 34 normally and 34 with address/undefined sanitizers.
The Windows production admission/coordinate/SendInput callback bodies also
compile against fake effects, exercising denied states and partial-release
cleanup; this is separate from compiling or running a real Windows host.
Both React UI builds pass. `desktop/test/presentation-ui.mjs` uses two separate
browser contexts, generated video and an owned fake native input collector.
Five flows each pass in Chromium and WebKit: portrait, landscape with a
simulated 220px keyboard viewport, 320px RTL, 200% CSS zoom and an older-host
capability case. These verify:

- one-use role pairing, fragment removal, distinct resume cookies and one native
  capture across controller reload;
- tap, drag cancellation, Unicode text, shortcut/modifier packets, arrow keys,
  adjustable/persisted gains, negotiated secondary click and keyboard-only
  controls; the older-host case keeps secondary click unavailable;
- focus restoration, repeated focus hints during suggestion replacement,
  reachable typing/Close controls and no Options overlap;
- controller background input release while actual presentation decode counts
  continue, no controller media/audio objects, and independent confirmed End
  followed by whole-session Stop.

Actual automated two-finger touch is exercised through Chromium's touch
injection. WebKit exercises the other paths, not multi-touch hardware.
WebKit's keyboard traversal uses native Option-Tab; no system preference or
positive tabindex is introduced. No real screen-reader, phone IME, OS background,
cast privacy or audible route is qualified here.

The checks exposed and retained the initial failures: WebKit resize-observer
feedback at zoom, Options overlapped by an oversized pad, and fixture mistakes
around native dialog focus timing, selected video transport and Mac keyboard
navigation. The production fixes schedule geometry changes on animation frames,
write CSS sizes only when changed and preserve minimum pad content height.
Fixtures now observe the active transport and native focus behavior without
filtering page errors, forcing clicks or weakening continuity assertions.

### Layout and keyboard review

| Severity | Location | Before | After | Why |
| --- | --- | --- | --- | --- |
| HIGH, fixed | `gui/receiver/controller.css:9`, Options | Pad children covered the summary when its flex box shrank | Minimum content height keeps Options reachable | Complete the Options task; WCAG 2.4.11 focus visibility |
| MEDIUM, fixed | `gui/receiver/controller.mjs:262`, geometry observer | WebKit repeatedly resized after zoom | RAF scheduling and changed-size writes | Stable keyboard-open interaction |
| LOW, fixed | `gui/receiver/controller.html:42` and `gui/receiver/controller.css:21` | Mixed-direction preview and mirrored physical arrows | Automatic text direction and LTR physical arrow row | Predictable RTL typing/navigation |
| LOW, fixed | `gui/receiver/controller.css:18`, action buttons | Four narrow columns broke words at 320px | Two columns on small screens, four on wider screens | Readable labels with the keyboard open |

Approve the inspected generated layout and keyboard scope. Screen-reader,
physical-device and casting acceptance remain unverified.

## Implementation and acceptance sequence

1. Add opt-in server role authorization, ownership and independent transport
   lifecycles behind a disabled-by-default capability. Keep ordinary sessions
   byte-compatible and use one native capture, not a second host process.
2. Prove dual-context authorization, packet-role restrictions, no implicit
   replacement, ownership transfer, input release, expiry, native-user-stop and
   independent controller/media reconnect using owned fake-native fixtures.
3. Add presentation/controller pages and beginner setup, reusing current input
   modules. Use generated Chromium/WebKit flows for keyboard-open layouts,
   aspect changes, isolated audio and denied/busy/expired states.
4. Qualify the implemented negotiated secondary click and pointer sensitivity
   on Mac and Windows, including held-button cancellation and denied input.
5. On real Samsung hardware, record model, Android/One UI, browser versions,
   display/cast model and casting method. Demonstrate external desktop video,
   pointer, secondary click, typing/IME, dragging, scrolling, keyboard-open use,
   unrelated-app use and return, notifications excluded, audio/mute, cast loss,
   reconnect and clean Stop. Confirm actual routes without recording identifiers.
6. Test each alternative mechanism independently. If app-only separation cannot
   be demonstrated, offer the labelled full-mirror fallback and leave the
   separate-controller support case unqualified. Consider a small platform
   companion only after the browser route's concrete limit is established.

Generated two-page fixtures will establish server/browser behavior, not OS
casting, privacy, audible routing, minimum-device support or phone background
execution. Physical tests are deferred while hardware is unavailable; this does
not pause the wider host/browser implementation or complete its existing goal.

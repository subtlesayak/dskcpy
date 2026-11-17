# External display and phone controller

Status: implementation plan, not an available casting feature. No phone, TV or
casting device is available for physical qualification as of 17 November 2026.
The existing receiver, trackpad, keyboard and private transport remain the base.

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
Offer **Open controller in another browser** through the available share/open
flow, with a copy-link fallback. Do not assume a browser can force another
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

## Required server change

The current `gui/server/browser.mjs` owns one authenticated session and
`gui/server/browser-session.mjs` owns one `peer`. Attaching another receiver
replaces that peer, retires RTC and suspends capture. Its resume cookie does not
represent independent roles. Reusing the existing attach path for a controller
would disconnect the presentation; hiding the canvas would not fix this.

Introduce explicit `presentation` and `controller` role slots around one native
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
busy until the user explicitly replaces the owner. Ownership is checked on
every packet against both socket and generation, so stale queued input cannot
reach the native host after transfer. Reconnection gets a fresh input epoch and
starts with no held buttons or modifiers. Clipboard remains separately opted in
and is not enabled merely by pairing a controller.

## Independent lifecycle

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

Pointer sensitivity and secondary click are remaining implementation work.
Secondary click needs an explicitly negotiated host capability and corresponding
Mac/Windows validation; do not reinterpret an existing SRD1 field or emulate it
as an undocumented long press. Coordinate that shared input change before
implementation and preserve denial on older hosts.

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
4. Coordinate and implement negotiated secondary click plus pointer sensitivity.
   Qualify Mac and Windows behavior, including held-button cancellation.
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

# Automatic browser keyboard (Mac candidate)

In the receiver's **Options**, enable **Open keyboard for text fields**. When the
Mac reports that an editable field has focus, the receiver opens its typing panel
and attempts to show the phone keyboard. Manual **Keyboard** remains available.
The option appears only with authenticated full-desktop keyboard and focus-hint
capabilities. It is off by default, held only for the current browser session,
and cleared by Disconnect. Temporary same-session reconnect keeps the preference.

This requires an updated Mac native host and controller, not just a page refresh.
The existing active service was deliberately left running with its prior host.
Do not deploy or restart it while a remote user depends on the session without
agreement. The five-minute recovery upgrade is also source-only until that update.

The host's separate `--reverse-text-focus` option requires `--reverse-keyboard`
and the existing Accessibility permission. Every 250ms, bounded AX queries inspect
only the focused control's role, secure subrole, enabled state and whether its
value attribute is settable. The value itself, selected text, title, application
identity and clipboard are never read into hints. Unknown/unsupported/denied,
secure and read-only controls do not trigger automatic typing. Unusual custom
editors may need the manual button. Focus checks are not a semantic detector for
all pixels or all applications.

The opt-in host reports a fixed `DSKCPY_TEXT_FOCUS` 0/1/unknown marker through its
existing stdout pipe on changes or remote clicks. The controller consumes that
marker separately from logs, bounds the hint rate, and sends only a boolean/null
advisory message to the matching authenticated browser. Old native hosts omit the
flag and capability; Android and the native SRD1/input wire are unchanged. The
hint grants no input access and is ignored while paused, hidden, view-only,
touch-disabled, disconnected or already typing. Repeated hints do not refocus or
cancel IME composition. Stop/session changes invalidate the capability.

Automatic software-keyboard display is platform-dependent. Where supported, the
VirtualKeyboard API uses the opt-in gesture's sticky activation and a focused
local textarea. Viewport/overlay policy is unchanged; geometry can confirm an
actual keyboard opening. Browsers that decline or lack the API keep a visible
instruction to tap the typing field. Headless tests cannot qualify Android Edge
or Safari software-keyboard behavior.

References: [VirtualKeyboard specification](https://w3c.github.io/virtual-keyboard/#dom-virtualkeyboard-show),
[Chromium documentation](https://developer.chrome.com/docs/web-platform/virtual-keyboard),
[Apple accessibility roles](https://developer.apple.com/documentation/applicationservices/carbon_accessibility/roles).

# Explicit browser text clipboard

This candidate adds **text-only, explicit clipboard actions** for authenticated
full-desktop Mac and Windows browser receivers. It is off by default. Window
view-only, Android/native receiving and local same-computer preview do not
acquire clipboard access. No background clipboard polling or synchronization
is performed.

Before creating an invitation, the computer owner chooses **Allow text clipboard
for this invitation** in the desktop app or browser dashboard. The host checks
the separate `browser-clipboard-v1` / `--reverse-clipboard` native capability,
plus existing browser keyboard support. Unsupported hosts omit the setting.
Changing the connection or selected phone, ending sharing or restarting the
app clears the owner's permission. Sharing UI shows when clipboard permission
is allowed. It cannot be added to an already active stream.

On the receiver, open **Options → Clipboard** and explicitly enable its tools:

- **Read computer clipboard** loads plain text into the local preview only.
- **Copy to this device** writes that preview to the device clipboard, on click.
- **Paste from this device** reads its clipboard into the preview, on click. It
  sends nothing to the computer until a separate computer action is chosen.
- **Copy to computer clipboard** replaces the computer's clipboard text.
- **Paste on computer** copies the preview to the computer clipboard and posts
  its platform paste shortcut to the active app. It does not claim that the
  target app accepted it. If paste fails after the copy, check the active app
  before retrying; a timeout never automatically replays a write or paste.

If browser clipboard APIs are unavailable or denied, select/copy or paste text
manually in the preview. Empty writes, binary/rich formats, invalid UTF-8,
NUL/unsupported control characters and text over 4096 UTF-8 bytes are rejected.
Newlines and tabs are supported. Text is never stored in browser storage,
remembered-device grants, URLs, status, diagnostics or native stdout/stderr.
It exists transiently in the preview and transport/runtime buffers. Closing
these tools or Options, disabling input, losing keyboard capability, pausing,
backgrounding, disconnecting or restoring capture clears that preview and
requires a fresh receiver opt-in. Ending tools does **not** clear or overwrite
either system clipboard. The user's explicit copy result remains there.

## Negotiation and transport

The owner opt-in supplies `browserClipboard: true` only to the invitation and
native full-desktop command. The native `--reverse-clipboard` option requires
`--reverse-keyboard`, which already requires `--reverse-display --reverse-socket`
and excludes window/ADB selectors. The authenticated response advertises a
boolean `clipboard` capability only for this policy. A current viewer then sends
`clipboard-enable` before any request; `clipboard-disable` cancels pending work.
An old cached viewer never receives unsolicited clipboard metadata. A remembered
grant forcibly strips clipboard permission even if an internal caller supplies
it; trusted profiles still allow only size, FPS and bitrate.

Existing SRD1 header/media and native Android messages are unchanged. The
negotiated browser extension adds control type **10**:

| Offset | Size | Meaning |
| --- | --- | --- |
| 0 | 1 | Type 10 |
| 1 | 1 | Operation: 0 read, 1 write, 2 copy-and-paste |
| 2 | 4 | Positive big-endian request ID |
| 6 | 2 | UTF-8 byte count, at most 4096 |
| 8 | count | Text; empty only for read |

A controller-only cancellation is type 10/op 3 with zero ID/count. The browser
input validator does not accept cancellation as a forged binary operation;
only its authenticated disable/lifecycle messages request it.

SRD1 packet flag **32** is a response, at most 4104 bytes, with timestamp 0. Its
payload is operation byte, status byte, uint32 request ID, uint16 text length,
then UTF-8. Only a successful read may include text. Native status values are
0 success, 1 unavailable, 2 too large, 3 copied but paste failed, 4 blocked.
The broker can return status 5 busy/rate limit or 6 timeout. These responses are
not video/audio, never consume media ACK slots and never enter RTC encoders.
Native writes share the existing socket serialization mutex; metadata does not
advance media-watchdog submission clocks.

The broker translates client IDs to monotonically distinct native IDs across
viewer replacement. A delayed old-page reply cannot match a new page reusing
client ID 1. One request may be outstanding, at most four requests per second;
the broker expires it after 8 seconds and never replays it. Pause, suspension,
Stop, capture replacement and viewer changes cancel the pending request and
receiver opt-in. The receiver has its own 10-second fallback. These are queue,
request and buffer bounds; an unresponsive OS clipboard provider may still
block a native OS call. Physical failure/recovery behavior remains a gate.

## Native boundaries and qualification

Mac operations run on the main capture loop with a single pending slot,
keyboard-state serialization and checks for explicit enablement, full-desktop
capture, active geometry, Accessibility and non-paused/non-ended state.
NSPasteboard is accessed only during the requested operation. Paste prebuilds
balanced Command-V events and declines while another key/modifier is held.

Windows uses an explicitly created hidden message-only clipboard-owner window,
strict CF_UNICODETEXT/UTF-8 conversion and bounded reads. System memory ownership
transfers only after successful SetClipboardData. Clipboard work shares input
state serialization and requires the explicit socket/keyboard/clipboard flags
and a ready, unpaused, non-ended stream. Paste uses the existing keyboard
planner/accepted-event cleanup and declines held keys/modifiers. No elevation,
permission grant, clipboard watcher or automatic retry is added.

Automated checks use fake native and browser clipboard sinks. Cocoa adapter
checks use an in-memory Objective-C stand-in; they never open the general
pasteboard. Do not treat these as physical Mac/Windows clipboard/shortcut,
Safari/iOS browser permissions, secure-app, provider-hang or device qualification.
The installed service is not upgraded by building this candidate.

API references: [Windows OpenClipboard](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-openclipboard),
[SetClipboardData ownership](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setclipboarddata),
[Apple NSPasteboard](https://developer.apple.com/documentation/appkit/nspasteboard).

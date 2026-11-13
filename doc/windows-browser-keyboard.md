# Windows browser keyboard candidate

A matching Windows host now accepts the existing browser keyboard-v1 messages
on an explicitly enabled full-desktop reverse socket. The receiver's Keyboard
panel sends committed Unicode text; physical shortcuts and the arrow pad send
HID keyboard-page usages. No Android/SRD1 packet format changed. Native Android
sessions do not opt in. The running Mac service was not updated or restarted.

The controller advertises Windows typing only when native help includes both
`--reverse-keyboard` and the new `browser-keyboard-v1` capability marker. Older
Windows builds already listed the Mac-only option in help, so that option alone
is insufficient. Mac capability detection retains its existing backend gate;
Mac-only window capture and editable-focus reporting remain unavailable on Windows.

The Windows adapter converts physical usages to PC set-1 scan events, retaining
extended navigation, keypad and left/right modifier distinctions. Special
function/Pause/Print Screen/Num Lock events use their Windows virtual-key forms. Text is
validated bounded canonical UTF-8 (512 bytes), converted to UTF-16, and sent as
balanced Unicode down/up pairs, including surrogate pairs. Power/eject actions
are not inferred from arbitrary keyboard usages. Unusual OEM/keypad layouts and
applications that do not accept Unicode packet input need physical qualification.
Receiver IME preedit stays local; this is committed text, not remote IME-state sync.
Num Lock explicitly uses VK_NUMLOCK plus scan45 and the extended flag; Pause
uses VK_PAUSE. This avoids conflating their scan-only representations, following
[Microsoft's keyboard input table and Num Lock example](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-keybd_event).

Only accepted remote DOWN events enter the cleanup ledger. Release runs on
pause, Stop, receiver end, geometry change and teardown, serialized with existing
touch state. Failed releases remain pending for bounded-rate retry. A modifier
already down on the host is borrowed without generating its DOWN/UP; unexpected
external modifiers block new text/keystrokes rather than resetting host keys.
Only the eight modifier states are queried, never typed keys or clipboard text.
Concurrent physical changes after remote injection still require device tests.
Legacy native system-action chords remain a separate implementation.

An injection failure latches new keyboard input off; accepted text is never
replayed. The receiver clears/closes its local typing context and asks the user
to check the computer's text. Deliberately reopening Keyboard sends the existing
release-all message as an ordered fresh-input barrier. Input resumes only after
retained releases succeed. Some text may already have arrived before a partial
failure; there is no automatic edit/rollback of the remote app's contents.

Fixed ready/blocked/unsupported stdout markers are consumed separately from logs
and relayed only to the matching authenticated capable viewer. The host advertises
optional status support; the new receiver explicitly subscribes with
`keyboard-status-subscribe`. Every attach/replacement resets that subscription.
Older cached viewers receive no unknown status message, and older hosts receive
no new subscription. Hints do not grant input rights or bypass view-only policy.

[SendInput is restricted by Windows integrity policy](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput).
Failure does not identify UIPI specifically. No elevation, account, secure-desktop
or security-setting change is attempted. Return to an ordinary interactive app
and retry explicitly. Pre-login/service-session/secure-attention control is not
provided. [Unicode and scan flags follow KEYBDINPUT](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-keybdinput).

## Qualification gates

Automated tests use a pure event sink, not real SendInput: canonical text and
surrogates, maximum length, scan/extended flags, left/right and external modifiers,
repeat/up pairing, partial Unicode acceptance, retained cleanup and fresh barriers.
On Windows they also inspect real INPUT structures and compare representative
base scan mappings and reverse translation of full extended codes with
MapVirtualKeyEx when a US layout is already loaded; tests do not install layouts
or post keys. This checks that navigation keys do not become keypad keys, even
when forward mapping returns only a base code. Broker/service/receiver fixtures cover
negotiation, auth/view-only gates, fragmented private IPC, cached clients,
reconnect reset and local preview cleanup. Chromium layouts use a fake editor.

Real Windows qualification remains required: ordinary native and browser text
fields, receiver and host layouts, Ctrl/Alt/Shift/Win shortcuts, CJK/accent/emoji
commits, repeats and extended keys; pause/Home/Stop/network loss with held keys;
blocked-app failure/retry and concurrent host modifiers. Physical capture/audio,
packaged permission/startup/install/upgrade, clipboard sharing and the full roadmap
remain separate gates. No Windows hardware or universal browser support is claimed.

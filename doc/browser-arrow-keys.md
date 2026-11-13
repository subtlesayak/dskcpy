# Browser arrow keys

On a host that advertises browser keyboard support, open the four-way arrow
icon next to Keyboard in the right-hand rail. The pad sends Up, Left, Down and
Right without opening the phone's soft keyboard. Each tap sends a complete key
press/release pair; holding a touch button does not repeat. Physical arrows
also work while the pad has focus. Escape or Close returns focus to its rail
button. Physical arrows in the existing typing field remain supported.

Arrow controls are unavailable without authenticated keyboard capability, in
view-only mode, while paused/hidden, when touch control is off, or after a
connection loss. Direction labels retain their physical meaning in RTL layouts.

This change needs only the existing receiver's HTML, CSS and JavaScript. Its
keyboard command format and native host are unchanged. Publishing those assets
does not restart the service or change the already-loaded phone page. The new
script tolerates an older document during a rolling asset update.

Refresh is not a zero-interruption live patch: it replaces the browser's
WebSocket and renegotiates media. The current receiver can reuse its HttpOnly
resume cookie and existing capture session if the same browser returns within
the allowed resume window and total session lifetime. No new invitation is
needed in that case. Do not press Disconnect or Stop to perform this refresh.
A stopped/expired host session or lost browser credentials still needs pairing.

Automated validation covers exact direction bytes and balanced releases,
modifier cleanup, keyboard policy, pause/background/touch-off/disconnect gates,
focus restoration and typing-panel exclusivity. Hidden Chromium checks use a
fake native host, exercise narrow/landscape/RTL/200% layouts, serve real mixed
old/new files, and reload without a new invitation or native restart. Those
checks do not establish uninterrupted real-device audio/video or physical Mac
key handling. The actual phone refresh remains under the user's control.

The typing field retains a recent local preview while focused. Ordinary edits,
selection replacement, Backspace/Delete, pasted text and composition send only
new changes, rather than resending the visible history. The preview is not a
readback of the Mac field: clicking elsewhere, navigating to another context or
closing/pausing the panel clears it locally without deleting host text. Long
continuous typing keeps a bounded recent tail so the field's length limit does
not stop input. Nothing is stored in browser storage or read from the clipboard.
Transient IME focus loss releases held keys while preserving the current word
for suggestion replacement. Clicking or focusing elsewhere still clears it.
Cursor edits assume an ordinary text editor; application-specific editing and
real phone IME behavior still require physical qualification.

The default recovery window is now five minutes on both host and receiver.
Activating a changed host timeout requires restarting the controller; a browser
refresh alone cannot change the timeout already held by an active host process.
Do not restart an active remote user's host without their agreement. Invitation
expiry, the twelve-hour session lifetime and immediate Stop/Disconnect revocation
remain unchanged.

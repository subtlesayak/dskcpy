# Configurable browser shortcuts

Select **Shortcuts** in the receiver rail. Each of the six buttons sends one
key press and matching release to the computer's active window. The initial
buttons are Tab, Enter, Escape, Backspace, Home and End. A button's text names
its actual key combination rather than a promised application action.

Open **Customize shortcuts**, choose a button, a key and optional Ctrl, Shift,
Alt or Meta modifiers, then select **Apply shortcut**. Applying or resetting
changes only the button, without sending keys. Meta means Command on Mac and
Windows on Windows; Alt means Option on Mac. App bindings and system handling
can differ, so a transmitted chord is not proof that an app performed an action.
The choices include mapped navigation, letter, number, symbol, function and keypad keys. Only codes mapped by both existing Mac and Windows native hosts are offered; pure modifiers use the modifier checkboxes.
The palette adds no script, recorded macro, text-snippet or held-modifier mode.

The six validated bindings are saved locally under `dskcpy.shortcuts.v1`.
The record contains only a schema version and six key-code/modifier pairs,
not text, invitation codes, session credentials, devices or clipboard data.
Invalid, oversized or unsupported saved records fall back atomically to defaults.
If browser storage is unavailable, settings work for the current page and the
status explains their shorter lifetime. Reset shortcuts restores the defaults.
No shortcut executes automatically on load, reconnect, reset or configuration.

Shortcut sending requires the existing authenticated full-desktop keyboard
capability, available input permission, Touch on, an active visible connection,
unpaused input and the open Shortcuts panel. View-only sessions hide the palette.
Existing held input and pending movement are released before sending; each tap
uses the existing key-down/key-up packets with modifiers cleared on release.
A failed release attempts the existing release-all packet, without queuing or
replaying keys. Transport/native lifecycle cleanup remains necessary if the
connection itself is gone. A successful transport send is not host acknowledgment.

The keyboard preview closes when the palette opens, so later typing starts a
fresh local fragment. Text-focus hints do not steal focus from shortcut editing.
Copy/paste chords, if explicitly configured and selected, use the host clipboard
through ordinary host keyboard behavior; this feature never reads the browser
clipboard or transfers clipboard text. Explicit clipboard tools retain their own
consent and limits.

A new controller must serve shortcuts.mjs alongside the updated receiver.
No active receiver is updated by these source changes. Actual Mac/Windows
application behavior, modifier ownership, phone keyboards, Safari, permissions,
reconnect and physical held-input cleanup require controlled qualification.
Headless Chromium and fake native collectors prove local form, storage, gating
and packet behavior only.

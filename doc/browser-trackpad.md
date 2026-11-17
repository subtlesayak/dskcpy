# Browser trackpad candidate

Select **Trackpad mode** in the receiver's right-hand rail. Direct touch remains
the default. Slide one finger over the desktop to move the pointer relative to
its previous position; lift and reposition the finger to continue moving.
A short tap clicks at the ring, rather than jumping to the contact location.
Two fingers scroll; lifting one after a scroll never starts a click or drag.

**Start drag** holds the current target. Move with one finger, lifting and
repositioning as needed, then select **Release drag**. Two fingers, Escape,
Pause, touch-off, a control-panel change, geometry change, blur, backgrounding,
capture/session loss and Disconnect cancel the hold. A lost pointer capture
while a finger is active cancels it; ordinary capture release after finger-up
does not end a deliberate hold. Native/controller cleanup remains authoritative
if the connection is already gone.

The focusable desktop also supports physical Arrow keys (Shift for a larger
step), Enter/Space to click, and Page Up/Down to scroll. These keys control the
pointer only while the trackpad itself has focus; they do not replace the
receiver's separate remote arrow-key pad or typing panel. Repeated Enter/Space
events do not create repeated clicks. The ordinary Keyboard button and optional
automatic text-focus keyboard still work.

The ring is a local **next click position**, not host pointer feedback. A mouse
moved by somebody at the computer is not synchronized back to this ring. This
is screen-relative cursor control, not raw relative/locked input for games.
Pointer position and mode live only in memory; Disconnect clears them. View-only,
paused, hidden and touch-disabled receivers cannot send trackpad input.

## Existing transport and native behavior

No Android, native source, packet layout or input authorization changes are made.
The existing type-7 position-and-scroll packet, with zero deltas, positions the
desktop mouse without a contact. Both native hosts already map that packet to
their mouse-position routine. Nonzero deltas keep the existing bounded scroll
path. Clicks and explicit drags use the existing balanced touch/down/move/cancel
path, including Windows' existing touch-to-desktop input behavior. This is not
new raw mouse-button support or a claim of identical app behavior on both OSes.
Move/hover output keeps only the newest position per 16ms scheduling interval;
click/scroll boundaries flush it and cancellation discards it. No media queue,
native capture, codec or session lifetime is changed.

Trackpad mode is part of the existing receiver. The touch-scroll changes below
remain a separate source candidate. Update an active receiver only with the
user's agreement.

## Touch scroll speed

Open **Options → Touch and scrolling → Touch scroll speed**. The new control
defaults to 2× and ranges from 0.5× to 3× in quarter steps. It changes the distance
produced by finger gestures in direct-touch and trackpad modes. Pointer movement,
mouse-wheel events and keyboard scrolling retain their existing behavior.
Adjustments apply without a capture restart. Only an explicit numeric choice is
saved in the receiver origin's local storage; malformed or unavailable storage
uses the default. Older documents without the control retain the 1× baseline.

Two-finger centroids often move by fractions of a CSS pixel. Previously, rounding
each event separately could discard an entire slow swipe. A deterministic
receiver regression reproduced 0 delivered pixels for a −2px movement and 10px
instead of 12px for a direct swipe. The shared touch-scroll normalizer now retains
fractional movement within the gesture before producing integer scroll packets.
It keeps the existing per-packet bounds and discards residue when the gesture,
input epoch or speed changes. It adds no post-gesture scroll queue, native input
action or wire-layout change.

## Layout and verification

The canvas fit uses the stage's CSS dimensions, rather than its zoom-scaled
bounding rectangle. Visual viewport height/top account for CSS page zoom,
without counteracting browser pinch zoom. The local ring is mapped into the
stage's CSS coordinate space. This fixes the clipped helper and distorted video
observed in the initial synthetic 200% CSS-zoom check.

`gui/server/trackpad.test.mjs` exercises the pure gesture state. The actual
receiver VM fixtures cover packet validation, clutched drag, bounded motion,
pause/touch/view-only guards and queued-motion cleanup on connection loss.
`desktop/test/trackpad-ui.mjs` uses actual Chromium touch input, pointer capture,
keyboard focus and fullscreen, an owned broker and a fake native collector.
It checks portrait, landscape, 320px RTL and 200% CSS zoom, tap position,
two-finger scroll, drag release, resize cancellation, aspect ratio and marker
placement. It also checks fractional scrolling in both directions, the live
range control's keyboard behavior in LTR/RTL, local preference saving and that
range keys are not forwarded as remote keys. No actual desktop input/capture,
clipboard, OS permission or phone
is accessed. The fake native collector does not qualify Windows/Mac injection,
software keyboards, real browser UI zoom, Safari, screen readers or hardware.

Physical USB/LAN/private-network tests, native app-specific drag behavior and
the complete device/OS matrix remain required for the scroll changes. Zoom/pan
and configurable shortcuts are implemented separately and retain their physical
qualification gates. Raw relative/locked input remains later work.

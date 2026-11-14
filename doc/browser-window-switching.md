# Approved window switching (Mac source candidate)

In the dashboard, refresh the capture-target list, choose an initial window and
turn on **Allow receiver to switch windows**. Select two to eight windows, then
create the invitation. The selected window names appear in the receiver; no
other window names are sent. The initial window stays in the selection.

The receiver's **Choose a window** button lists only this ephemeral selection.
Switching briefly reconnects video using the same browser authorization and its
original lifetime. It starts another capture only after the exact old native
process closes and its final capture-end reason is drained. Stop, permission
loss, explicit OS Stop, failed startup and an eight-second retirement timeout
end sharing instead of starting a replacement. Attempts are at least two seconds
apart. Native window ID and owning process ID remain private to the controller;
the viewer sends only a fresh opaque key from the approved selection.

Previews are labeled **Last viewed**. They use only frames that this receiver
has already displayed, captured locally when selecting another window. They are
not live previews of other windows. At most eight 160×100 canvases are retained
in page memory, never local storage, logs, URLs or a server preview API. A new
grant or Disconnect clears the previews. Reload clears them as well. The first
visit says **Preview after viewing**.

An authenticated switching acknowledgment allows browsers that omit WebSocket
close metadata to resume this same session. A failed or expired window session
never silently requests remembered full-desktop access. Older cached receivers
receive no new window-state messages unless they explicitly subscribe.

This candidate remains **view-only with audio off**. Interactive target-relative
input and app-specific audio are separate open requirements. Matching a window's
process, title or bounds does not prove exact accessibility/input ownership,
particularly after focus, occlusion, replacement or movement. This implementation
does not enable those inputs or claim that requirement is complete. Closing,
minimizing or hiding the captured window ends sharing; it does not automatically
switch to another window or to the desktop.

Automated generated-video tests exercise real browser decoding and fake native
control effects. They do not qualify physical Mac window capture, phone/Safari
behavior, permissions, latency or app-specific audio. The installed host is not
updated by source changes. Apply it only at an agreed interruption window.

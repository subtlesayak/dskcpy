# Remembered browser video setting

The receiver remembers an explicit change to **Options → Adjust video
automatically** in this browser for the current receiver origin (scheme,
address and port). It stores only `{version:1,automatic:true|false}`. It never
stores a measured quality level, encoder limits, connection code, access grant,
typed text or clipboard data. Different addresses or ports have separate choices;
USB and VPN addresses need not share a preference. Other already-open tabs are
not changed. Disconnect removes access as before, retaining this display choice.

Until you choose, the host's existing default applies. A new authenticated
session may restore the choice only when the owner enables native adaptation,
the host advertises it, and native video settings/header are ready. Resume is
sent first, because suspended sessions intentionally ignore quality controls.
Old hosts, view-only, unavailable adaptation, pause, background and disconnected
states cannot use a saved choice to gain access or bypass owner limits. Manual
restoration uses the existing fixed original-level command, never arbitrary
bitrate/FPS values. It does not request keyboard input, unmute audio or restart
capture. The displayed quality remains the host's reported state.

Only explicit valid changes are saved; malformed, oversized or future-version
records leave the host default. If browser storage is denied or full, the
explicit choice works for this page visit and the receiver says to choose it
again next time. New pages cannot remember it in that case. No automatic command
retry loop or cross-tab preference listener is installed.

Automated qualification uses the actual receiver, an authenticated owned local
broker and an in-memory native collector. It checks fresh-session restoration,
reload without duplicate native adjustment, resume ordering, pause/authentication
gates, old-host/view-only boundaries, storage denial, keyboard operation and
narrow/RTL/200% CSS-zoom layouts. Generated media regressions are separate from
these control/UI checks. Neither qualifies physical phone keyboards, Safari/iOS
hardware, real encoders, audible playback or input latency. Deployment still
requires a controlled update; an active installed session is left untouched.

The expanded WebKit CSS-zoom flow exposed a synchronous ResizeObserver delivery
loop. Stage notifications now coalesce into the next animation frame; fitting
reads the latest geometry outside observer delivery. The tests require settled
geometry, no repeated resize loop and preserved paired keyboard input. The
initial candidate failure remains recorded separately from the corrected source.
Visual review also caught fragmented labels at 200% CSS zoom despite passing
bounding-box checks. Receiver container queries now use the available layout
width instead of the outer viewport breakpoint. Options retain a sticky close
control, matching scroll clearance and a visible overflow cue. A compact header
in short containers leaves room for the clipboard field above a soft keyboard.
The container's width and height are both explicit. Real-browser
checks additionally require whole-word label wrapping and reachable focus under
the heading with long German labels and RTL; CSS zoom is not physical browser
zoom or phone qualification.
Chromium checks actual Shift+Tab order. This WebKit test engine skips checkboxes
under its default Tab policy, so it checks explicit focus scrolling and Space
activation without changing OS settings. Physical Safari keyboard-navigation
policy remains a separate qualification gate.

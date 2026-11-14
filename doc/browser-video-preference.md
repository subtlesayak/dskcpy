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

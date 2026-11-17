# Audio from a selected application

On a capable Mac host, the local window picker offers **Allow audio from the
selected window’s app**. It starts off, resets when the capture target changes
and is fixed for the temporary invitation. The receiver starts muted and can
enable **App audio** separately. Older hosts do not offer this setting.

Audio includes the selected window’s entire application, including other windows
and tabs from that app. It is not isolated to the one visible window. This is
the scope Apple documents for a ScreenCaptureKit independent-window filter:
[Take ScreenCaptureKit to the next level](https://developer.apple.com/videos/play/wwdc2022/10155/).
If the host also approves window switching, audio follows the application of
the selected approved window. Other applications and microphone audio are not
added. Sharing the host’s own process audio remains excluded.

Window mode remains view-only: this opt-in does not allow pointer, keyboard,
clipboard, computer volume or window-management commands. The native option
`--reverse-window-audio` requires a reverse socket, a selected window and its
revalidated owner, and audio enabled. Unsupported platforms reject it. Runtime
help must advertise `window-app-audio-v1`; older native binaries cannot silently
accept the feature. Remembered full-desktop grants cannot become app-audio
invitations.

Audio failure retains the same selected-window filter. The only fallback is
video with audio unavailable; it never broadens to system audio or full-desktop
capture. Mute, pause, source retirement and shutdown invalidate queued/encoding
audio. A blocked old-epoch send is rechecked under the actual send lock before
admission or bytes. Explicit mute intent survives an approved source switch.

## Verification and remaining gates

The native fixture includes the production translation unit with Accessibility,
event posting and socket effects intercepted. It exercises absent/explicit
consent, duplicate enable/Resume, mute/pause queue cleanup, ended-session guards,
blocked stale encoder output and fresh output. No real capture or OS input is
performed. All 31 normal, 31 ASan/UBSan and 31 pinned-static native tests pass on
the integrated ARM source. The development dynamic libraries target a newer OS;
those tests do not qualify the minimum deployment OS. The pinned build is a
separate check, not a clean-OS physical result.

The integrated Node suite passes 473 of 480 tests with seven optional skips.
Both UI builds pass. Five host-picker flows cover explicit consent, reset on
target change, fixed active consent, unsupported capability, eight-window
bounds, narrow width, RTL and 200% CSS zoom against a synthetic API.

`desktop/test/window-audio-ui.mjs` runs generated 440/880 Hz Opus and H.264 through
the actual broker and receiver: two Chromium paths (WebCodecs and WebRTC) and one
WebKit path. It verifies the decoded source change, old audio retirement, mute
intent, at most one fake native session and denied window input. Playback is
muted throughout; this does not qualify audible playback or the Apple API.
The media CI job runs these flows and preserves generated results.

Physical application isolation, audible playback, mute, pause/Home/return,
approved switching, output-route changes and longer sessions remain required
on an identified signed artifact. Windows application-audio and target-relative
window control remain separate unsupported work. No live app, grants or receiver
assets are changed by these source tests. The landscape typing test candidate
remains a separate artifact awaiting its own signing/test-switch approval.

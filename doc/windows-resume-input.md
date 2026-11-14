# Windows resume and keyframe input safety

The Windows native receiver now distinguishes a real video lifecycle transition
from an IDR request sent while video is already active. Repeated active Resume
requests keep held mouse/keyboard state, audio enable state and existing video
and audio watchdog deadlines. Each request still sets the bounded native
force-refresh flag; it does not queue frames or restart capture.

An actual pause/resume transition uses the native transition callback to update
video state and watchdogs and release owned input. Repeated Pause keeps media and
watchdog state unchanged while permitting retry of a failed owned-input release.
Resume publishes the active-video flag only after its cleanup attempt. Existing
native ownership/blocking rules still apply if the OS refuses a release.
Muted audio remains muted on resume. Stop retains its normal owned-input cleanup,
and requests received after Stop cannot resume capture. Other system actions and
the authenticated browser input validator keep their existing behavior.

Before this correction, `reverse_receiver_on_system_action` canceled keyboard
state before dispatching every action other than audio enable/disable. Therefore
an active Resume/IDR request could release a user's held modifier while a decoder
was merely requesting a keyframe. The production callback-body regression fails
on that path before the fix. It compiles the actual callback and transition bodies
against fake effects and the real watchdog helper, without Windows APIs, capture
or OS input. It checks 10,000 duplicate resumes, held input, preserved deadlines,
true pause/resume, muted resume, Stop and ignored unsupported quality actions.
A native Meson fixture separately exercises the lifecycle helper on all native
build platforms. The callback compilation test skips only if no standalone C
compiler is available; a skip is not physical Windows input qualification.

Mac pause behavior is unchanged. Quality actions 12–14 are ignored without
releasing input unless the separate experimental Windows adaptation option is
active and unpaused. See [Windows adaptation](windows-adaptive-video.md) for
candidate preparation and remaining hardware gates. No installed host is updated
by tests or builds.

## Windows adaptive-video work still required

The inspected FFmpeg NVENC implementation gates dynamic bitrate changes on a
private capability and rate-control mode. Its reconfiguration function returns
no result to the caller and logs driver rejection. Writing public context bitrate
fields or accepting a frame therefore cannot by itself confirm a live bitrate
change. See the [FFmpeg 8.1.2 source](https://github.com/FFmpeg/FFmpeg/blob/n8.1.2/libavcodec/nvenc.c).
No dependency internals or global logging callbacks are used to infer success.

The experimental candidate uses same-codec replacement through public APIs:
drain the old media window, retain its working encoder, open the requested target
and validate a fresh keyframe before publication. Software-only regressions cover
preparation failures, cancellation and publication; actual Windows driver/network
performance and safe physical deployment remain unqualified. This is not a claim
that a public API confirms live reconfiguration of an existing NVENC context.

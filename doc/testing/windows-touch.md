# Windows touch recovery checks

The original recovery implementation addresses the timeout reported in
[PR #9](https://github.com/subtlesayak/dskcpy/pull/9). It does not import the
contributor's recovery code. The portable state machine is used by the Windows
host; native API results and desktop mapping remain in `reverse_display.c`.

## Automated verification

Use a debug build so assertions execute:

```sh
meson setup build-touch --buildtype=debug -Dcompile_server=false
meson compile -C build-touch
meson test -C build-touch --print-errorlogs
```

`test_reverse_touch` uses an independent virtual OS contact ledger. It covers
identical-frame retries for press/move/release/cancel/keepalive; bounded retry
exhaustion; long holds; timeout/invalid/unknown failures; last accepted release
positions; failed cancellation; no replay after final UP; fresh-gesture
recovery; unavailable-API and primary-finger mouse fallback; repeated cleanup;
contact limits and 2,000 recovery workloads. It performs no physical injection.
The same suite runs in Windows and Mac native CI, with sanitizers on Mac.

## Physical verification (pending)

Arrange any stream interruption with the user. Use a harmless multitouch test
window, not a live game or an unsaved document. Record the exact host commit,
executable hash, companion/browser revision and transport separately.

1. Test two simultaneous contacts, long stationary holds, fast moves and final
   releases. Confirm every finger releases, including the primary finger first.
2. If a native injection error occurs, lift all fingers and begin a new gesture.
   Confirm multitouch resumes without restarting the stream or synthesizing a
   click. Recovery deliberately does not recreate a gesture already in progress.
3. Hold contacts while testing each of pause/return, phone Stop, receiver
   disconnect, network loss and host Stop. Confirm no held contact or mouse
   button remains, and no keepalive restarts the old gesture.
4. Change the selected display's bounds/origin. Confirm the gesture is cancelled
   and fresh input maps to the updated desktop. Test display removal separately.
5. When native injection is unavailable, verify primary-finger mouse dragging,
   release, scrolling and Stop. Restoring permissions is a separate user action.

Windows timing errors (`ERROR_NOT_READY`) require retrying the same frame.
Timeouts are not treated as proof that contacts were released; unsuccessful
cleanup retains the contact ledger and blocks a new gesture. A valid cancelled
UP frame that returns `ERROR_INVALID_PARAMETER` invalidates the native sequence.
No call to `InitializeTouchInjection` is used as an assumed contact reset.
These choices follow the
[Windows input API contract](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-injecttouchinput).

Builds and simulated tests do not establish physical touch latency, nor do
decode acknowledgements measure touch-to-display latency. Do not publish
private identifiers, addresses, event logs or unredacted screenshots.

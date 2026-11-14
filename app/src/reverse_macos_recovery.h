#ifndef SC_REVERSE_MACOS_RECOVERY_H
#define SC_REVERSE_MACOS_RECOVERY_H
#include <stdbool.h>
#include <stddef.h>
enum sc_macos_capture_change { SC_MACOS_CAPTURE_UNCHANGED, SC_MACOS_DISPLAY_CHANGED, SC_MACOS_SLEEP };
// Fixed internal IPC only. Never treat user Stop or revoked permission as a
// recoverable disconnect, even if geometry also changed during shutdown.
static inline const char *sc_macos_capture_recovery_reason(enum sc_macos_capture_change change,
        bool disconnected, bool failed, bool quit, bool permitted) {
    if (!disconnected || failed || quit || !permitted) return NULL;
    return change == SC_MACOS_DISPLAY_CHANGED ? "display-change" : change == SC_MACOS_SLEEP ? "sleep" : NULL;
}
#endif

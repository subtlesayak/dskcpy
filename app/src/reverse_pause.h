#ifndef SC_REVERSE_PAUSE_H
#define SC_REVERSE_PAUSE_H
#include <stdbool.h>

struct sc_reverse_pause_callbacks {
    void (*transition)(void *context, bool paused);
    void (*keyframe)(void *context);
};
// A resume of already-active video is also an IDR request. Only an actual
// pause/resume transition may alter lifecycle watchdogs. The caller can retry
// failed owned-input cleanup separately while paused, without another transition.
static inline void
sc_reverse_pause(bool current, bool requested,
                 const struct sc_reverse_pause_callbacks *callbacks,
                 void *context) {
    if (current != requested) callbacks->transition(context, requested);
    if (!requested) callbacks->keyframe(context);
}
#endif

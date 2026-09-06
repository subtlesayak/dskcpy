#ifndef SC_REVERSE_WATCHDOG_H
#define SC_REVERSE_WATCHDOG_H

#include <stdbool.h>
#include <stdint.h>

// All access must be serialized by the caller. Times are monotonic microseconds.
#define SC_REVERSE_STALL_TIMEOUT_US INT64_C(10000000)

struct sc_reverse_watchdog {
    int64_t deadline;
    int64_t submitted_pts;
    int64_t acked_pts;
    bool busy;
    bool paused;
};

static inline void
sc_reverse_watchdog_init(struct sc_reverse_watchdog *watchdog) {
    *watchdog = (struct sc_reverse_watchdog) {
        .submitted_pts = -1,
        .acked_pts = -1,
    };
}

static inline void
sc_reverse_watchdog_begin(struct sc_reverse_watchdog *watchdog, int64_t now) {
    watchdog->busy = true;
    if (!watchdog->deadline) {
        watchdog->deadline = now + SC_REVERSE_STALL_TIMEOUT_US;
    }
}

static inline void
sc_reverse_watchdog_submit(struct sc_reverse_watchdog *watchdog, int64_t pts) {
    if (pts > watchdog->submitted_pts) {
        watchdog->submitted_pts = pts;
    }
}

static inline bool
sc_reverse_watchdog_ack(struct sc_reverse_watchdog *watchdog, int64_t pts,
                        int64_t now) {
    // Future/duplicate ACKs must not disable the stall watchdog or flow control.
    if (pts <= watchdog->acked_pts || pts > watchdog->submitted_pts) {
        return false;
    }
    watchdog->acked_pts = pts;
    watchdog->deadline = watchdog->busy || pts < watchdog->submitted_pts
                       ? now + SC_REVERSE_STALL_TIMEOUT_US : 0;
    return true;
}

static inline void
sc_reverse_watchdog_end(struct sc_reverse_watchdog *watchdog) {
    watchdog->busy = false;
    if (watchdog->acked_pts >= watchdog->submitted_pts) {
        watchdog->deadline = 0;
    }
}

static inline bool
sc_reverse_watchdog_expired(const struct sc_reverse_watchdog *watchdog,
                            int64_t now) {
    return !watchdog->paused && watchdog->deadline && now >= watchdog->deadline;
}

static inline void
sc_reverse_watchdog_set_paused(struct sc_reverse_watchdog *watchdog,
                               bool paused, int64_t now) {
    if (watchdog->paused == paused) {
        return; // Repeated resume commands must not extend a genuine stall.
    }
    watchdog->paused = paused;
    if (!paused) {
        watchdog->deadline = watchdog->busy
                          || watchdog->acked_pts < watchdog->submitted_pts
                           ? now + SC_REVERSE_STALL_TIMEOUT_US : 0;
    }
}

#endif

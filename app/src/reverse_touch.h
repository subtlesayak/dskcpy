#ifndef SC_REVERSE_TOUCH_H
#define SC_REVERSE_TOUCH_H

#include <stdbool.h>
#include <stdint.h>

#define SC_REVERSE_TOUCH_LIMIT 10
#define SC_REVERSE_TOUCH_NONE UINT64_MAX
#define SC_REVERSE_TOUCH_KEEPALIVE_US INT64_C(80000)

enum sc_reverse_touch_action {
    SC_TOUCH_DOWN, SC_TOUCH_ADD, SC_TOUCH_MOVE, SC_TOUCH_UP, SC_TOUCH_CANCEL,
};

enum sc_reverse_touch_phase {
    SC_TOUCH_PRESS, SC_TOUCH_UPDATE, SC_TOUCH_RELEASE, SC_TOUCH_ABORT,
};

enum sc_reverse_touch_result {
    SC_TOUCH_OK,
    SC_TOUCH_RETRY,       // Timing collision: retry the identical frame.
    SC_TOUCH_TIMEOUT,     // Delivery is uncertain; cancel before a new gesture.
    SC_TOUCH_INVALID,     // Invalid native sequence/frame.
    SC_TOUCH_UNAVAILABLE, // Native injection is unsupported or denied.
    SC_TOUCH_FAILED,
};

struct sc_reverse_touch_point {
    uint64_t pointer_id;
    int32_t x, y;
    uint32_t pressure;
};

struct sc_reverse_touch_frame {
    struct sc_reverse_touch_point point;
    enum sc_reverse_touch_phase phase;
};

struct sc_reverse_touch_callbacks {
    enum sc_reverse_touch_result (*inject)(
        void *userdata, const struct sc_reverse_touch_frame *frame, unsigned count);
    void (*retry_wait)(void *userdata);
    bool (*mouse)(void *userdata, const struct sc_reverse_touch_point *point,
                  enum sc_reverse_touch_phase phase);
};

// All calls (including keepalive/cancel) must be serialized by the owner.
// Contacts record accepted positions, so UP/cancellation cannot move a finger.
struct sc_reverse_touch {
    struct sc_reverse_touch_point contacts[SC_REVERSE_TOUCH_LIMIT];
    unsigned count;
    uint64_t primary;
    bool mouse_only;
    bool mouse_down;
    struct sc_reverse_touch_point mouse_point;
    bool needs_down;
    int64_t last_success_us;
    const struct sc_reverse_touch_callbacks *callbacks;
    void *userdata;
};

void
sc_reverse_touch_init(struct sc_reverse_touch *touch, bool mouse_only,
                      const struct sc_reverse_touch_callbacks *callbacks,
                      void *userdata);

bool
sc_reverse_touch_event(struct sc_reverse_touch *touch,
                       enum sc_reverse_touch_action action,
                       struct sc_reverse_touch_point point, int64_t now);

// Failed cancellation retains the ledger for a later cleanup attempt. New
// gestures cannot start until cleanup succeeds (or the OS invalidates it).
bool
sc_reverse_touch_cancel(struct sc_reverse_touch *touch);

void
sc_reverse_touch_tick(struct sc_reverse_touch *touch, int64_t now);

#endif

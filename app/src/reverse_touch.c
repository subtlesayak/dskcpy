#include "reverse_touch.h"

#include <assert.h>
#include <string.h>

static unsigned
find_contact(const struct sc_reverse_touch *touch, uint64_t id) {
    for (unsigned i = 0; i < touch->count; ++i) {
        if (touch->contacts[i].pointer_id == id) {
            return i;
        }
    }
    return SC_REVERSE_TOUCH_LIMIT;
}

static enum sc_reverse_touch_result
send_frame(struct sc_reverse_touch *touch,
           const struct sc_reverse_touch_frame *frame, unsigned count) {
    assert(count && count <= SC_REVERSE_TOUCH_LIMIT);
    // Four calls, at most three waits. Never spin or hold the owner's input
    // lock indefinitely. The same immutable frame is used on every retry.
    for (unsigned attempt = 0; ; ++attempt) {
        enum sc_reverse_touch_result result =
            touch->callbacks->inject(touch->userdata, frame, count);
        if (result != SC_TOUCH_RETRY || attempt == 3) {
            return result;
        }
        touch->callbacks->retry_wait(touch->userdata);
    }
}

void
sc_reverse_touch_init(struct sc_reverse_touch *touch, bool mouse_only,
                      const struct sc_reverse_touch_callbacks *callbacks,
                      void *userdata) {
    *touch = (struct sc_reverse_touch) {
        .primary = SC_REVERSE_TOUCH_NONE,
        .mouse_only = mouse_only,
        .needs_down = true,
        .callbacks = callbacks,
        .userdata = userdata,
    };
}

bool
sc_reverse_touch_cancel(struct sc_reverse_touch *touch) {
    touch->needs_down = true;
    if (touch->mouse_down) {
        if (!touch->callbacks->mouse(touch->userdata, &touch->mouse_point,
                                      SC_TOUCH_RELEASE)) {
            return false;
        }
        touch->mouse_down = false;
    }
    if (!touch->mouse_only && touch->count) {
        struct sc_reverse_touch_frame frame[SC_REVERSE_TOUCH_LIMIT];
        for (unsigned i = 0; i < touch->count; ++i) {
            frame[i] = (struct sc_reverse_touch_frame) {
                .point = touch->contacts[i], .phase = SC_TOUCH_ABORT,
            };
        }
        enum sc_reverse_touch_result result =
            send_frame(touch, frame, touch->count);
        // A rejected UP frame invalidates the native contact sequence. Do not
        // replay DOWN or call InitializeTouchInjection as an assumed reset.
        if (result != SC_TOUCH_OK && result != SC_TOUCH_INVALID) {
            return false;
        }
    }
    touch->count = 0;
    touch->primary = SC_REVERSE_TOUCH_NONE;
    return true;
}

static void
failed_frame(struct sc_reverse_touch *touch,
             enum sc_reverse_touch_result result,
             const struct sc_reverse_touch_frame *frame, unsigned count) {
    // NOT_READY/UNAVAILABLE never accepted the frame. For uncertain failures
    // include a new DOWN in cleanup. Existing coordinates
    // remain the last accepted ones, not the rejected MOVE's coordinates.
    if (result != SC_TOUCH_RETRY && result != SC_TOUCH_UNAVAILABLE) {
        for (unsigned i = 0; i < count; ++i) {
            if (frame[i].phase == SC_TOUCH_PRESS
                    && find_contact(touch, frame[i].point.pointer_id)
                       == SC_REVERSE_TOUCH_LIMIT) {
                assert(touch->count < SC_REVERSE_TOUCH_LIMIT);
                touch->contacts[touch->count++] = frame[i].point;
            }
        }
    }
    bool cleared = sc_reverse_touch_cancel(touch);
    if (cleared && result == SC_TOUCH_UNAVAILABLE) {
        // Preserve fallback for an unavailable API, but never synthesize a
        // mouse press halfway through the failed native gesture.
        touch->mouse_only = true;
    }
}

bool
sc_reverse_touch_event(struct sc_reverse_touch *touch,
                       enum sc_reverse_touch_action action,
                       struct sc_reverse_touch_point point, int64_t now) {
    if (action == SC_TOUCH_CANCEL) {
        return sc_reverse_touch_cancel(touch);
    }
    if (point.pointer_id > UINT32_MAX) {
        return false;
    }
    if (action == SC_TOUCH_DOWN) {
        if (!sc_reverse_touch_cancel(touch)) {
            return false;
        }
        touch->needs_down = false;
        touch->primary = point.pointer_id;
    } else if (touch->needs_down) {
        return false;
    }

    unsigned index = find_contact(touch, point.pointer_id);
    bool add = action == SC_TOUCH_DOWN || action == SC_TOUCH_ADD;
    bool release = action == SC_TOUCH_UP;
    if (add) {
        if (index != SC_REVERSE_TOUCH_LIMIT
                || touch->count == SC_REVERSE_TOUCH_LIMIT) {
            return false;
        }
        index = touch->count;
    } else if (index == SC_REVERSE_TOUCH_LIMIT) {
        return false;
    }

    if (touch->mouse_only) {
        bool primary = point.pointer_id == touch->primary;
        if (primary) {
            enum sc_reverse_touch_phase phase = add ? SC_TOUCH_PRESS
                : release ? SC_TOUCH_RELEASE : SC_TOUCH_UPDATE;
            // Release at the last delivered position, as for native touch.
            if (release) {
                point = touch->mouse_point;
            }
            if (!touch->callbacks->mouse(touch->userdata, &point, phase)) {
                sc_reverse_touch_cancel(touch);
                return false;
            }
            touch->mouse_down = !release;
            touch->mouse_point = point;
        }
    } else {
        unsigned count = touch->count + add;
        struct sc_reverse_touch_frame frame[SC_REVERSE_TOUCH_LIMIT];
        for (unsigned i = 0; i < count; ++i) {
            frame[i].point = i == index && !release ? point : touch->contacts[i];
            frame[i].phase = i != index ? SC_TOUCH_UPDATE
                : add ? SC_TOUCH_PRESS
                : release ? SC_TOUCH_RELEASE : SC_TOUCH_UPDATE;
        }
        enum sc_reverse_touch_result result = send_frame(touch, frame, count);
        if (result != SC_TOUCH_OK) {
            failed_frame(touch, result, frame, count);
            return false;
        }
        touch->last_success_us = now;
    }

    if (release) {
        if (point.pointer_id == touch->primary) {
            touch->primary = SC_REVERSE_TOUCH_NONE;
        }
        --touch->count;
        memmove(&touch->contacts[index], &touch->contacts[index + 1],
                (touch->count - index) * sizeof(touch->contacts[0]));
        if (!touch->count) {
            touch->needs_down = true;
        }
    } else {
        touch->contacts[index] = point;
        touch->count += add;
    }
    return true;
}

void
sc_reverse_touch_tick(struct sc_reverse_touch *touch, int64_t now) {
    if (touch->needs_down) {
        if (touch->count || touch->mouse_down) {
            sc_reverse_touch_cancel(touch);
        }
        return;
    }
    if (touch->mouse_only || !touch->count
            || now < touch->last_success_us
            || now - touch->last_success_us < SC_REVERSE_TOUCH_KEEPALIVE_US) {
        return;
    }
    struct sc_reverse_touch_frame frame[SC_REVERSE_TOUCH_LIMIT];
    for (unsigned i = 0; i < touch->count; ++i) {
        frame[i] = (struct sc_reverse_touch_frame) {
            .point = touch->contacts[i], .phase = SC_TOUCH_UPDATE,
        };
    }
    enum sc_reverse_touch_result result = send_frame(touch, frame, touch->count);
    if (result == SC_TOUCH_OK) {
        touch->last_success_us = now;
    } else {
        failed_frame(touch, result, frame, touch->count);
    }
}

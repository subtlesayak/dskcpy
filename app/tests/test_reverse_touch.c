#include <assert.h>
#include <stdio.h>
#include <string.h>

#include "reverse_touch.h"

struct recorded_frame {
    unsigned count;
    struct sc_reverse_touch_frame points[SC_REVERSE_TOUCH_LIMIT];
};

struct fixture {
    struct sc_reverse_touch touch;
    struct recorded_frame log[256];
    unsigned calls, waits, mouse_calls;
    enum sc_reverse_touch_result errors[32];
    unsigned error_count, error_index;
    struct sc_reverse_touch_point active[SC_REVERSE_TOUCH_LIMIT];
    unsigned active_count;
    bool mouse_down, mouse_fail;
};

static unsigned
active_index(const struct fixture *f, uint64_t id) {
    for (unsigned i = 0; i < f->active_count; ++i) {
        if (f->active[i].pointer_id == id) {
            return i;
        }
    }
    return SC_REVERSE_TOUCH_LIMIT;
}

static enum sc_reverse_touch_result
inject(void *userdata, const struct sc_reverse_touch_frame *frame, unsigned count) {
    struct fixture *f = userdata;
    assert(count && count <= SC_REVERSE_TOUCH_LIMIT);
    assert(f->calls < 256);
    struct recorded_frame *record = &f->log[f->calls++];
    record->count = count;
    memcpy(record->points, frame, count * sizeof(*frame));
    if (f->error_index < f->error_count) {
        enum sc_reverse_touch_result result = f->errors[f->error_index++];
        if (result == SC_TOUCH_INVALID) {
            f->active_count = 0;
        }
        if (result != SC_TOUCH_OK) {
            return result;
        }
    }
    // An independent virtual OS ledger enforces accepted positions, complete
    // frames, no duplicate DOWN and no unknown UPDATE/UP. No real input runs.
    for (unsigned i = 0; i < count; ++i) {
        const struct sc_reverse_touch_frame *p = &frame[i];
        unsigned index = active_index(f, p->point.pointer_id);
        if (p->phase == SC_TOUCH_PRESS) {
            assert(index == SC_REVERSE_TOUCH_LIMIT);
        } else if (index == SC_REVERSE_TOUCH_LIMIT) {
            assert(p->phase == SC_TOUCH_ABORT);
            f->active_count = 0;
            return SC_TOUCH_INVALID;
        } else if (p->phase == SC_TOUCH_RELEASE || p->phase == SC_TOUCH_ABORT) {
            assert(p->point.x == f->active[index].x);
            assert(p->point.y == f->active[index].y);
        }
        for (unsigned j = 0; j < i; ++j) {
            assert(frame[j].point.pointer_id != p->point.pointer_id);
        }
    }
    for (unsigned i = 0; i < f->active_count; ++i) {
        bool found = false;
        for (unsigned j = 0; j < count; ++j) {
            found |= frame[j].point.pointer_id == f->active[i].pointer_id;
        }
        assert(found);
    }
    f->active_count = 0;
    for (unsigned i = 0; i < count; ++i) {
        if (frame[i].phase == SC_TOUCH_PRESS || frame[i].phase == SC_TOUCH_UPDATE) {
            f->active[f->active_count++] = frame[i].point;
        }
    }
    return SC_TOUCH_OK;
}

static void
retry_wait(void *userdata) {
    struct fixture *f = userdata;
    ++f->waits;
}

static bool
mouse(void *userdata, const struct sc_reverse_touch_point *point,
      enum sc_reverse_touch_phase phase) {
    (void) point;
    struct fixture *f = userdata;
    ++f->mouse_calls;
    if (f->mouse_fail) {
        return false;
    }
    if (phase == SC_TOUCH_PRESS) {
        assert(!f->mouse_down);
        f->mouse_down = true;
    } else if (phase == SC_TOUCH_RELEASE) {
        assert(f->mouse_down);
        f->mouse_down = false;
    } else {
        assert(f->mouse_down);
    }
    return true;
}

static void
init(struct fixture *f, bool mouse_only) {
    *f = (struct fixture) {0};
    static const struct sc_reverse_touch_callbacks callbacks = {
        .inject = inject, .retry_wait = retry_wait, .mouse = mouse,
    };
    sc_reverse_touch_init(&f->touch, mouse_only, &callbacks, f);
}

static bool
event(struct fixture *f, enum sc_reverse_touch_action action,
      uint64_t id, int x, int64_t now) {
    struct sc_reverse_touch_point p = {id, x, x + 2, 512};
    return sc_reverse_touch_event(&f->touch, action, p, now);
}

static void
same_frame(const struct recorded_frame *a, const struct recorded_frame *b) {
    assert(a->count == b->count);
    for (unsigned i = 0; i < a->count; ++i) {
        assert(a->points[i].point.pointer_id == b->points[i].point.pointer_id);
        assert(a->points[i].point.x == b->points[i].point.x);
        assert(a->points[i].point.y == b->points[i].point.y);
        assert(a->points[i].point.pressure == b->points[i].point.pressure);
        assert(a->points[i].phase == b->points[i].phase);
    }
}

static void
test_retry_and_hold(void) {
    struct fixture f;
    init(&f, false);
    f.errors[0] = f.errors[1] = SC_TOUCH_RETRY;
    f.error_count = 2;
    assert(event(&f, SC_TOUCH_DOWN, 3, 40, 100));
    assert(f.calls == 3 && f.waits == 2 && !f.touch.mouse_only);
    same_frame(&f.log[0], &f.log[1]);
    same_frame(&f.log[1], &f.log[2]);
    assert(event(&f, SC_TOUCH_ADD, 9, 90, 200));
    sc_reverse_touch_tick(&f.touch, 200 + SC_REVERSE_TOUCH_KEEPALIVE_US - 1);
    assert(f.calls == 4);
    sc_reverse_touch_tick(&f.touch, 199); // Clock rollback is not a deadline.
    assert(f.calls == 4);
    sc_reverse_touch_tick(&f.touch, 200 + SC_REVERSE_TOUCH_KEEPALIVE_US);
    assert(f.calls == 5 && f.log[4].count == 2);
    assert(f.log[4].points[0].phase == SC_TOUCH_UPDATE);
    assert(f.log[4].points[1].phase == SC_TOUCH_UPDATE);
    assert(event(&f, SC_TOUCH_MOVE, 3, 51, 90000));
    assert(event(&f, SC_TOUCH_UP, 3, 999, 90001));
    assert(f.touch.primary == SC_REVERSE_TOUCH_NONE);
    assert(f.log[f.calls - 1].points[0].point.x == 51);
    assert(event(&f, SC_TOUCH_UP, 9, 999, 90002));
    assert(!f.active_count && !f.touch.count);
    unsigned calls = f.calls;
    sc_reverse_touch_tick(&f.touch, 1000000);
    assert(f.calls == calls);
}

static void
test_retry_each_phase(void) {
    for (unsigned phase = 0; phase < 4; ++phase) {
        struct fixture f;
        init(&f, false);
        assert(event(&f, SC_TOUCH_DOWN, 1, 10, 0));
        unsigned first = f.calls;
        f.errors[0] = f.errors[1] = SC_TOUCH_RETRY;
        f.error_count = 2;
        if (phase == 0) {
            assert(event(&f, SC_TOUCH_MOVE, 1, 20, 1));
        } else if (phase == 1) {
            assert(event(&f, SC_TOUCH_UP, 1, 999, 1));
        } else if (phase == 2) {
            assert(sc_reverse_touch_cancel(&f.touch));
        } else {
            sc_reverse_touch_tick(&f.touch, SC_REVERSE_TOUCH_KEEPALIVE_US);
        }
        assert(f.calls == first + 3 && f.waits == 2);
        same_frame(&f.log[first], &f.log[first + 1]);
        same_frame(&f.log[first + 1], &f.log[first + 2]);
        assert(sc_reverse_touch_cancel(&f.touch));
        assert(!f.active_count);
    }
}

static void
test_failure_recovery(void) {
    const enum sc_reverse_touch_result failures[] = {
        SC_TOUCH_TIMEOUT, SC_TOUCH_INVALID, SC_TOUCH_FAILED,
    };
    for (unsigned i = 0; i < sizeof(failures) / sizeof(failures[0]); ++i) {
        struct fixture f;
        init(&f, false);
        assert(event(&f, SC_TOUCH_DOWN, 1, 10, 0));
        assert(event(&f, SC_TOUCH_ADD, 2, 20, 1));
        f.errors[0] = failures[i]; f.error_count = 1;
        assert(!event(&f, SC_TOUCH_MOVE, 1, 80, 2));
        assert(!f.active_count && !f.touch.count && f.touch.needs_down);
        assert(!f.touch.mouse_only && !f.mouse_calls);
        assert(f.log[3].points[0].phase == SC_TOUCH_ABORT);
        assert(f.log[3].points[0].point.x == 10); // Not the rejected MOVE.
        unsigned calls = f.calls;
        assert(!event(&f, SC_TOUCH_MOVE, 2, 30, 3));
        assert(!event(&f, SC_TOUCH_ADD, 4, 30, 4));
        assert(!event(&f, SC_TOUCH_UP, 2, 30, 5));
        sc_reverse_touch_tick(&f.touch, 1000000);
        assert(f.calls == calls); // No synthetic DOWN from failed keepalive.
        assert(event(&f, SC_TOUCH_DOWN, 8, 40, 6));
        assert(event(&f, SC_TOUCH_ADD, 9, 50, 7));
        assert(f.active_count == 2 && !f.touch.mouse_only);
        assert(sc_reverse_touch_cancel(&f.touch));
        assert(!f.active_count);
    }
}

static void
test_release_and_keepalive_failures(void) {
    for (unsigned i = 0; i < 3; ++i) {
        struct fixture f;
        init(&f, false);
        assert(event(&f, SC_TOUCH_DOWN, 1, 10, 0));
        if (i == 1) {
            assert(event(&f, SC_TOUCH_ADD, 2, 20, 1));
        }
        f.errors[0] = SC_TOUCH_TIMEOUT; f.error_count = 1;
        if (i == 2) {
            sc_reverse_touch_tick(&f.touch, SC_REVERSE_TOUCH_KEEPALIVE_US);
        } else {
            assert(!event(&f, SC_TOUCH_UP, 1, 999, 2));
        }
        assert(!f.touch.count && !f.active_count && f.touch.needs_down);
        unsigned calls = f.calls;
        sc_reverse_touch_tick(&f.touch, 1000000);
        assert(f.calls == calls); // Final UP never resurrects a finger.
    }
}

static void
test_bounded_retry_and_cleanup(void) {
    struct fixture f;
    init(&f, false);
    for (unsigned i = 0; i < 4; ++i) {
        f.errors[i] = SC_TOUCH_RETRY;
    }
    f.error_count = 4;
    assert(!event(&f, SC_TOUCH_DOWN, 1, 10, 0));
    assert(f.calls == 4 && f.waits == 3 && !f.active_count);
    for (unsigned i = 1; i < 4; ++i) {
        same_frame(&f.log[0], &f.log[i]);
    }
    assert(!f.touch.mouse_only && event(&f, SC_TOUCH_DOWN, 2, 20, 1));
    f.error_index = 0; f.error_count = 6;
    for (unsigned i = 0; i < 6; ++i) {
        f.errors[i] = SC_TOUCH_TIMEOUT;
    }
    assert(!event(&f, SC_TOUCH_MOVE, 2, 99, 2));
    assert(f.touch.needs_down && f.touch.count == 1 && f.active_count == 1);
    assert(!event(&f, SC_TOUCH_DOWN, 3, 30, 3));
    assert(f.touch.contacts[0].pointer_id == 2);
    sc_reverse_touch_tick(&f.touch, 100000);
    assert(f.touch.count == 1); // Failed cancels must retain the ledger.
    f.error_count = f.error_index;
    assert(sc_reverse_touch_cancel(&f.touch));
    assert(!f.active_count && !f.touch.count);
    assert(event(&f, SC_TOUCH_DOWN, 3, 30, 4));
    assert(sc_reverse_touch_cancel(&f.touch));
}

static void
test_fallback_and_lifecycle(void) {
    struct fixture f;
    init(&f, false);
    f.errors[0] = SC_TOUCH_UNAVAILABLE; f.error_count = 1;
    assert(!event(&f, SC_TOUCH_DOWN, 1, 10, 0));
    assert(f.touch.mouse_only && !f.mouse_calls && !f.touch.count);
    assert(event(&f, SC_TOUCH_DOWN, 2, 20, 1));
    assert(f.mouse_down);
    assert(sc_reverse_touch_cancel(&f.touch) && !f.mouse_down);

    init(&f, true);
    assert(event(&f, SC_TOUCH_DOWN, 1, 10, 0));
    assert(event(&f, SC_TOUCH_ADD, 2, 20, 1));
    assert(f.mouse_down && f.mouse_calls == 1 && !f.calls);
    assert(event(&f, SC_TOUCH_UP, 1, 999, 2));
    assert(!f.mouse_down && f.mouse_calls == 2);
    assert(event(&f, SC_TOUCH_MOVE, 2, 25, 3));
    assert(f.mouse_calls == 2); // Do not promote another finger to mouse.
    assert(sc_reverse_touch_cancel(&f.touch));
    assert(!event(&f, SC_TOUCH_MOVE, 2, 30, 4));
    assert(event(&f, SC_TOUCH_DOWN, 3, 30, 5));
    f.mouse_fail = true;
    assert(!sc_reverse_touch_cancel(&f.touch));
    assert(f.touch.mouse_down && f.touch.count == 1);
    assert(!event(&f, SC_TOUCH_DOWN, 4, 40, 6));
    f.mouse_fail = false;
    assert(sc_reverse_touch_cancel(&f.touch) && !f.mouse_down);

    // The same cancel entrypoint is used by pause, scroll, disconnect, Stop,
    // geometry invalidation and final teardown. Idempotence prevents replay.
    init(&f, false);
    assert(event(&f, SC_TOUCH_DOWN, 5, 50, 0));
    assert(sc_reverse_touch_cancel(&f.touch));
    unsigned calls = f.calls;
    for (unsigned i = 0; i < 100; ++i) {
        assert(sc_reverse_touch_cancel(&f.touch));
        sc_reverse_touch_tick(&f.touch, 1000000);
        assert(!event(&f, SC_TOUCH_MOVE, 5, 60, i));
    }
    assert(f.calls == calls && !f.active_count);
}

static void
test_bounds_and_stress(void) {
    struct fixture f;
    init(&f, false);
    assert(!event(&f, SC_TOUCH_MOVE, 1, 0, 0));
    assert(!event(&f, SC_TOUCH_DOWN, UINT64_MAX, 0, 0));
    assert(!f.calls);
    assert(event(&f, SC_TOUCH_DOWN, 1, -20, 0));
    for (unsigned i = 2; i <= SC_REVERSE_TOUCH_LIMIT; ++i) {
        assert(event(&f, SC_TOUCH_ADD, i, i, i));
    }
    assert(!event(&f, SC_TOUCH_ADD, 99, 99, 99));
    assert(!event(&f, SC_TOUCH_ADD, 2, 2, 2));
    assert(!event(&f, SC_TOUCH_UP, 99, 0, 0));
    assert(f.active_count == SC_REVERSE_TOUCH_LIMIT);
    assert(sc_reverse_touch_cancel(&f.touch));
    for (unsigned i = 0; i < 2000; ++i) {
        f.calls = 0;
        assert(event(&f, SC_TOUCH_DOWN, UINT32_MAX, -200, i));
        assert(event(&f, SC_TOUCH_ADD, 2, 0, i));
        f.error_count = 1; f.error_index = 0;
        f.errors[0] = i % 2 ? SC_TOUCH_TIMEOUT : SC_TOUCH_RETRY;
        event(&f, SC_TOUCH_MOVE, 2, 100, i);
        assert(sc_reverse_touch_cancel(&f.touch));
        assert(!f.active_count && !f.touch.mouse_down);
    }
}

int
main(void) {
    test_retry_and_hold();
    test_retry_each_phase();
    test_failure_recovery();
    test_release_and_keepalive_failures();
    test_bounded_retry_and_cleanup();
    test_fallback_and_lifecycle();
    test_bounds_and_stress();
    puts("reverse touch: seven regression groups passed (2,000 stress gestures)");
    return 0;
}

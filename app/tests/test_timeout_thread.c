#include <assert.h>
#include <stdatomic.h>
#include "util/timeout.h"

struct observation { atomic_uint calls; struct sc_timeout *expected; };
static void expired(struct sc_timeout *timeout, void *userdata) {
    struct observation *o = userdata;
    assert(timeout == o->expected);
    atomic_fetch_add(&o->calls, 1);
    sc_timeout_stop(timeout); // Also verify callbacks are outside the lock.
}
int main(void) {
    static const struct sc_timeout_callbacks cbs = {.on_timeout = expired};
    for (unsigned i = 0; i < 128; ++i) {
        struct sc_timeout timeout;
        struct observation o = {.calls = ATOMIC_VAR_INIT(0), .expected = &timeout};
        assert(sc_timeout_init(&timeout));
        assert(sc_timeout_start(&timeout, 0, &cbs, &o));
        sc_timeout_join(&timeout);
        assert(atomic_load(&o.calls) == 1);
        sc_timeout_destroy(&timeout);
    }
    for (unsigned mode = 0; mode < 3; ++mode) {
        struct sc_timeout timeout;
        struct observation o = {.calls = ATOMIC_VAR_INIT(0), .expected = &timeout};
        assert(sc_timeout_init(&timeout));
        if (mode == 0) sc_timeout_stop(&timeout);
        assert(sc_timeout_start(&timeout, sc_tick_now() + SC_TICK_FROM_SEC(30), &cbs, &o));
        if (mode == 2) {
            sc_mutex_lock(&timeout.mutex);
            sc_cond_signal(&timeout.cond); // A wakeup must not fire early.
            sc_mutex_unlock(&timeout.mutex);
        }
        sc_timeout_stop(&timeout);
        sc_timeout_join(&timeout);
        assert(!atomic_load(&o.calls));
        sc_timeout_destroy(&timeout);
    }
    return 0;
}

#include <assert.h>
#include <stddef.h>
#include <stdlib.h>
#include "util/timeout.h"

// Deterministic scheduler: Create can run the worker before it returns, and a
// timed wait can observe Stop exactly as it returns false. No timing sleeps.
static unsigned mutexes, conditions, locks, waits, calls, signals, joins;
static bool fail_mutex, fail_cond, fail_thread, cancel_on_wait, signal_first;
static struct sc_timeout *active;
static int expected_userdata;
static sc_tick expected_deadline;

bool sc_mutex_init(sc_mutex *mutex) {
    (void) mutex;
    if (fail_mutex) return false;
    ++mutexes; return true;
}
void sc_mutex_destroy(sc_mutex *mutex) { (void) mutex; assert(mutexes); --mutexes; }
bool sc_cond_init(sc_cond *cond) {
    (void) cond;
    if (fail_cond) return false;
    ++conditions; return true;
}
void sc_cond_destroy(sc_cond *cond) { (void) cond; assert(conditions); --conditions; }
void sc_mutex_lock(sc_mutex *mutex) { (void) mutex; assert(!locks); ++locks; }
void sc_mutex_unlock(sc_mutex *mutex) { (void) mutex; assert(locks == 1); --locks; }
void sc_cond_signal(sc_cond *cond) { (void) cond; assert(locks == 1); ++signals; }
bool sc_cond_timedwait(sc_cond *cond, sc_mutex *mutex, sc_tick deadline) {
    (void) cond; (void) mutex;
    assert(locks == 1 && deadline == expected_deadline);
    ++waits;
    if (signal_first && waits == 1) return true;
    if (cancel_on_wait) active->stopped = true;
    return false;
}
bool sc_thread_create(sc_thread *t, sc_thread_fn fn, const char *name, void *data) {
    (void) t; (void) name;
    if (fail_thread) return false;
    assert(!locks);
    assert(fn(data) == 0);
    return true;
}
void sc_thread_join(sc_thread *thread, int *status) {
    (void) thread; (void) status; ++joins;
}
static void expired(struct sc_timeout *timeout, void *userdata) {
    assert(timeout == active && userdata == &expected_userdata && !locks);
    ++calls;
    // A callback is allowed to request Stop without deadlocking.
    sc_timeout_stop(timeout);
}
static void stale(struct sc_timeout *timeout, void *userdata) {
    (void) timeout; (void) userdata;
    assert(!"Worker observed stale callback state");
}
int main(int argc, char **argv) {
    // Optional selector is used by the failing-before regression audit.
    int selected = argc > 1 ? atoi(argv[1]) : -1;
    assert(selected >= -1 && selected < 5);
    struct sc_timeout timeout;
    static const struct sc_timeout_callbacks cbs = {.on_timeout = expired};
    static const struct sc_timeout_callbacks old = {.on_timeout = stale};
    active = &timeout; expected_deadline = 1234567;
    if (selected == -1) {
        fail_mutex = true;
        assert(!sc_timeout_init(&timeout) && !mutexes && !conditions);
        fail_mutex = false; fail_cond = true;
        assert(!sc_timeout_init(&timeout) && !mutexes && !conditions);
        fail_cond = false;
    }
    for (unsigned mode = 0; mode < 5; ++mode) {
        if (selected >= 0 && mode != (unsigned) selected) continue;
        assert(sc_timeout_init(&timeout));
        calls = waits = signals = joins = 0;
        timeout.cbs = mode == 1 ? &old : &cbs;
        timeout.deadline = mode == 1 ? 0 : expected_deadline;
        timeout.cbs_userdata = mode == 1 ? NULL : &expected_userdata;
        fail_thread = mode == 0;
        cancel_on_wait = mode == 3;
        signal_first = mode == 4;
        if (mode == 2) sc_timeout_stop(&timeout);
        bool started = sc_timeout_start(&timeout, expected_deadline, &cbs, &expected_userdata);
        assert(started == !fail_thread);
        if (started) {
            sc_timeout_join(&timeout);
            assert(joins == 1);
        }
        assert(calls == (mode == 1 || mode == 4));
        assert(waits == (mode == 4 ? 2 : mode == 1 || mode == 3 ? 1 : 0));
        sc_timeout_destroy(&timeout);
        assert(!mutexes && !conditions && !locks);
    }
    return 0;
}

#include "timeout.h"

#include <assert.h>
#include <stddef.h>

#include "util/log.h"

bool
sc_timeout_init(struct sc_timeout *timeout) {
    bool ok = sc_mutex_init(&timeout->mutex);
    if (!ok) {
        return false;
    }

    ok = sc_cond_init(&timeout->cond);
    if (!ok) {
        sc_mutex_destroy(&timeout->mutex);
        return false;
    }

    timeout->stopped = false;

    return true;
}

static int
run_timeout(void *data) {
    struct sc_timeout *timeout = data;
    sc_mutex_lock(&timeout->mutex);
    while (!timeout->stopped) {
        if (sc_cond_timedwait(&timeout->cond, &timeout->mutex,
                              timeout->deadline)) {
            continue; // A signal alone is not an expiration.
        }
        // Stop and expiration are decided under the same lock. Once claimed,
        // a callback may finish concurrently with Stop; Join waits for it.
        bool notify = !timeout->stopped;
        sc_mutex_unlock(&timeout->mutex);
        if (notify) {
            timeout->cbs->on_timeout(timeout, timeout->cbs_userdata);
        }
        return 0;
    }
    sc_mutex_unlock(&timeout->mutex);

    return 0;
}

bool
sc_timeout_start(struct sc_timeout *timeout, sc_tick deadline,
                 const struct sc_timeout_callbacks *cbs, void *cbs_userdata) {
    assert(cbs && cbs->on_timeout);
    // Immutable worker inputs must be ready even if it runs before Create
    // returns. Do not clear stopped: Stop before Start is still cancellation.
    timeout->cbs = cbs;
    timeout->cbs_userdata = cbs_userdata;
    timeout->deadline = deadline;

    if (!sc_thread_create(&timeout->thread, run_timeout, "scrcpy-timeout",
                           timeout)) {
        LOGE("Timeout: could not start thread");
        return false;
    }

    return true;
}

void
sc_timeout_stop(struct sc_timeout *timeout) {
    sc_mutex_lock(&timeout->mutex);
    timeout->stopped = true;
    sc_cond_signal(&timeout->cond);
    sc_mutex_unlock(&timeout->mutex);
}

void
sc_timeout_join(struct sc_timeout *timeout) {
    sc_thread_join(&timeout->thread, NULL);
}

void
sc_timeout_destroy(struct sc_timeout *timeout) {
    sc_mutex_destroy(&timeout->mutex);
    sc_cond_destroy(&timeout->cond);
}

#include <assert.h>
#include "reverse_watchdog.h"

int main(void) {
    struct sc_reverse_watchdog w;
    sc_reverse_watchdog_init(&w);
    const int64_t timeout = SC_REVERSE_STALL_TIMEOUT_US;
    assert(!sc_reverse_watchdog_expired(&w, timeout * 100));

    // A blocked encoder/header write expires before any frame ACK is possible.
    sc_reverse_watchdog_begin(&w, 10);
    assert(!sc_reverse_watchdog_expired(&w, timeout + 9));
    assert(sc_reverse_watchdog_expired(&w, timeout + 10));
    sc_reverse_watchdog_end(&w);

    sc_reverse_watchdog_begin(&w, 20);
    sc_reverse_watchdog_submit(&w, 1);
    sc_reverse_watchdog_end(&w);
    sc_reverse_watchdog_begin(&w, 30);
    sc_reverse_watchdog_submit(&w, 2);
    sc_reverse_watchdog_end(&w);
    assert(!sc_reverse_watchdog_ack(&w, 99, 40));
    assert(sc_reverse_watchdog_expired(&w, timeout + 20));
    assert(sc_reverse_watchdog_ack(&w, 1, 50));
    assert(!sc_reverse_watchdog_ack(&w, 1, timeout + 49));
    assert(sc_reverse_watchdog_expired(&w, timeout + 50));
    assert(sc_reverse_watchdog_ack(&w, 2, 60));
    // An unchanged desktop with all frames acknowledged must never time out.
    assert(!sc_reverse_watchdog_expired(&w, timeout * 100));

    sc_reverse_watchdog_begin(&w, 70);
    sc_reverse_watchdog_submit(&w, 3);
    assert(sc_reverse_watchdog_ack(&w, 3, 80));
    // An ACK arriving during a blocked write cannot disarm the watchdog.
    assert(sc_reverse_watchdog_expired(&w, timeout + 80));
    sc_reverse_watchdog_end(&w);
    assert(!sc_reverse_watchdog_expired(&w, timeout * 100));
    // Background video pause is deliberate, even with packets still in flight.
    sc_reverse_watchdog_begin(&w, 100);
    sc_reverse_watchdog_submit(&w, 4);
    sc_reverse_watchdog_end(&w);
    sc_reverse_watchdog_set_paused(&w, true, 110);
    assert(!sc_reverse_watchdog_expired(&w, timeout * 100));
    assert(!sc_reverse_watchdog_ack(&w, 999, timeout * 100));
    sc_reverse_watchdog_set_paused(&w, false, timeout * 100);
    assert(!sc_reverse_watchdog_expired(&w, timeout * 100 + 1));
    // Resume gives outstanding work a fresh deadline, not immunity from stalls.
    sc_reverse_watchdog_set_paused(&w, false, timeout * 100 + 100);
    assert(sc_reverse_watchdog_expired(&w, timeout * 101));
    sc_reverse_watchdog_set_paused(&w, true, timeout * 102);
    assert(sc_reverse_watchdog_ack(&w, 4, timeout * 103));
    sc_reverse_watchdog_set_paused(&w, false, timeout * 104);
    assert(!sc_reverse_watchdog_expired(&w, timeout * 200));
    return 0;
}

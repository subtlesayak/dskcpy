#include "reverse_pointer.h"

void
sc_reverse_pointer_init(struct sc_reverse_pointer *p,
    sc_reverse_pointer_inject inject, void *userdata) {
    *p = (struct sc_reverse_pointer) {.inject = inject, .userdata = userdata};
}

bool
sc_reverse_pointer_release(struct sc_reverse_pointer *p) {
    if (!p->pending_up) return true;
    const struct sc_reverse_pointer_event up = {.x = p->x, .y = p->y};
    if (p->inject(p->userdata, &up, 1) != 1) return false;
    p->pending_up = false;
    return true;
}

bool
sc_reverse_pointer_click(struct sc_reverse_pointer *p, int32_t x, int32_t y) {
    if (p->pending_up) {
        sc_reverse_pointer_release(p);
        return false; // Cleanup is not consent to replay a failed click.
    }
    const struct sc_reverse_pointer_event events[] = {
        {.x = x, .y = y, .down = true}, {.x = x, .y = y},
    };
    size_t sent = p->inject(p->userdata, events, 2);
    if (sent == 2) return true;
    if (sent) { // Partial or invalid delivery: preserve cleanup coordinates.
        p->x = x; p->y = y; p->pending_up = true;
        sc_reverse_pointer_release(p);
    }
    return false;
}

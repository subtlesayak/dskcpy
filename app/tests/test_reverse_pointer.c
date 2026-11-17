#include <assert.h>
#include <string.h>
#include "reverse_pointer.h"

struct fixture {
    size_t results[8], sizes[8], calls;
    struct sc_reverse_pointer_event events[8][2];
};
static size_t inject(void *userdata, const struct sc_reverse_pointer_event *events, size_t count) {
    struct fixture *f = userdata;
    assert(f->calls < 8 && count && count <= 2);
    size_t call = f->calls++;
    f->sizes[call] = count;
    memcpy(f->events[call], events, count * sizeof(*events));
    return f->results[call];
}
static void balanced(void) {
    struct fixture f = {.results = {2}}; struct sc_reverse_pointer p;
    sc_reverse_pointer_init(&p, inject, &f);
    assert(sc_reverse_pointer_click(&p, -40, 90));
    assert(f.calls == 1 && f.sizes[0] == 2 && !p.pending_up);
    assert(f.events[0][0].down && !f.events[0][1].down);
    assert(f.events[0][0].x == -40 && f.events[0][1].x == -40);
    assert(f.events[0][0].y == 90 && f.events[0][1].y == 90);
    assert(sc_reverse_pointer_release(&p) && f.calls == 1);
}
static void partial(void) {
    struct fixture f = {.results = {1, 0, 0, 1, 2}}; struct sc_reverse_pointer p;
    sc_reverse_pointer_init(&p, inject, &f);
    assert(!sc_reverse_pointer_click(&p, 23, 45) && p.pending_up);
    assert(f.calls == 2 && f.sizes[1] == 1 && !f.events[1][0].down);
    assert(!sc_reverse_pointer_click(&p, 999, 888) && p.pending_up);
    assert(f.calls == 3 && f.events[2][0].x == 23 && f.events[2][0].y == 45);
    assert(sc_reverse_pointer_release(&p) && !p.pending_up);
    assert(f.events[3][0].x == 23 && !f.events[3][0].down);
    assert(sc_reverse_pointer_click(&p, 80, 90) && f.calls == 5);
}
static void denied(void) {
    struct fixture f = {.results = {0}}; struct sc_reverse_pointer p;
    sc_reverse_pointer_init(&p, inject, &f);
    assert(!sc_reverse_pointer_click(&p, 1, 2) && !p.pending_up && f.calls == 1);
    assert(sc_reverse_pointer_release(&p) && f.calls == 1);
}
static void invalid_delivery(void) {
    struct fixture f = {.results = {3, 0, 1}}; struct sc_reverse_pointer p;
    sc_reverse_pointer_init(&p, inject, &f);
    assert(!sc_reverse_pointer_click(&p, 5, 6) && p.pending_up);
    assert(sc_reverse_pointer_release(&p) && !p.pending_up);
    assert(f.calls == 3 && !f.events[1][0].down && !f.events[2][0].down);
}
int main(void) { balanced(); partial(); denied(); invalid_delivery(); return 0; }

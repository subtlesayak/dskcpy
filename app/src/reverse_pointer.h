#ifndef SC_REVERSE_POINTER_H
#define SC_REVERSE_POINTER_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

struct sc_reverse_pointer_event { int32_t x, y; bool down; };

// Return the number of events delivered in order. The platform callback must
// prepare the entire batch before it can deliver its first event.
typedef size_t (*sc_reverse_pointer_inject)(void *userdata,
    const struct sc_reverse_pointer_event *events, size_t count);

// Serialized by the native input owner. A partial click retains only UP:
// cleanup may never replay DOWN or move to a newly requested coordinate.
struct sc_reverse_pointer {
    bool pending_up;
    int32_t x, y;
    sc_reverse_pointer_inject inject;
    void *userdata;
};
void sc_reverse_pointer_init(struct sc_reverse_pointer *pointer,
    sc_reverse_pointer_inject inject, void *userdata);
bool sc_reverse_pointer_release(struct sc_reverse_pointer *pointer);
bool sc_reverse_pointer_click(struct sc_reverse_pointer *pointer, int32_t x, int32_t y);

#endif

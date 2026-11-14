#ifndef SC_REVERSE_QUALITY_H
#define SC_REVERSE_QUALITY_H
#include <stdbool.h>
#include <stdint.h>

struct sc_reverse_quality { unsigned fps; uint32_t bit_rate; };
// Fixed levels can only reduce immutable owner-selected launch limits. They do
// not change geometry, permissions, capture/audio epochs or input ownership.
static inline bool
sc_reverse_quality_target(unsigned max_fps, uint32_t max_bit_rate, unsigned level,
                          struct sc_reverse_quality *result) {
    if (!max_fps || max_fps > 240 || max_bit_rate < 500000
            || max_bit_rate > 64000000 || level > 2 || !result) return false;
    unsigned cap = level == 2 ? 15 : level == 1 ? 30 : max_fps;
    uint32_t rate = level ? (uint32_t)((uint64_t)max_bit_rate * (level == 1 ? 6 : 3) / 10) : max_bit_rate;
    *result = (struct sc_reverse_quality){max_fps < cap ? max_fps : cap, rate < 500000 ? 500000 : rate};
    return true;
}
static inline bool
sc_reverse_quality_apply(unsigned max_fps, uint32_t max_bit_rate, unsigned level,
                        bool (*set_bit_rate)(uint32_t, void *), void *context,
                        struct sc_reverse_quality *applied) {
    struct sc_reverse_quality target;
    if (!applied || !set_bit_rate || !sc_reverse_quality_target(max_fps, max_bit_rate, level, &target)
            || !set_bit_rate(target.bit_rate, context)) return false;
    *applied = target;
    return true;
}
#endif

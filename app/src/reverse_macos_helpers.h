#ifndef SC_REVERSE_MACOS_HELPERS_H
#define SC_REVERSE_MACOS_HELPERS_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "coords.h"

#define SC_REVERSE_MACOS_MAX_PACKET (16u * 1024u * 1024u)

struct sc_reverse_macos_pause_callbacks {
    void (*transition)(void *userdata, bool paused);
    void (*keyframe)(void *userdata);
};
// Receiver-thread dispatch. Resume also requests an IDR while already active;
// only a real state transition may retire audio or held input.
void sc_reverse_macos_pause(bool current, bool requested,
    const struct sc_reverse_macos_pause_callbacks *callbacks, void *userdata);

bool sc_reverse_macos_dimensions(uint32_t width, uint32_t height, uint16_t limit,
                                  uint16_t *out_width, uint16_t *out_height);
bool sc_reverse_macos_letterbox(double source_width, double source_height, uint16_t width, uint16_t height,
                                double *x, double *y, double *out_width, double *out_height);
bool sc_reverse_macos_point(const struct sc_position *position,
                            double left, double top, double width, double height,
                            double *x, double *y);
// Allocates Annex-B output; caller frees it. Rejects malformed/truncated AVCC.
bool sc_reverse_macos_annexb(const uint8_t *data, size_t size, unsigned length_size,
                             uint8_t **output, size_t *output_size);

#endif

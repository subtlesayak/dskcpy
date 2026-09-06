#include "reverse_macos_helpers.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

bool
sc_reverse_macos_dimensions(uint32_t width, uint32_t height, uint16_t limit,
                             uint16_t *out_width, uint16_t *out_height) {
    if (width < 2 || height < 2 || width > 32768 || height > 32768) return false;
    uint32_t cap = limit ? limit : 1920;
    if (cap < 2 || cap > 8192) return false;
    uint32_t largest = width > height ? width : height;
    if (largest > cap) {
        width = (uint64_t) width * cap / largest;
        height = (uint64_t) height * cap / largest;
    }
    width &= ~1u; height &= ~1u;
    if (width < 2 || height < 2) return false;
    *out_width = width; *out_height = height;
    return true;
}

bool
sc_reverse_macos_point(const struct sc_position *position,
                       double left, double top, double width, double height,
                       double *x, double *y) {
    if (position->screen_size.width < 2 || position->screen_size.height < 2
            || !isfinite(left) || !isfinite(top) || !isfinite(width) || !isfinite(height)
            || width < 2 || height < 2) return false;
    double px = position->point.x, py = position->point.y;
    double max_x = position->screen_size.width - 1, max_y = position->screen_size.height - 1;
    if (px < 0) px = 0; else if (px > max_x) px = max_x;
    if (py < 0) py = 0; else if (py > max_y) py = max_y;
    // CoreGraphics display bounds are logical points, not Retina backing pixels.
    *x = left + px * (width - 1) / max_x;
    *y = top + py * (height - 1) / max_y;
    return true;
}

bool
sc_reverse_macos_annexb(const uint8_t *data, size_t size, unsigned length_size,
                        uint8_t **output, size_t *output_size) {
    *output = NULL; *output_size = 0;
    if (!data || !size || size > SC_REVERSE_MACOS_MAX_PACKET || length_size < 1 || length_size > 4) return false;
    size_t offset = 0, needed = 0;
    while (offset < size) {
        if (size - offset < length_size) return false;
        uint32_t length = 0;
        for (unsigned i = 0; i < length_size; ++i) length = (length << 8) | data[offset++];
        if (!length || length > size - offset || needed > SC_REVERSE_MACOS_MAX_PACKET - 4
                || length > SC_REVERSE_MACOS_MAX_PACKET - needed - 4) return false;
        needed += 4 + length; offset += length;
    }
    uint8_t *buffer = malloc(needed);
    if (!buffer) return false;
    offset = 0; size_t target = 0;
    while (offset < size) {
        uint32_t length = 0;
        for (unsigned i = 0; i < length_size; ++i) length = (length << 8) | data[offset++];
        memcpy(buffer + target, "\0\0\0\1", 4); target += 4;
        memcpy(buffer + target, data + offset, length); target += length; offset += length;
    }
    *output = buffer; *output_size = needed;
    return true;
}

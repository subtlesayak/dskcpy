#include <assert.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>
#include "reverse_macos_helpers.h"

int main(void) {
    uint16_t w, h;
    assert(sc_reverse_macos_dimensions(3024, 1964, 1920, &w, &h));
    assert(w == 1920 && h == 1246); // Retina MacBook dimensions, even H.264 output.
    assert(sc_reverse_macos_dimensions(1080, 1920, 0, &w, &h));
    assert(w == 1080 && h == 1920);
    assert(!sc_reverse_macos_dimensions(0, 100, 1920, &w, &h));
    assert(!sc_reverse_macos_dimensions(300000, 100, 1920, &w, &h));
    assert(!sc_reverse_macos_dimensions(1920, 1080, 1, &w, &h));
    struct sc_position pos = {.screen_size = {1920, 1080}, .point = {1919, 1079}};
    double x, y;
    assert(sc_reverse_macos_point(&pos, -1512, -100, 1512, 982, &x, &y));
    assert(x == -1 && y == 881);
    pos.point.x = -10; pos.point.y = 9000;
    assert(sc_reverse_macos_point(&pos, -1512, 0, 1512, 982, &x, &y));
    assert(x == -1512 && y == 981);
    assert(!sc_reverse_macos_point(&pos, NAN, 0, 1512, 982, &x, &y));
    pos.screen_size.width = 0;
    assert(!sc_reverse_macos_point(&pos, 0, 0, 1512, 982, &x, &y));
    uint8_t avcc[] = {0, 0, 0, 2, 0x65, 1, 0, 0, 0, 1, 0x61};
    uint8_t expected[] = {0, 0, 0, 1, 0x65, 1, 0, 0, 0, 1, 0x61};
    uint8_t *out; size_t size;
    assert(sc_reverse_macos_annexb(avcc, sizeof(avcc), 4, &out, &size));
    assert(size == sizeof(expected) && !memcmp(out, expected, size)); free(out);
    uint8_t short_nals[] = {1, 0x65, 2, 0x61, 0};
    assert(sc_reverse_macos_annexb(short_nals, sizeof(short_nals), 1, &out, &size)); free(out);
    assert(!sc_reverse_macos_annexb(avcc, sizeof(avcc) - 1, 4, &out, &size));
    uint8_t zero[] = {0, 0, 0, 0};
    assert(!sc_reverse_macos_annexb(zero, sizeof(zero), 4, &out, &size));
    uint8_t huge[] = {255, 255, 255, 255};
    assert(!sc_reverse_macos_annexb(huge, sizeof(huge), 4, &out, &size));
    assert(!sc_reverse_macos_annexb(NULL, 0, 4, &out, &size));
    assert(!sc_reverse_macos_annexb(avcc, sizeof(avcc), 0, &out, &size));
    assert(out == NULL && size == 0);
    return 0;
}

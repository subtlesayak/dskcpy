#include "reverse_keyboard.h"

bool sc_reverse_keyboard_usage(uint16_t usage) {
    return (usage >= 4 && usage <= 0x73) || (usage >= 0xe0 && usage <= 0xe7);
}

// Validate the wire's UTF-8 without depending on a platform text decoder.
bool sc_reverse_keyboard_text(const uint8_t *data, size_t size) {
    if (!size || size > SC_REVERSE_TEXT_MAX) return false;
    for (size_t i = 0; i < size;) {
        uint32_t point = data[i++], minimum = 0;
        unsigned remaining = 0;
        if (point >= 0xc2 && point <= 0xdf) { point &= 0x1f; minimum = 0x80; remaining = 1; }
        else if (point >= 0xe0 && point <= 0xef) { point &= 0xf; minimum = 0x800; remaining = 2; }
        else if (point >= 0xf0 && point <= 0xf4) { point &= 7; minimum = 0x10000; remaining = 3; }
        else if (point >= 0x80) return false;
        if (remaining > size - i) return false;
        for (unsigned j = 0; j < remaining; ++j) {
            if ((data[i] & 0xc0) != 0x80) return false;
            point = (point << 6) | (data[i++] & 0x3f);
        }
        if (point < minimum || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)
                || (!point) || (point < 0x20 && point != 9 && point != 10 && point != 13) || point == 0x7f) return false;
    }
    return true;
}

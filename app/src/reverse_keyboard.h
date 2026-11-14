#ifndef SC_REVERSE_KEYBOARD_H
#define SC_REVERSE_KEYBOARD_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#define SC_REVERSE_TEXT_MAX 512
bool sc_reverse_keyboard_usage(uint16_t usage);
bool sc_reverse_keyboard_text(const uint8_t *data, size_t size);
bool sc_reverse_text_valid(const uint8_t *data, size_t size, size_t maximum);
#endif

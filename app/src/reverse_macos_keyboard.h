#ifndef SC_REVERSE_MACOS_KEYBOARD_H
#define SC_REVERSE_MACOS_KEYBOARD_H
#include <ApplicationServices/ApplicationServices.h>
#include <stdbool.h>
#include <stdint.h>
// Owned event; constructing it never injects input.
CGEventRef sc_reverse_macos_key_event(uint16_t usage, bool down, uint8_t modifiers, bool repeat);
#endif

#ifndef SC_REVERSE_WINDOWS_KEYBOARD_H
#define SC_REVERSE_WINDOWS_KEYBOARD_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "reverse_keyboard.h"

enum sc_windows_key_kind { SC_WINDOWS_SCAN, SC_WINDOWS_UNICODE, SC_WINDOWS_VIRTUAL };
struct sc_windows_key_event {
    enum sc_windows_key_kind kind;
    uint16_t code;
    bool up, extended;
};
// The sink returns the length of the accepted prefix. It is supplied by the
// Windows adapter; deterministic tests never call SendInput or post real keys.
typedef size_t (*sc_windows_key_sink)(const struct sc_windows_key_event *, size_t, void *);
typedef bool (*sc_windows_modifier_state)(uint16_t usage, void *);
enum sc_windows_key_result { SC_WINDOWS_KEY_OK, SC_WINDOWS_KEY_UNSUPPORTED, SC_WINDOWS_KEY_INVALID, SC_WINDOWS_KEY_BLOCKED };
struct sc_windows_keyboard {
    sc_windows_key_sink inject;
    sc_windows_modifier_state modifier_down;
    void *userdata;
    bool down[256], release_pending, unicode_pending, blocked;
    uint16_t unicode_unit;
};
void sc_windows_keyboard_init(struct sc_windows_keyboard *, sc_windows_key_sink, sc_windows_modifier_state, void *);
bool sc_windows_keyboard_mapping(uint16_t, struct sc_windows_key_event *);
bool sc_windows_keyboard_release(struct sc_windows_keyboard *);
enum sc_windows_key_result sc_windows_keyboard_key(struct sc_windows_keyboard *, uint8_t, uint16_t, uint8_t);
enum sc_windows_key_result sc_windows_keyboard_text(struct sc_windows_keyboard *, const uint8_t *, size_t);
#endif

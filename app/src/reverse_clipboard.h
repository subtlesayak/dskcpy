#ifndef SC_REVERSE_CLIPBOARD_H
#define SC_REVERSE_CLIPBOARD_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#define SC_REVERSE_CLIPBOARD_MAX 4096
#define SC_REVERSE_CLIPBOARD_PACKET 32u
enum sc_clipboard_op { SC_CLIPBOARD_READ, SC_CLIPBOARD_WRITE, SC_CLIPBOARD_PASTE, SC_CLIPBOARD_CANCEL };
enum sc_clipboard_status { SC_CLIPBOARD_OK, SC_CLIPBOARD_UNAVAILABLE, SC_CLIPBOARD_TOO_LARGE, SC_CLIPBOARD_PASTE_FAILED, SC_CLIPBOARD_BLOCKED };
struct sc_reverse_clipboard_request {
    uint32_t id;
    uint8_t op;
    uint16_t length;
    char text[SC_REVERSE_CLIPBOARD_MAX + 1];
};
struct sc_reverse_clipboard_callbacks {
    enum sc_clipboard_status (*read)(void *context, char *text, size_t *length);
    bool (*write)(void *context, const char *text, size_t length);
    bool (*paste)(void *context);
};
// No OS calls when allowed=false. Return payload bytes only; contents must
// travel on the negotiated media socket, never stdout, logs or diagnostics.
size_t sc_reverse_clipboard_process(const struct sc_reverse_clipboard_request *request,
    bool allowed, const struct sc_reverse_clipboard_callbacks *callbacks, void *context,
    uint8_t output[8 + SC_REVERSE_CLIPBOARD_MAX]);
#endif

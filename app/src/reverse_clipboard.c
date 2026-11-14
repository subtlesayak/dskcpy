#include "reverse_clipboard.h"
#include "reverse_keyboard.h"
#include "util/binary.h"
#include <string.h>

size_t sc_reverse_clipboard_process(const struct sc_reverse_clipboard_request *r,
    bool allowed, const struct sc_reverse_clipboard_callbacks *cbs, void *context,
    uint8_t output[8 + SC_REVERSE_CLIPBOARD_MAX]) {
    if (!r->id || r->op > SC_CLIPBOARD_PASTE || r->length > SC_REVERSE_CLIPBOARD_MAX
            || (r->op == SC_CLIPBOARD_READ ? r->length != 0
                : !sc_reverse_text_valid((const uint8_t *)r->text, r->length, SC_REVERSE_CLIPBOARD_MAX))) return 0;
    enum sc_clipboard_status status = SC_CLIPBOARD_BLOCKED;
    size_t length = 0;
    memset(output, 0, 8 + SC_REVERSE_CLIPBOARD_MAX);
    if (allowed && cbs) {
        if (r->op == SC_CLIPBOARD_READ) {
            status = cbs->read(context, (char *)output + 8, &length);
            if (length > SC_REVERSE_CLIPBOARD_MAX) status = SC_CLIPBOARD_TOO_LARGE;
            else if (status == SC_CLIPBOARD_OK && length
                    && !sc_reverse_text_valid(output + 8, length, SC_REVERSE_CLIPBOARD_MAX)) status = SC_CLIPBOARD_UNAVAILABLE;
        } else {
            status = cbs->write(context, r->text, r->length) ? SC_CLIPBOARD_OK : SC_CLIPBOARD_UNAVAILABLE;
            if (status == SC_CLIPBOARD_OK && r->op == SC_CLIPBOARD_PASTE && !cbs->paste(context)) status = SC_CLIPBOARD_PASTE_FAILED;
        }
    }
    if (status != SC_CLIPBOARD_OK || r->op != SC_CLIPBOARD_READ) { memset(output + 8, 0, SC_REVERSE_CLIPBOARD_MAX); length = 0; }
    output[0] = r->op; output[1] = status; sc_write32be(output + 2, r->id); sc_write16be(output + 6, (uint16_t)length);
    return 8 + length;
}

#include <assert.h>
#include <string.h>
#include "reverse_clipboard.h"
#include "util/binary.h"
struct fixture { int reads, writes, pastes; bool fail_write, fail_paste; size_t read_length; const char *read; char written[SC_REVERSE_CLIPBOARD_MAX + 1]; };
static enum sc_clipboard_status read_text(void *context, char *text, size_t *length) {
    struct fixture *f = context; ++f->reads; *length = f->read_length;
    if (*length <= SC_REVERSE_CLIPBOARD_MAX && *length) memcpy(text, f->read, *length);
    return SC_CLIPBOARD_OK;
}
static bool write_text(void *context, const char *text, size_t length) {
    struct fixture *f = context; ++f->writes; memcpy(f->written, text, length); return !f->fail_write;
}
static bool paste_text(void *context) { struct fixture *f = context; ++f->pastes; return !f->fail_paste; }
int main(void) {
    const struct sc_reverse_clipboard_callbacks callbacks = { read_text, write_text, paste_text };
    struct fixture f = {.read = "café 世界 🙂", .read_length = sizeof("café 世界 🙂") - 1};
    struct sc_reverse_clipboard_request r = {.id = 7, .op = SC_CLIPBOARD_READ}; uint8_t output[8 + SC_REVERSE_CLIPBOARD_MAX];
    assert(sc_reverse_clipboard_process(&r, false, &callbacks, &f, output) == 8);
    assert(output[1] == SC_CLIPBOARD_BLOCKED && !f.reads && !f.writes && !f.pastes);
    assert(sc_reverse_clipboard_process(&r, true, &callbacks, &f, output) == 8 + f.read_length);
    assert(sc_read32be(output + 2) == 7 && sc_read16be(output + 6) == f.read_length && !memcmp(output + 8, f.read, f.read_length));
    f.read_length = SC_REVERSE_CLIPBOARD_MAX + 1;
    assert(sc_reverse_clipboard_process(&r, true, &callbacks, &f, output) == 8 && output[1] == SC_CLIPBOARD_TOO_LARGE);
    for (unsigned i = 8; i < sizeof(output); ++i) assert(!output[i]);
    f.read = "\xc0\xaf"; f.read_length = 2;
    assert(sc_reverse_clipboard_process(&r, true, &callbacks, &f, output) == 8 && output[1] == SC_CLIPBOARD_UNAVAILABLE);
    f.read_length = 0; assert(sc_reverse_clipboard_process(&r, true, &callbacks, &f, output) == 8 && !output[1]);
    r.op = SC_CLIPBOARD_WRITE; r.length = 4; memcpy(r.text, "text", 4);
    assert(sc_reverse_clipboard_process(&r, true, &callbacks, &f, output) == 8 && !output[1]); assert(f.writes == 1 && !f.pastes && !memcmp(f.written, "text", 4));
    r.op = SC_CLIPBOARD_PASTE; f.fail_write = true;
    assert(sc_reverse_clipboard_process(&r, true, &callbacks, &f, output) == 8 && output[1] == SC_CLIPBOARD_UNAVAILABLE && !f.pastes);
    f.fail_write = false; f.fail_paste = true;
    assert(sc_reverse_clipboard_process(&r, true, &callbacks, &f, output) == 8 && output[1] == SC_CLIPBOARD_PASTE_FAILED && f.pastes == 1);
    f.fail_paste = false; assert(sc_reverse_clipboard_process(&r, true, &callbacks, &f, output) == 8 && !output[1] && f.pastes == 2);
    int writes = f.writes; r.length = 0; assert(!sc_reverse_clipboard_process(&r, true, &callbacks, &f, output));
    r.length = 1; r.text[0] = 0; assert(!sc_reverse_clipboard_process(&r, true, &callbacks, &f, output));
    assert(f.writes == writes); r.id = 0; assert(!sc_reverse_clipboard_process(&r, true, &callbacks, &f, output));
    return 0;
}

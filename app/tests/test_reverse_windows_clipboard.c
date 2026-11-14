// Compile the production adapter with in-memory clipboard/allocation calls.
// Only the UTF-8/UTF-16 conversions call Windows; no OS clipboard is opened.
#include <windows.h>
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>
#include "reverse_windows_clipboard.h"

struct memory {
    void *bytes;
    size_t size;
    bool locked, transferred;
};
static struct {
    struct memory read, *allocated;
    unsigned opens, closes, gets, empties, sets, allocs, frees, locks, unlocks;
    unsigned mb_calls, wc_calls, fail_mb, fail_wc;
    bool open, emptied, no_data, fail_open, fail_empty, fail_set, fail_alloc, fail_lock;
} f;
static HWND owner(void) { return (HWND) &f; }
static void reset(void) {
    assert(!f.open && !f.read.locked && (!f.allocated || !f.allocated->locked));
    free(f.read.bytes);
    if (f.allocated) { free(f.allocated->bytes); free(f.allocated); }
    memset(&f, 0, sizeof(f));
}
static void read_value(const wchar_t *value, size_t bytes) {
    reset(); f.read.bytes = calloc(1, bytes ? bytes : 1); assert(f.read.bytes);
    f.read.size = bytes; if (bytes) memcpy(f.read.bytes, value, bytes);
}
static struct memory *memory(HANDLE handle) {
    struct memory *block = (struct memory *) handle;
    assert(block == &f.read || block == f.allocated); return block;
}
static BOOL fake_open(HWND window) {
    assert(window == owner() && !f.open); ++f.opens;
    if (f.fail_open) return FALSE;
    f.open = true; return TRUE;
}
static BOOL fake_close(void) {
    assert(f.open && !f.read.locked && (!f.allocated || !f.allocated->locked));
    f.open = false; ++f.closes; return TRUE;
}
static HANDLE fake_get(UINT format) {
    assert(f.open && format == CF_UNICODETEXT); ++f.gets;
    return f.no_data ? NULL : (HANDLE) &f.read;
}
static SIZE_T fake_size(HGLOBAL data) { return memory(data)->size; }
static LPVOID fake_lock(HGLOBAL data) {
    struct memory *block = memory(data); assert(!block->locked); ++f.locks;
    if (f.fail_lock) return NULL;
    block->locked = true; return block->bytes;
}
static BOOL fake_unlock(HGLOBAL data) {
    struct memory *block = memory(data); assert(block->locked);
    block->locked = false; ++f.unlocks;
    return FALSE; // Normal final-unlock return is zero, not a failed copy.
}
static HGLOBAL fake_alloc(UINT flags, SIZE_T bytes) {
    assert(flags == (GMEM_MOVEABLE | GMEM_ZEROINIT));
    assert(bytes > 0 && bytes <= (SC_REVERSE_CLIPBOARD_MAX + 1) * sizeof(wchar_t));
    assert(!f.allocated); ++f.allocs;
    if (f.fail_alloc) return NULL;
    f.allocated = calloc(1, sizeof(*f.allocated)); assert(f.allocated);
    f.allocated->bytes = calloc(1, bytes); assert(f.allocated->bytes);
    f.allocated->size = bytes; return (HGLOBAL) f.allocated;
}
static HGLOBAL fake_free(HGLOBAL data) {
    struct memory *block = memory(data);
    assert(block == f.allocated && !block->locked && !block->transferred);
    ++f.frees; free(block->bytes); free(block); f.allocated = NULL; return NULL;
}
static BOOL fake_empty(void) {
    assert(f.open); ++f.empties;
    if (f.fail_empty) return FALSE;
    f.emptied = true; return TRUE;
}
static HANDLE fake_set(UINT format, HANDLE data) {
    struct memory *block = memory(data);
    assert(f.open && f.emptied && format == CF_UNICODETEXT && !block->locked);
    ++f.sets; if (f.fail_set) return NULL;
    block->transferred = true; return data;
}
static int convert_mb(UINT page, DWORD flags, LPCCH input, int length,
                      LPWSTR output, int capacity) {
    assert(page == CP_UTF8 && flags == MB_ERR_INVALID_CHARS);
    if (++f.mb_calls == f.fail_mb) return 0;
    return MultiByteToWideChar(page, flags, input, length, output, capacity);
}
static int convert_wc(UINT page, DWORD flags, LPCWCH input, int length,
                      LPSTR output, int capacity, LPCCH fallback, LPBOOL used) {
    assert(page == CP_UTF8 && flags == WC_ERR_INVALID_CHARS && !fallback && !used);
    if (++f.wc_calls == f.fail_wc) return 0;
    return WideCharToMultiByte(page, flags, input, length, output, capacity, fallback, used);
}

#define OpenClipboard fake_open
#define CloseClipboard fake_close
#define GetClipboardData fake_get
#define EmptyClipboard fake_empty
#define SetClipboardData fake_set
#define GlobalSize fake_size
#define GlobalLock fake_lock
#define GlobalUnlock fake_unlock
#define GlobalAlloc fake_alloc
#define GlobalFree fake_free
#define MultiByteToWideChar convert_mb
#define WideCharToMultiByte convert_wc
#include "../src/reverse_windows_clipboard.c"

static const char sample[] = "caf\xc3\xa9 \xe4\xb8\x96\xe7\x95\x8c \xf0\x9f\x99\x82";
static const wchar_t wide_sample[] = L"caf\u00e9 \u4e16\u754c \U0001f642";
struct output { uint8_t before; char text[SC_REVERSE_CLIPBOARD_MAX]; uint8_t after; };
static enum sc_clipboard_status read_clip(struct output *output, size_t *length) {
    memset(output, 0xa5, sizeof(*output)); *length = 123;
    enum sc_clipboard_status result = sc_windows_clipboard_read(owner(), output->text, length);
    assert(output->before == 0xa5 && output->after == 0xa5);
    assert(!f.open && f.closes == 1 && f.locks == f.unlocks);
    return result;
}
static void reads(void) {
    struct output output; size_t length;
    read_value(wide_sample, sizeof(wide_sample));
    assert(read_clip(&output, &length) == SC_CLIPBOARD_OK);
    assert(length == sizeof(sample) - 1 && !memcmp(output.text, sample, length));
    assert(f.gets == 1 && f.wc_calls == 2 && !f.allocs && !f.frees);
    // GlobalSize may include rounded allocator space beyond the string's NUL.
    wchar_t rounded[32] = L"ok";
    read_value(rounded, sizeof(rounded) - 1);
    assert(read_clip(&output, &length) == SC_CLIPBOARD_OK && length == 2);
    assert(!memcmp(output.text, "ok", 2));
    read_value(L"", sizeof(wchar_t));
    assert(read_clip(&output, &length) == SC_CLIPBOARD_OK && !length && !f.wc_calls);
    read_value(L"", 0);
    assert(read_clip(&output, &length) == SC_CLIPBOARD_UNAVAILABLE && !length && !f.locks);
    read_value(wide_sample, sizeof(wide_sample)); f.no_data = true;
    assert(read_clip(&output, &length) == SC_CLIPBOARD_UNAVAILABLE && !length && !f.locks);
    wchar_t missing_nul[] = { L'a', L'b' };
    read_value(missing_nul, sizeof(missing_nul));
    assert(read_clip(&output, &length) == SC_CLIPBOARD_UNAVAILABLE && !length);
    wchar_t surrogate[] = { 0xd800, 0 };
    read_value(surrogate, sizeof(surrogate));
    assert(read_clip(&output, &length) == SC_CLIPBOARD_UNAVAILABLE && !length);
    // A failed conversion query/copy still unlocks and closes the clipboard.
    for (unsigned call = 1; call <= 2; ++call) {
        read_value(wide_sample, sizeof(wide_sample)); f.fail_wc = call;
        assert(read_clip(&output, &length) == SC_CLIPBOARD_UNAVAILABLE && !length);
    }
    read_value(wide_sample, sizeof(wide_sample)); f.fail_lock = true;
    memset(&output, 0xa5, sizeof(output)); length = 123;
    assert(sc_windows_clipboard_read(owner(), output.text, &length) == SC_CLIPBOARD_UNAVAILABLE && !length);
    assert(f.locks == 1 && !f.unlocks && f.closes == 1 && !f.open);
    read_value(wide_sample, sizeof(wide_sample)); f.fail_open = true; length = 123;
    assert(sc_windows_clipboard_read(owner(), output.text, &length) == SC_CLIPBOARD_UNAVAILABLE && !length);
    assert(f.opens == 1 && !f.closes && !f.gets && !f.locks);
    reset(); length = 123;
    assert(sc_windows_clipboard_read(NULL, output.text, &length) == SC_CLIPBOARD_UNAVAILABLE && !length && !f.opens);
}
static void bounds(void) {
    struct output output; size_t length;
    wchar_t maximum[SC_REVERSE_CLIPBOARD_MAX + 1];
    for (size_t i = 0; i < SC_REVERSE_CLIPBOARD_MAX; ++i) maximum[i] = L'x';
    maximum[SC_REVERSE_CLIPBOARD_MAX] = 0;
    read_value(maximum, sizeof(maximum));
    assert(read_clip(&output, &length) == SC_CLIPBOARD_OK && length == SC_REVERSE_CLIPBOARD_MAX);
    for (size_t i = 0; i < length; ++i) assert(output.text[i] == 'x');
    maximum[SC_REVERSE_CLIPBOARD_MAX] = L'x';
    read_value(maximum, sizeof(maximum));
    assert(read_clip(&output, &length) == SC_CLIPBOARD_TOO_LARGE && !length && !f.wc_calls);
    wchar_t multibyte[2049];
    for (size_t i = 0; i < 2048; ++i) multibyte[i] = 0x4e16;
    multibyte[2048] = 0;
    read_value(multibyte, sizeof(multibyte));
    assert(read_clip(&output, &length) == SC_CLIPBOARD_TOO_LARGE && !length && f.wc_calls == 1);
    assert((unsigned char) output.text[0] == 0xa5);
}
static void writes(void) {
    reset();
    assert(sc_windows_clipboard_write(owner(), sample, sizeof(sample) - 1));
    assert(f.allocs == 1 && !f.frees && f.opens == 1 && f.closes == 1 && f.empties == 1 && f.sets == 1);
    assert(f.allocated && f.allocated->transferred && f.allocated->size == sizeof(wide_sample));
    assert(!memcmp(f.allocated->bytes, wide_sample, sizeof(wide_sample)));
    reset(); assert(!sc_windows_clipboard_write(NULL, "a", 1) && !f.opens && !f.allocs);
    assert(!sc_windows_clipboard_write(owner(), "", 0) && !f.opens && !f.allocs);
    assert(!sc_windows_clipboard_write(owner(), "a", SC_REVERSE_CLIPBOARD_MAX + 1) && !f.opens && !f.allocs);
    assert(!sc_windows_clipboard_write(owner(), "\xc0\xaf", 2) && !f.opens && !f.allocs);
    // Allocation/lock/conversion failures must occur before emptying the board.
    for (unsigned failure = 0; failure < 4; ++failure) {
        reset();
        if (failure == 0) f.fail_alloc = true;
        if (failure == 1) f.fail_lock = true;
        if (failure == 2) f.fail_mb = 1;
        if (failure == 3) f.fail_mb = 2;
        assert(!sc_windows_clipboard_write(owner(), sample, sizeof(sample) - 1));
        assert(!f.allocated && !f.opens && !f.empties && !f.sets);
        assert(f.frees == (failure == 1 || failure == 3 ? 1u : 0u));
    }
    for (unsigned failure = 0; failure < 3; ++failure) {
        reset();
        if (failure == 0) f.fail_open = true;
        if (failure == 1) f.fail_empty = true;
        if (failure == 2) f.fail_set = true;
        assert(!sc_windows_clipboard_write(owner(), sample, sizeof(sample) - 1));
        assert(!f.allocated && f.allocs == 1 && f.frees == 1 && !f.open);
        assert(f.closes == (failure ? 1u : 0u));
        assert(f.empties == (failure ? 1u : 0u));
        assert(f.sets == (failure == 2 ? 1u : 0u));
    }
    char maximum[SC_REVERSE_CLIPBOARD_MAX]; memset(maximum, 'x', sizeof(maximum));
    reset(); assert(sc_windows_clipboard_write(owner(), maximum, sizeof(maximum)));
    assert(f.allocated->size == (SC_REVERSE_CLIPBOARD_MAX + 1) * sizeof(wchar_t));
    assert(((wchar_t *) f.allocated->bytes)[SC_REVERSE_CLIPBOARD_MAX] == 0 && !f.frees);
}
int main(void) {
    assert(sizeof(wchar_t) == 2);
    reads(); bounds(); writes(); reset(); return 0;
}

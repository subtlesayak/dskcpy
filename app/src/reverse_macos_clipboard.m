#include "reverse_macos_clipboard.h"
#include <string.h>
enum sc_clipboard_status sc_macos_clipboard_read(NSPasteboard *board, char *text, size_t *length) {
    *length = 0;
    NSString *value = [board stringForType:NSPasteboardTypeString];
    if (!value) return SC_CLIPBOARD_UNAVAILABLE;
    if (value.length > SC_REVERSE_CLIPBOARD_MAX) return SC_CLIPBOARD_TOO_LARGE;
    NSData *bytes = [value dataUsingEncoding:NSUTF8StringEncoding allowLossyConversion:NO];
    if (!bytes) return SC_CLIPBOARD_UNAVAILABLE;
    if (bytes.length > SC_REVERSE_CLIPBOARD_MAX) return SC_CLIPBOARD_TOO_LARGE;
    if (bytes.length) memcpy(text, bytes.bytes, bytes.length);
    *length = bytes.length; return SC_CLIPBOARD_OK;
}
bool sc_macos_clipboard_write(NSPasteboard *board, const char *text, size_t length) {
    if (!length || length > SC_REVERSE_CLIPBOARD_MAX) return false;
    NSString *value = [[NSString alloc] initWithBytes:text length:length encoding:NSUTF8StringEncoding];
    if (!value) return false;
    NSPasteboardItem *item = [NSPasteboardItem new];
    if (![item setString:value forType:NSPasteboardTypeString]) return false;
    [board clearContents];
    return [board writeObjects:@[item]];
}

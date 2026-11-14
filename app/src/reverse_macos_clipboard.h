#ifndef SC_REVERSE_MACOS_CLIPBOARD_H
#define SC_REVERSE_MACOS_CLIPBOARD_H
#import <Cocoa/Cocoa.h>
#include "reverse_clipboard.h"
// Caller supplies the board; tests use a unique disposable board, never general.
enum sc_clipboard_status sc_macos_clipboard_read(NSPasteboard *board, char *text, size_t *length);
bool sc_macos_clipboard_write(NSPasteboard *board, const char *text, size_t length);
#endif

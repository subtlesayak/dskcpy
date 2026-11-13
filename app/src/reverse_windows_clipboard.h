#ifndef SC_REVERSE_WINDOWS_CLIPBOARD_H
#define SC_REVERSE_WINDOWS_CLIPBOARD_H
#ifdef _WIN32
#include <windows.h>
#include "reverse_clipboard.h"
enum sc_clipboard_status sc_windows_clipboard_read(HWND owner, char *text, size_t *length);
bool sc_windows_clipboard_write(HWND owner, const char *text, size_t length);
#endif
#endif

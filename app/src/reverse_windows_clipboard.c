#include "reverse_windows_clipboard.h"
#ifdef _WIN32
enum sc_clipboard_status sc_windows_clipboard_read(HWND owner, char *text, size_t *length) {
    *length = 0;
    if (!owner || !OpenClipboard(owner)) return SC_CLIPBOARD_UNAVAILABLE;
    enum sc_clipboard_status status = SC_CLIPBOARD_UNAVAILABLE;
    HANDLE data = GetClipboardData(CF_UNICODETEXT);
    SIZE_T bytes = data ? GlobalSize(data) : 0;
    if (bytes >= sizeof(wchar_t)) {
        const wchar_t *wide = GlobalLock(data);
        if (wide) {
            size_t capacity = bytes / sizeof(wchar_t), count = 0;
            if (capacity > SC_REVERSE_CLIPBOARD_MAX + 1) capacity = SC_REVERSE_CLIPBOARD_MAX + 1;
            while (count < capacity && wide[count]) ++count;
            if (count < capacity) {
                int size = count ? WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, wide, (int)count, NULL, 0, NULL, NULL) : 0;
                if (!count) status = SC_CLIPBOARD_OK;
                else if (size > SC_REVERSE_CLIPBOARD_MAX) status = SC_CLIPBOARD_TOO_LARGE;
                else if (size > 0 && WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, wide, (int)count, text, size, NULL, NULL) == size) {
                    *length = (size_t)size; status = SC_CLIPBOARD_OK;
                }
            } else if (count == SC_REVERSE_CLIPBOARD_MAX + 1) status = SC_CLIPBOARD_TOO_LARGE;
            GlobalUnlock(data);
        }
    }
    CloseClipboard(); return status;
}
bool sc_windows_clipboard_write(HWND owner, const char *text, size_t length) {
    if (!owner || !length || length > SC_REVERSE_CLIPBOARD_MAX) return false;
    int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text, (int)length, NULL, 0);
    if (count <= 0 || count > SC_REVERSE_CLIPBOARD_MAX) return false;
    HGLOBAL data = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, ((size_t)count + 1) * sizeof(wchar_t));
    if (!data) return false;
    wchar_t *wide = GlobalLock(data);
    bool converted = wide && MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text, (int)length, wide, count) == count;
    if (wide) GlobalUnlock(data);
    if (!converted || !OpenClipboard(owner)) { GlobalFree(data); return false; }
    bool transferred = EmptyClipboard() && SetClipboardData(CF_UNICODETEXT, data) != NULL;
    CloseClipboard();
    if (!transferred) GlobalFree(data); // Windows owns it only after successful SetClipboardData.
    return transferred;
}
#endif

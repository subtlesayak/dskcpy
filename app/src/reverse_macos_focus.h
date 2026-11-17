#ifndef SC_REVERSE_MACOS_FOCUS_H
#define SC_REVERSE_MACOS_FOCUS_H
#include <stdbool.h>
#include <stdint.h>
#include <ApplicationServices/ApplicationServices.h>
// Advisory metadata only. Never reads AXValue, selected text or window titles.
// -1 means unknown/unsupported/permission denied; 0 non-editable; 1 editable.
int sc_reverse_macos_editable_focus(void);
bool sc_reverse_macos_editable_role(CFTypeRef role, CFTypeRef subrole, bool enabled, bool settable);
// Normalized capture-display coordinates only; no text or AX character indices
// cross the native/controller boundary. Missing/unsupported geometry is invalid.
struct sc_reverse_macos_focus_geometry {
    uint16_t x, y, width, height;
    bool caret, valid;
};
bool sc_reverse_macos_focus_rectangle(CGRect rectangle, CGRect display, bool caret,
                                     struct sc_reverse_macos_focus_geometry *out);
int sc_reverse_macos_editable_focus_geometry(CGRect display,
                                            struct sc_reverse_macos_focus_geometry *out);
#endif

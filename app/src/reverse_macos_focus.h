#ifndef SC_REVERSE_MACOS_FOCUS_H
#define SC_REVERSE_MACOS_FOCUS_H
#include <stdbool.h>
#include <ApplicationServices/ApplicationServices.h>
// Advisory metadata only. Never reads AXValue, selected text or window titles.
// -1 means unknown/unsupported/permission denied; 0 non-editable; 1 editable.
int sc_reverse_macos_editable_focus(void);
bool sc_reverse_macos_editable_role(CFTypeRef role, CFTypeRef subrole, bool enabled, bool settable);
#endif

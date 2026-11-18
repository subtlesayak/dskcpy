#ifndef SC_REVERSE_MACOS_POINTER_H
#define SC_REVERSE_MACOS_POINTER_H
#include <stdbool.h>
#include <ApplicationServices/ApplicationServices.h>

typedef CGEventRef (*sc_reverse_macos_mouse_create)(CGEventSourceRef source,
    CGEventType type, CGPoint point, CGMouseButton button);
// Creates both events or none, without posting. Caller releases a successful
// pair. The constructor seam lets tests exercise allocation failure safely.
bool sc_reverse_macos_pointer_prepare(CGPoint point, CGEventRef events[2],
    sc_reverse_macos_mouse_create create);
#endif

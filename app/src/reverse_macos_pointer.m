#include "reverse_macos_pointer.h"

bool
sc_reverse_macos_pointer_prepare(CGPoint point, CGEventRef events[2],
    sc_reverse_macos_mouse_create create) {
    events[0] = events[1] = NULL;
    CGEventRef down = create(NULL, kCGEventRightMouseDown, point, kCGMouseButtonRight);
    if (!down) return false;
    CGEventRef up = create(NULL, kCGEventRightMouseUp, point, kCGMouseButtonRight);
    if (!up) { CFRelease(down); return false; }
    CGEventSetIntegerValueField(down, kCGMouseEventClickState, 1);
    CGEventSetIntegerValueField(up, kCGMouseEventClickState, 1);
    events[0] = down; events[1] = up;
    return true;
}

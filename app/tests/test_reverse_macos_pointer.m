#include <assert.h>
#include "reverse_macos_pointer.h"

static unsigned calls, fail_at;
static CGEventRef create(CGEventSourceRef source, CGEventType type, CGPoint point, CGMouseButton button) {
    assert(source == NULL && button == kCGMouseButtonRight);
    ++calls; if (calls == fail_at) return NULL;
    return CGEventCreateMouseEvent(source, type, point, button);
}
int main(void) {
    CGEventRef events[2]; CGPoint point = CGPointMake(-123, 456);
    for (unsigned failure = 1; failure <= 2; ++failure) {
        calls = 0; fail_at = failure;
        assert(!sc_reverse_macos_pointer_prepare(point, events, create));
        assert(!events[0] && !events[1] && calls == failure);
    }
    calls = 0; fail_at = 0;
    assert(sc_reverse_macos_pointer_prepare(point, events, create));
    assert(calls == 2 && CGEventGetType(events[0]) == kCGEventRightMouseDown && CGEventGetType(events[1]) == kCGEventRightMouseUp);
    for (unsigned i = 0; i < 2; ++i) {
        assert(CGEventGetIntegerValueField(events[i], kCGMouseEventButtonNumber) == kCGMouseButtonRight);
        assert(CGEventGetIntegerValueField(events[i], kCGMouseEventClickState) == 1);
        assert(CGPointEqualToPoint(CGEventGetLocation(events[i]), point));
        CFRelease(events[i]);
    }
    return 0; // Construction only: never calls CGEventPost or permission APIs.
}

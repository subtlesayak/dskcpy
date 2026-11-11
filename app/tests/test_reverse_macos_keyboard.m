#include <assert.h>
#include <string.h>
#include <Carbon/Carbon.h>
#include "reverse_macos_keyboard.h"

// Construct real CoreGraphics events without posting input or requesting access.
int main(void) {
    CGEventRef event = sc_reverse_macos_key_event(4, true, 8, false);
    assert(event && CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode) == kVK_ANSI_A);
    assert(CGEventGetType(event) == kCGEventKeyDown);
    assert(CGEventGetFlags(event) & kCGEventFlagMaskCommand); CFRelease(event);
    event = sc_reverse_macos_key_event(4, false, 0, false);
    assert(event && CGEventGetType(event) == kCGEventKeyUp && !CGEventGetFlags(event)); CFRelease(event);
    event = sc_reverse_macos_key_event(80, true, 3, true);
    assert(event && CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode) == kVK_LeftArrow);
    assert(CGEventGetIntegerValueField(event, kCGKeyboardEventAutorepeat) == 1);
    assert(CGEventGetFlags(event) & kCGEventFlagMaskControl);
    assert(CGEventGetFlags(event) & kCGEventFlagMaskShift); CFRelease(event);
    assert(!sc_reverse_macos_key_event(0xffff, true, 0, false));
    assert(!sc_reverse_macos_key_event(0, true, 0, false));
    UniChar text[512], copy[512];
    for (unsigned i = 0; i < 512; ++i) text[i] = i % 2 ? 0x65e5 : 'x';
    event = CGEventCreateKeyboardEvent(NULL, 0, true);
    CGEventKeyboardSetUnicodeString(event, 512, text);
    UniCharCount length = 0; CGEventKeyboardGetUnicodeString(event, 512, &length, copy);
    assert(length == 512 && !memcmp(text, copy, sizeof(text))); CFRelease(event);
    return 0;
}

#import <Cocoa/Cocoa.h>
#include "reverse_macos_focus.h"
#include <math.h>
#include <limits.h>
#include <string.h>

bool sc_reverse_macos_focus_rectangle(CGRect rectangle, CGRect display, bool caret,
                                     struct sc_reverse_macos_focus_geometry *out) {
    if (!out) return false;
    memset(out, 0, sizeof(*out));
    double values[] = { rectangle.origin.x, rectangle.origin.y, rectangle.size.width, rectangle.size.height,
        display.origin.x, display.origin.y, display.size.width, display.size.height,
        CGRectGetMaxX(rectangle), CGRectGetMaxY(rectangle), CGRectGetMaxX(display), CGRectGetMaxY(display) };
    for (unsigned i = 0; i < sizeof(values) / sizeof(values[0]); ++i) if (!isfinite(values[i])) return false;
    if (display.size.width <= 0 || display.size.height <= 0 || rectangle.size.height <= 0
            || rectangle.size.width < 0 || (!caret && rectangle.size.width == 0)
            || CGRectGetMaxX(display) <= display.origin.x || CGRectGetMaxY(display) <= display.origin.y) return false;
    // Some providers report a zero-width insertion caret. Keep it visible in
    // logical screen coordinates; physical Retina pixel sizes are not involved.
    if (caret && rectangle.size.width == 0) {
        if (rectangle.origin.x < display.origin.x || rectangle.origin.x >= CGRectGetMaxX(display)) return false;
        rectangle.origin.x -= .5; rectangle.size.width = 1;
    }
    CGRect clipped = CGRectIntersection(rectangle, display);
    if (CGRectIsNull(clipped) || CGRectIsEmpty(clipped)) return false;
    double left = (CGRectGetMinX(clipped) - display.origin.x) / display.size.width;
    double top = (CGRectGetMinY(clipped) - display.origin.y) / display.size.height;
    double right = (CGRectGetMaxX(clipped) - display.origin.x) / display.size.width;
    double bottom = (CGRectGetMaxY(clipped) - display.origin.y) / display.size.height;
    if (!isfinite(left) || !isfinite(top) || !isfinite(right) || !isfinite(bottom)) return false;
    unsigned x = (unsigned)floor(fmax(0, fmin(1, left)) * 65535);
    unsigned y = (unsigned)floor(fmax(0, fmin(1, top)) * 65535);
    unsigned x2 = (unsigned)ceil(fmax(0, fmin(1, right)) * 65535);
    unsigned y2 = (unsigned)ceil(fmax(0, fmin(1, bottom)) * 65535);
    if (x == 65535) x = 65534;
    if (y == 65535) y = 65534;
    if (x2 <= x) x2 = x + 1;
    if (y2 <= y) y2 = y + 1;
    *out = (struct sc_reverse_macos_focus_geometry){ x, y, x2 - x, y2 - y, caret, true };
    return true;
}

static void focus_geometry(AXUIElementRef element, CGRect display,
                           struct sc_reverse_macos_focus_geometry *out) {
    // AXSelectedTextRange is an index pair, not selected text. Ask for a
    // zero-length insertion range; never request AXValue or text contents.
    CFTypeRef selected = NULL, bounds = NULL, position = NULL, size = NULL;
    AXValueRef caret = NULL;
    CFRange range;
    bool supplied_caret = false;
    if (AXUIElementCopyAttributeValue(element, kAXSelectedTextRangeAttribute, &selected) == kAXErrorSuccess
            && selected && CFGetTypeID(selected) == AXValueGetTypeID()
            && AXValueGetType((AXValueRef)selected) == kAXValueCFRangeType
            && AXValueGetValue((AXValueRef)selected, kAXValueCFRangeType, &range)
            && range.location >= 0 && range.length >= 0 && range.length <= LONG_MAX - range.location) {
        range.length = 0;
        caret = AXValueCreate(kAXValueCFRangeType, &range);
        if (caret && AXUIElementCopyParameterizedAttributeValue(element, kAXBoundsForRangeParameterizedAttribute, caret, &bounds) == kAXErrorSuccess
                && bounds && CFGetTypeID(bounds) == AXValueGetTypeID() && AXValueGetType((AXValueRef)bounds) == kAXValueCGRectType) {
            CGRect rect;
            if (AXValueGetValue((AXValueRef)bounds, kAXValueCGRectType, &rect)) {
                supplied_caret = true;
                sc_reverse_macos_focus_rectangle(rect, display, true, out);
            }
        }
    }
    // A known off-display/invalid caret stays absent. Only unsupported range
    // providers fall back to the visible editable element's rectangle.
    if (!supplied_caret
            && AXUIElementCopyAttributeValue(element, kAXPositionAttribute, &position) == kAXErrorSuccess
            && position && CFGetTypeID(position) == AXValueGetTypeID() && AXValueGetType((AXValueRef)position) == kAXValueCGPointType
            && AXUIElementCopyAttributeValue(element, kAXSizeAttribute, &size) == kAXErrorSuccess
            && size && CFGetTypeID(size) == AXValueGetTypeID() && AXValueGetType((AXValueRef)size) == kAXValueCGSizeType) {
        CGPoint origin; CGSize dimensions;
        if (AXValueGetValue((AXValueRef)position, kAXValueCGPointType, &origin)
                && AXValueGetValue((AXValueRef)size, kAXValueCGSizeType, &dimensions))
            sc_reverse_macos_focus_rectangle((CGRect){ origin, dimensions }, display, false, out);
    }
    if (size) CFRelease(size); if (position) CFRelease(position);
    if (bounds) CFRelease(bounds); if (caret) CFRelease(caret); if (selected) CFRelease(selected);
}

bool sc_reverse_macos_editable_role(CFTypeRef role, CFTypeRef subrole, bool enabled, bool settable) {
    if (!enabled || !settable || !role || CFGetTypeID(role) != CFStringGetTypeID()) return false;
    if (subrole && CFEqual(subrole, kAXSecureTextFieldSubrole)) return false;
    return CFEqual(role, kAXTextFieldRole) || CFEqual(role, kAXTextAreaRole) || CFEqual(role, kAXComboBoxRole);
}

static int editable_focus(const CGRect *display, struct sc_reverse_macos_focus_geometry *out) {
    if (out) memset(out, 0, sizeof(*out));
    if (!AXIsProcessTrusted()) return -1;
    @autoreleasepool {
        NSRunningApplication *front = NSWorkspace.sharedWorkspace.frontmostApplication;
        if (!front) return -1;
        AXUIElementRef app = AXUIElementCreateApplication(front.processIdentifier);
        if (!app) return -1;
        AXUIElementSetMessagingTimeout(app, display ? 0.01f : 0.03f);
        CFTypeRef focused = NULL, role = NULL, subrole = NULL, enabled = NULL;
        int result = -1;
        if (AXUIElementCopyAttributeValue(app, kAXFocusedUIElementAttribute, &focused) == kAXErrorSuccess
                && focused && CFGetTypeID(focused) == AXUIElementGetTypeID()) {
            AXUIElementRef element = (AXUIElementRef)focused;
            AXUIElementSetMessagingTimeout(element, display ? 0.01f : 0.03f);
            Boolean settable = false;
            if (AXUIElementCopyAttributeValue(element, kAXRoleAttribute, &role) == kAXErrorSuccess
                    && AXUIElementCopyAttributeValue(element, kAXEnabledAttribute, &enabled) == kAXErrorSuccess
                    && AXUIElementIsAttributeSettable(element, kAXValueAttribute, &settable) == kAXErrorSuccess) {
                // Subrole is optional for ordinary controls; a failed read is
                // unknown, rather than accidentally classifying a secure field.
                AXError sub = AXUIElementCopyAttributeValue(element, kAXSubroleAttribute, &subrole);
                if ((sub == kAXErrorSuccess || sub == kAXErrorNoValue || sub == kAXErrorAttributeUnsupported)
                        && (!subrole || CFGetTypeID(subrole) == CFStringGetTypeID()))
                    result = sc_reverse_macos_editable_role(role, subrole, enabled == kCFBooleanTrue, settable);
            }
            if (display && out && result == 1) focus_geometry(element, *display, out);
            if (display) {
                CFTypeRef current = NULL;
                NSRunningApplication *now = NSWorkspace.sharedWorkspace.frontmostApplication;
                bool same = AXIsProcessTrusted() && now && now.processIdentifier == front.processIdentifier
                    && AXUIElementCopyAttributeValue(app, kAXFocusedUIElementAttribute, &current) == kAXErrorSuccess
                    && current && CFGetTypeID(current) == AXUIElementGetTypeID() && CFEqual(current, focused);
                if (!same) { result = -1; if (out) memset(out, 0, sizeof(*out)); }
                if (current) CFRelease(current);
            }
        }
        if (enabled) CFRelease(enabled); if (subrole) CFRelease(subrole);
        if (role) CFRelease(role); if (focused) CFRelease(focused); CFRelease(app);
        return result;
    }
}

int sc_reverse_macos_editable_focus(void) { return editable_focus(NULL, NULL); }
int sc_reverse_macos_editable_focus_geometry(CGRect display, struct sc_reverse_macos_focus_geometry *out) {
    if (!out) return -1;
    memset(out, 0, sizeof(*out));
    if (!isfinite(display.origin.x) || !isfinite(display.origin.y)
            || !isfinite(display.size.width) || !isfinite(display.size.height)
            || display.size.width <= 0 || display.size.height <= 0
            || !isfinite(CGRectGetMaxX(display)) || !isfinite(CGRectGetMaxY(display))
            || CGRectGetMaxX(display) <= display.origin.x || CGRectGetMaxY(display) <= display.origin.y) return -1;
    return editable_focus(&display, out);
}

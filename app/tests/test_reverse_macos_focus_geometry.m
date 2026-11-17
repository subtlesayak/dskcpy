#import <Cocoa/Cocoa.h>
#include <assert.h>
#include <math.h>
#include <limits.h>
#include <string.h>
#include "reverse_macos_focus.h"

// Compile the actual query implementation against fixed in-memory AX/front-app
// stand-ins. No real focus, text, permission, capture or input APIs are called.
static struct {
    bool trusted, enabled, settable, secure, range_missing, bounds_missing;
    bool invalid_range_type, invalid_position_type, invalid_subrole_type, switch_front, switch_focus, revoke;
    unsigned trust_reads, front_reads, focus_reads, range_reads, parameter_reads, geometry_reads;
    CFStringRef role;
    CFRange selection;
    CGRect caret, field;
} fixture;

@interface FocusFixtureApp : NSObject
@property pid_t processIdentifier;
@end
@implementation FocusFixtureApp
@end
@interface FocusFixtureWorkspace : NSObject
+ (instancetype)sharedWorkspace;
- (NSRunningApplication *)frontmostApplication;
@end
@implementation FocusFixtureWorkspace
+ (instancetype)sharedWorkspace { static FocusFixtureWorkspace *value; if (!value) value = [self new]; return value; }
- (NSRunningApplication *)frontmostApplication {
    FocusFixtureApp *app = [FocusFixtureApp new];
    ++fixture.front_reads;
    app.processIdentifier = fixture.switch_front && fixture.front_reads > 1 ? 101 : 100;
    return (NSRunningApplication *)app;
}
@end

static Boolean fixture_trusted(void) { ++fixture.trust_reads; return fixture.trusted && !(fixture.revoke && fixture.trust_reads > 1); }
static AXUIElementRef fixture_app(pid_t pid) { assert(pid == 100); return (AXUIElementRef)CFRetain(CFSTR("app")); }
static CFTypeID fixture_element_type(void) { return CFStringGetTypeID(); }
static AXError fixture_timeout(AXUIElementRef element, float seconds) { (void)element; assert(seconds == .01f || seconds == .03f); return kAXErrorSuccess; }
static AXError fixture_settable(AXUIElementRef element, CFStringRef attribute, Boolean *value) {
    (void)element; assert(CFEqual(attribute, kAXValueAttribute)); *value = fixture.settable; return kAXErrorSuccess;
}
static AXError fixture_attribute(AXUIElementRef element, CFStringRef attribute, CFTypeRef *value) {
    *value = NULL;
    if (CFEqual(attribute, kAXFocusedUIElementAttribute)) {
        assert(CFEqual(element, CFSTR("app")));
        ++fixture.focus_reads;
        bool changed = fixture.switch_focus && fixture.focus_reads > 1;
        *value = CFRetain(changed ? CFSTR("other-field") : CFSTR("field"));
    } else if (CFEqual(attribute, kAXRoleAttribute)) *value = CFRetain(fixture.role);
    else if (CFEqual(attribute, kAXSubroleAttribute)) {
        if (fixture.invalid_subrole_type) { *value = CFRetain(kCFBooleanTrue); return kAXErrorSuccess; }
        if (!fixture.secure) return kAXErrorNoValue;
        *value = CFRetain(kAXSecureTextFieldSubrole);
    } else if (CFEqual(attribute, kAXEnabledAttribute)) *value = CFRetain(fixture.enabled ? kCFBooleanTrue : kCFBooleanFalse);
    else if (CFEqual(attribute, kAXSelectedTextRangeAttribute)) {
        ++fixture.range_reads;
        if (fixture.range_missing) return kAXErrorAttributeUnsupported;
        *value = fixture.invalid_range_type ? CFRetain(kCFBooleanTrue) : AXValueCreate(kAXValueCFRangeType, &fixture.selection);
    } else if (CFEqual(attribute, kAXPositionAttribute)) {
        ++fixture.geometry_reads;
        *value = fixture.invalid_position_type ? CFRetain(kCFBooleanTrue) : AXValueCreate(kAXValueCGPointType, &fixture.field.origin);
    } else if (CFEqual(attribute, kAXSizeAttribute)) {
        ++fixture.geometry_reads; *value = AXValueCreate(kAXValueCGSizeType, &fixture.field.size);
    } else {
        // In particular, AXValue and selected/attributed/RTF text are forbidden.
        assert(!"Unexpected AX attribute or private content read");
    }
    return kAXErrorSuccess;
}
static AXError fixture_parameter(AXUIElementRef element, CFStringRef attribute, CFTypeRef parameter, CFTypeRef *value) {
    (void)element; ++fixture.parameter_reads;
    assert(CFEqual(attribute, kAXBoundsForRangeParameterizedAttribute));
    CFRange range; assert(AXValueGetValue((AXValueRef)parameter, kAXValueCFRangeType, &range));
    assert(range.location == fixture.selection.location && range.length == 0);
    *value = NULL;
    if (fixture.bounds_missing) return kAXErrorParameterizedAttributeUnsupported;
    *value = AXValueCreate(kAXValueCGRectType, &fixture.caret); return kAXErrorSuccess;
}

#define NSWorkspace FocusFixtureWorkspace
#define AXIsProcessTrusted fixture_trusted
#define AXUIElementCreateApplication fixture_app
#define AXUIElementGetTypeID fixture_element_type
#define AXUIElementSetMessagingTimeout fixture_timeout
#define AXUIElementIsAttributeSettable fixture_settable
#define AXUIElementCopyAttributeValue fixture_attribute
#define AXUIElementCopyParameterizedAttributeValue fixture_parameter
#include "reverse_macos_focus.m"

static void reset(void) {
    memset(&fixture, 0, sizeof(fixture));
    fixture.trusted = fixture.enabled = fixture.settable = true;
    fixture.role = kAXTextFieldRole; fixture.selection = CFRangeMake(4, 3);
    fixture.caret = CGRectMake(100, 200, 0, 20); fixture.field = CGRectMake(80, 180, 400, 40);
}

int main(void) { @autoreleasepool {
    CGRect display = CGRectMake(0, 0, 1920, 1080);
    struct sc_reverse_macos_focus_geometry target;
    assert(sc_reverse_macos_focus_rectangle(CGRectMake(-960, 640, 100, 20), CGRectMake(-1920, 100, 1920, 1080), false, &target));
    assert(target.valid && !target.caret && target.x == 32767 && target.y == 32767 && target.width > 0 && target.height > 0);
    assert((unsigned)target.x + target.width <= 65535 && (unsigned)target.y + target.height <= 65535);
    assert(sc_reverse_macos_focus_rectangle(CGRectMake(-10, -10, 30, 30), display, false, &target));
    assert(target.x == 0 && target.y == 0 && target.valid);
    assert(!sc_reverse_macos_focus_rectangle(CGRectMake(2000, 0, 2, 20), display, true, &target) && !target.valid);
    assert(!sc_reverse_macos_focus_rectangle(CGRectMake(100, 200, 0, 20), display, false, &target));
    assert(sc_reverse_macos_focus_rectangle(CGRectMake(100, 200, 0, 20), display, true, &target) && target.width > 0);
    assert(!sc_reverse_macos_focus_rectangle(CGRectMake(NAN, 1, 1, 1), display, true, &target));
    assert(!sc_reverse_macos_focus_rectangle(CGRectMake(1, 1, -1, 1), display, true, &target));
    assert(!sc_reverse_macos_focus_rectangle(CGRectMake(1, 1, 1, INFINITY), display, true, &target));

    reset(); assert(sc_reverse_macos_editable_focus_geometry(display, &target) == 1 && target.valid && target.caret);
    assert(fixture.range_reads == 1 && fixture.parameter_reads == 1 && fixture.geometry_reads == 0);
    reset(); fixture.range_missing = true;
    assert(sc_reverse_macos_editable_focus_geometry(display, &target) == 1 && target.valid && !target.caret);
    assert(fixture.parameter_reads == 0 && fixture.geometry_reads == 2);
    reset(); fixture.bounds_missing = true;
    assert(sc_reverse_macos_editable_focus_geometry(display, &target) == 1 && target.valid && !target.caret);
    reset(); fixture.invalid_range_type = fixture.invalid_position_type = true;
    assert(sc_reverse_macos_editable_focus_geometry(display, &target) == 1 && !target.valid && fixture.parameter_reads == 0);
    reset(); fixture.selection = CFRangeMake(LONG_MAX, 1);
    assert(sc_reverse_macos_editable_focus_geometry(display, &target) == 1 && fixture.parameter_reads == 0);
    reset(); fixture.caret = CGRectMake(2500, 200, 0, 20);
    assert(sc_reverse_macos_editable_focus_geometry(display, &target) == 1 && !target.valid && fixture.geometry_reads == 0);

    reset(); fixture.secure = true;
    assert(sc_reverse_macos_editable_focus_geometry(display, &target) == 0 && !target.valid && !fixture.range_reads && !fixture.geometry_reads);
    reset(); fixture.role = kAXButtonRole;
    assert(sc_reverse_macos_editable_focus_geometry(display, &target) == 0 && !fixture.range_reads);
    reset(); fixture.invalid_subrole_type = true;
    assert(sc_reverse_macos_editable_focus_geometry(display, &target) == -1 && !target.valid && !fixture.range_reads);
    reset(); fixture.enabled = false;
    assert(sc_reverse_macos_editable_focus_geometry(display, &target) == 0 && !fixture.range_reads);
    reset(); fixture.trusted = false;
    assert(sc_reverse_macos_editable_focus_geometry(display, &target) == -1 && !target.valid && !fixture.front_reads && !fixture.range_reads);
    reset(); fixture.revoke = true;
    assert(sc_reverse_macos_editable_focus_geometry(display, &target) == -1 && !target.valid);
    reset(); fixture.switch_front = true;
    assert(sc_reverse_macos_editable_focus_geometry(display, &target) == -1 && !target.valid);
    reset(); fixture.switch_focus = true;
    assert(sc_reverse_macos_editable_focus_geometry(display, &target) == -1 && !target.valid);
    reset(); assert(sc_reverse_macos_editable_focus_geometry(CGRectZero, &target) == -1 && !fixture.range_reads);
    reset(); assert(sc_reverse_macos_editable_focus() == 1 && !fixture.range_reads && !fixture.parameter_reads && !fixture.geometry_reads);
    return 0;
} }

#import <Cocoa/Cocoa.h>
#include "reverse_macos_focus.h"

bool sc_reverse_macos_editable_role(CFTypeRef role, CFTypeRef subrole, bool enabled, bool settable) {
    if (!enabled || !settable || !role || CFGetTypeID(role) != CFStringGetTypeID()) return false;
    if (subrole && CFEqual(subrole, kAXSecureTextFieldSubrole)) return false;
    return CFEqual(role, kAXTextFieldRole) || CFEqual(role, kAXTextAreaRole) || CFEqual(role, kAXComboBoxRole);
}

int sc_reverse_macos_editable_focus(void) {
    if (!AXIsProcessTrusted()) return -1;
    @autoreleasepool {
        NSRunningApplication *front = NSWorkspace.sharedWorkspace.frontmostApplication;
        if (!front) return -1;
        AXUIElementRef app = AXUIElementCreateApplication(front.processIdentifier);
        if (!app) return -1;
        AXUIElementSetMessagingTimeout(app, 0.03f);
        CFTypeRef focused = NULL, role = NULL, subrole = NULL, enabled = NULL;
        int result = -1;
        if (AXUIElementCopyAttributeValue(app, kAXFocusedUIElementAttribute, &focused) == kAXErrorSuccess
                && focused && CFGetTypeID(focused) == AXUIElementGetTypeID()) {
            AXUIElementRef element = (AXUIElementRef)focused;
            AXUIElementSetMessagingTimeout(element, 0.03f);
            Boolean settable = false;
            if (AXUIElementCopyAttributeValue(element, kAXRoleAttribute, &role) == kAXErrorSuccess
                    && AXUIElementCopyAttributeValue(element, kAXEnabledAttribute, &enabled) == kAXErrorSuccess
                    && AXUIElementIsAttributeSettable(element, kAXValueAttribute, &settable) == kAXErrorSuccess) {
                // Subrole is optional for ordinary controls; a failed read is
                // unknown, rather than accidentally classifying a secure field.
                AXError sub = AXUIElementCopyAttributeValue(element, kAXSubroleAttribute, &subrole);
                if (sub == kAXErrorSuccess || sub == kAXErrorNoValue || sub == kAXErrorAttributeUnsupported)
                    result = sc_reverse_macos_editable_role(role, subrole, enabled == kCFBooleanTrue, settable);
            }
        }
        if (enabled) CFRelease(enabled); if (subrole) CFRelease(subrole);
        if (role) CFRelease(role); if (focused) CFRelease(focused); CFRelease(app);
        return result;
    }
}

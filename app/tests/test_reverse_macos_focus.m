#include <assert.h>
#include "reverse_macos_focus.h"
int main(void) {
    assert(sc_reverse_macos_editable_role(kAXTextFieldRole, NULL, true, true));
    assert(sc_reverse_macos_editable_role(kAXTextAreaRole, NULL, true, true));
    assert(sc_reverse_macos_editable_role(kAXComboBoxRole, NULL, true, true));
    assert(!sc_reverse_macos_editable_role(kAXTextFieldRole, kAXSecureTextFieldSubrole, true, true));
    assert(!sc_reverse_macos_editable_role(kAXTextFieldRole, NULL, false, true));
    assert(!sc_reverse_macos_editable_role(kAXTextFieldRole, NULL, true, false));
    assert(!sc_reverse_macos_editable_role(kAXStaticTextRole, NULL, true, true));
    assert(!sc_reverse_macos_editable_role(kAXButtonRole, NULL, true, true));
    assert(!sc_reverse_macos_editable_role(NULL, NULL, true, true));
    assert(!sc_reverse_macos_editable_role(kCFBooleanTrue, NULL, true, true));
    return 0;
}

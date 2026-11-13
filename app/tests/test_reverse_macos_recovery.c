#include <assert.h>
#include <string.h>
#include "reverse_macos_recovery.h"
int main(void) {
    assert(!strcmp(sc_macos_capture_recovery_reason(SC_MACOS_DISPLAY_CHANGED,true,false,false,true),"display-change"));
    assert(!strcmp(sc_macos_capture_recovery_reason(SC_MACOS_SLEEP,true,false,false,true),"sleep"));
    for (unsigned reason=0;reason<4;reason++) {
        assert(!sc_macos_capture_recovery_reason(reason,false,false,false,true));
        assert(!sc_macos_capture_recovery_reason(reason,true,true,false,true));
        assert(!sc_macos_capture_recovery_reason(reason,true,false,true,true));
        assert(!sc_macos_capture_recovery_reason(reason,true,false,false,false));
    }
    assert(!sc_macos_capture_recovery_reason(SC_MACOS_CAPTURE_UNCHANGED,true,false,false,true));
    assert(!sc_macos_capture_recovery_reason(99,true,false,false,true));
    return 0;
}

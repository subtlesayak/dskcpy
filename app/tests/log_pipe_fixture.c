#include "common.h"

#include <stdio.h>

#include "util/log.h"

// No capture or device connection: exercise the production logger with fully
// buffered stdout, as used by non-Windows child processes launched with pipes.
// The Node test sends e/m to publish fixture telemetry and q to release the
// process. Output must be observable BEFORE q/EOF flushes stdio on exit.
int
main(void) {
    static char buffer[8192];
    if (setvbuf(stdout, buffer, _IOFBF, sizeof(buffer))) {
        return 1;
    }
    sc_set_log_level(SC_LOG_LEVEL_DEBUG);
    sc_log_configure();
    int command;
    while ((command = getchar()) != EOF && command != 'q') {
        if (command == 'e') {
            LOGI("Reverse display encoder: h264_videotoolbox");
        } else if (command == 'm') {
            LOGD("Reverse display capture-to-decode round-trip: 12.5 ms");
        }
    }
    return 0;
}

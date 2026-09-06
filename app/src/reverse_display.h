#ifndef SC_REVERSE_DISPLAY_H
#define SC_REVERSE_DISPLAY_H

#include "common.h"

#include <stdbool.h>

#include "scrcpy.h"
#include "util/net.h"

/**
 * Run desktop -> Android reverse display mode.
 *
 * The function owns the video and control sockets for the duration of the
 * mode, but does not close them; the regular server cleanup closes them.
 */
enum scrcpy_exit_code
sc_reverse_display_run(sc_socket video_socket, sc_socket control_socket,
                        const struct scrcpy_options *options);

#ifdef HAVE_REVERSE_MACOS
enum scrcpy_exit_code
sc_reverse_display_macos_run(sc_socket video_socket, sc_socket control_socket,
                             const struct scrcpy_options *options);
#endif

#endif

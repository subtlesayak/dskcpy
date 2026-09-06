#include "common.h"

#include <assert.h>
#include <string.h>

#include "cli.h"
#include "options.h"

static void test_flag_version(void) {
    struct scrcpy_cli_args args = {
        .opts = scrcpy_options_default,
        .help = false,
        .version = false,
    };

    char *argv[] = {"scrcpy", "-v"};

    bool ok = scrcpy_parse_args(&args, 2, argv);
    assert(ok);
    assert(!args.help);
    assert(args.version);
}

static void test_flag_help(void) {
    struct scrcpy_cli_args args = {
        .opts = scrcpy_options_default,
        .help = false,
        .version = false,
    };

    char *argv[] = {"scrcpy", "-v"};

    bool ok = scrcpy_parse_args(&args, 2, argv);
    assert(ok);
    assert(!args.help);
    assert(args.version);
}

static void test_options(void) {
    struct scrcpy_cli_args args = {
        .opts = scrcpy_options_default,
        .help = false,
        .version = false,
    };

    char *argv[] = {
        "scrcpy",
        "--always-on-top",
        "--video-bit-rate", "5M",
        "--crop", "100:200:300:400",
        "--fullscreen",
        "--max-fps", "30",
        "--max-size", "1024",
        // "--no-control" is not compatible with "--turn-screen-off"
        // "--no-playback" is not compatible with "--fulscreen"
        "--port", "1234:1236",
        "--push-target", "/sdcard/Movies",
        "--record", "file",
        "--record-format", "mkv",
        "--serial", "0123456789abcdef",
        "--show-touches",
        "--turn-screen-off",
        "--prefer-text",
        "--window-title", "my device",
        "--window-x", "100",
        "--window-y", "-1",
        "--window-width", "600",
        "--window-height", "0",
        "--window-borderless",
    };

    bool ok = scrcpy_parse_args(&args, ARRAY_LEN(argv), argv);
    assert(ok);

    const struct scrcpy_options *opts = &args.opts;
    assert(opts->always_on_top);
    assert(opts->video_bit_rate == 5000000);
    assert(!strcmp(opts->crop, "100:200:300:400"));
    assert(opts->fullscreen);
    assert(!strcmp(opts->max_fps, "30"));
    assert(opts->max_size == 1024);
    assert(opts->port_range.first == 1234);
    assert(opts->port_range.last == 1236);
    assert(!strcmp(opts->push_target, "/sdcard/Movies"));
    assert(!strcmp(opts->record_filename, "file"));
    assert(opts->record_format == SC_RECORD_FORMAT_MKV);
    assert(!strcmp(opts->serial, "0123456789abcdef"));
    assert(opts->show_touches);
    assert(opts->turn_screen_off);
    assert(opts->key_inject_mode == SC_KEY_INJECT_MODE_TEXT);
    assert(!strcmp(opts->window_title, "my device"));
    assert(opts->window_x == 100);
    assert(opts->window_y == -1);
    assert(opts->window_width == 600);
    assert(opts->window_height == 0);
    assert(opts->window_borderless);
}

static void test_options2(void) {
    struct scrcpy_cli_args args = {
        .opts = scrcpy_options_default,
        .help = false,
        .version = false,
    };

    char *argv[] = {
        "scrcpy",
        "--no-control",
        "--no-playback",
        "--record", "file.mp4", // cannot enable --no-playback without recording
    };

    bool ok = scrcpy_parse_args(&args, ARRAY_LEN(argv), argv);
    assert(ok);

    const struct scrcpy_options *opts = &args.opts;
    assert(!opts->control);
    assert(!opts->video_playback);
    assert(!opts->audio_playback);
    assert(!strcmp(opts->record_filename, "file.mp4"));
    assert(opts->record_format == SC_RECORD_FORMAT_MP4);
}

static void test_parse_shortcut_mods(void) {
    uint8_t mods;
    bool ok;

    ok = sc_parse_shortcut_mods("lctrl", &mods);
    assert(ok);
    assert(mods == SC_SHORTCUT_MOD_LCTRL);

    ok = sc_parse_shortcut_mods("rctrl,lalt", &mods);
    assert(ok);
    assert(mods == (SC_SHORTCUT_MOD_RCTRL | SC_SHORTCUT_MOD_LALT));

    ok = sc_parse_shortcut_mods("lsuper,rsuper,lctrl", &mods);
    assert(ok);
    assert(mods == (SC_SHORTCUT_MOD_LSUPER
                  | SC_SHORTCUT_MOD_RSUPER
                  | SC_SHORTCUT_MOD_LCTRL));

    ok = sc_parse_shortcut_mods("", &mods);
    assert(!ok);

    ok = sc_parse_shortcut_mods("lctrl+", &mods);
    assert(!ok);

    ok = sc_parse_shortcut_mods("lctrl,", &mods);
    assert(!ok);
}

static void test_reverse_audio_option(void) {
    struct scrcpy_cli_args args = {.opts = scrcpy_options_default};
    char *enabled[] = {"scrcpy", "--reverse-display"};
    assert(scrcpy_parse_args(&args, 2, enabled));
    assert(args.opts.reverse_audio);
    assert(!args.opts.audio); // Never open Android->desktop capture by accident.
    args.opts = scrcpy_options_default;
    char *disabled[] = {"scrcpy", "--no-audio", "--reverse-display"};
    assert(scrcpy_parse_args(&args, 3, disabled));
    assert(!args.opts.reverse_audio);
    args.opts = scrcpy_options_default;
    char *disabled_after[] = {"scrcpy", "--reverse-display", "--no-audio"};
    assert(scrcpy_parse_args(&args, 3, disabled_after));
    assert(!args.opts.reverse_audio);
}

static void test_connection_usb(void) {
    struct scrcpy_cli_args args = {
        .opts = scrcpy_options_default,
    };
    char *argv[] = {"scrcpy", "--connection=usb"};

    bool ok = scrcpy_parse_args(&args, ARRAY_LEN(argv), argv);
    assert(ok);
    assert(args.opts.select_usb);
    assert(!args.opts.select_tcpip);
    assert(!args.opts.tcpip);
}

static void test_connection_wifi(void) {
    struct scrcpy_cli_args args = {
        .opts = scrcpy_options_default,
    };
    char *argv[] = {"scrcpy", "--connection=wifi"};

    bool ok = scrcpy_parse_args(&args, ARRAY_LEN(argv), argv);
    assert(ok);
    assert(args.opts.tcpip);
    assert(!args.opts.tcpip_dst);
}

static void test_connection_ip(void) {
    struct scrcpy_cli_args args = {
        .opts = scrcpy_options_default,
    };
    char *argv[] = {"scrcpy", "--connection=ip:192.168.1.10:5555"};

    bool ok = scrcpy_parse_args(&args, ARRAY_LEN(argv), argv);
    assert(ok);
    assert(args.opts.tcpip);
    assert(!strcmp(args.opts.tcpip_dst, "192.168.1.10:5555"));
}

static void test_connection_invalid(void) {
    struct scrcpy_cli_args args = {
        .opts = scrcpy_options_default,
    };
    char *argv[] = {"scrcpy", "--connection=bluetooth"};

    bool ok = scrcpy_parse_args(&args, ARRAY_LEN(argv), argv);
    assert(!ok);
}

static void test_connection_conflict(void) {
    struct scrcpy_cli_args args = {
        .opts = scrcpy_options_default,
    };
    char *argv[] = {"scrcpy", "--connection=usb", "--tcpip"};

    bool ok = scrcpy_parse_args(&args, ARRAY_LEN(argv), argv);
    assert(!ok);
}

static void test_reverse_socket(void) {
    struct scrcpy_cli_args args = {.opts = scrcpy_options_default};
    char *argv[] = {"scrcpy", "--reverse-display", "--reverse-socket=43210"};
    bool ok = scrcpy_parse_args(&args, ARRAY_LEN(argv), argv);
#if defined(_WIN32) || defined(HAVE_REVERSE_MACOS)
    assert(ok);
    assert(args.opts.reverse_socket == 43210);
    assert(!args.opts.serial && !args.opts.tcpip && !args.opts.select_usb);
#else
    assert(!ok);
#endif
    struct scrcpy_cli_args invalid = {.opts = scrcpy_options_default};
    char *zero[] = {"scrcpy", "--reverse-display", "--reverse-socket=0"};
    assert(!scrcpy_parse_args(&invalid, ARRAY_LEN(zero), zero));
    invalid.opts = scrcpy_options_default;
    char *conflict[] = {"scrcpy", "--reverse-display", "--reverse-socket=1234", "--connection=wifi"};
    assert(!scrcpy_parse_args(&invalid, ARRAY_LEN(conflict), conflict));
    invalid.opts = scrcpy_options_default;
    char *missing_mode[] = {"scrcpy", "--reverse-socket=1234"};
    assert(!scrcpy_parse_args(&invalid, ARRAY_LEN(missing_mode), missing_mode));
}

int main(int argc, char *argv[]) {
    (void) argc;
    (void) argv;

    test_flag_version();
    test_flag_help();
    test_options();
    test_options2();
    test_parse_shortcut_mods();
    test_connection_usb();
    test_connection_wifi();
    test_connection_ip();
    test_connection_invalid();
    test_connection_conflict();
    test_reverse_socket();
    test_reverse_audio_option();
    return 0;
}

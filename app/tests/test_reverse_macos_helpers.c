#include <assert.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>
#include "reverse_macos_helpers.h"
#include "reverse_watchdog.h"

struct pause_fixture {
    bool paused, mouse_held, key_held;
    unsigned transitions, keyframes, audio_epoch;
    struct sc_reverse_watchdog watchdog;
};
static void transition(void *context, bool paused) {
    struct pause_fixture *f = context;
    f->paused = paused; f->mouse_held = f->key_held = false;
    ++f->transitions; ++f->audio_epoch;
    sc_reverse_watchdog_set_paused(&f->watchdog, paused, 100);
}
static void keyframe(void *context) { ++((struct pause_fixture *)context)->keyframes; }
static void test_pause_dispatch(void) {
    const struct sc_reverse_macos_pause_callbacks callbacks = {transition, keyframe};
    struct pause_fixture f = {.mouse_held = true, .key_held = true};
    sc_reverse_watchdog_init(&f.watchdog);
    sc_reverse_watchdog_begin(&f.watchdog, 10);
    sc_reverse_watchdog_submit(&f.watchdog, 1);
    sc_reverse_watchdog_end(&f.watchdog);
    int64_t deadline = f.watchdog.deadline;
    // Browser buffered-output recovery repeatedly uses active Resume for IDRs.
    for (unsigned i = 0; i < 10000; ++i) {
        sc_reverse_macos_pause(f.paused, false, &callbacks, &f);
        assert(!f.audio_epoch && !f.transitions && f.mouse_held && f.key_held);
        assert(f.keyframes == i + 1 && f.watchdog.deadline == deadline);
    }
    sc_reverse_macos_pause(f.paused, true, &callbacks, &f);
    assert(f.paused && f.audio_epoch == 1 && !f.mouse_held && !f.key_held);
    for (unsigned i = 0; i < 10; ++i) sc_reverse_macos_pause(f.paused, true, &callbacks, &f);
    assert(f.transitions == 1 && f.audio_epoch == 1 && f.keyframes == 10000);
    // Rapid true pause/resume still retires both epochs, even between polls.
    sc_reverse_macos_pause(f.paused, false, &callbacks, &f);
    assert(!f.paused && f.transitions == 2 && f.audio_epoch == 2 && f.keyframes == 10001);
    f.mouse_held = f.key_held = true;
    sc_reverse_macos_pause(f.paused, false, &callbacks, &f);
    assert(f.audio_epoch == 2 && f.mouse_held && f.key_held && f.keyframes == 10002);
}

int main(void) {
    test_pause_dispatch();
    uint16_t w, h;
    double lx, ly, lw, lh;
    assert(sc_reverse_macos_letterbox(800, 800, 1920, 1080, &lx, &ly, &lw, &lh));
    assert(lx == 420 && ly == 0 && lw == 1080 && lh == 1080);
    assert(sc_reverse_macos_letterbox(1600, 400, 1920, 1080, &lx, &ly, &lw, &lh));
    assert(lx == 0 && ly == 300 && lw == 1920 && lh == 480);
    assert(!sc_reverse_macos_letterbox(NAN, 400, 1920, 1080, &lx, &ly, &lw, &lh));
    assert(sc_reverse_macos_dimensions(3024, 1964, 1920, &w, &h));
    assert(w == 1920 && h == 1246); // Retina MacBook dimensions, even H.264 output.
    assert(sc_reverse_macos_dimensions(1080, 1920, 0, &w, &h));
    assert(w == 1080 && h == 1920);
    assert(!sc_reverse_macos_dimensions(0, 100, 1920, &w, &h));
    assert(!sc_reverse_macos_dimensions(300000, 100, 1920, &w, &h));
    assert(!sc_reverse_macos_dimensions(1920, 1080, 1, &w, &h));
    struct sc_position pos = {.screen_size = {1920, 1080}, .point = {1919, 1079}};
    double x, y;
    assert(sc_reverse_macos_point(&pos, -1512, -100, 1512, 982, &x, &y));
    assert(x == -1 && y == 881);
    pos.point.x = -10; pos.point.y = 9000;
    assert(sc_reverse_macos_point(&pos, -1512, 0, 1512, 982, &x, &y));
    assert(x == -1512 && y == 981);
    assert(!sc_reverse_macos_point(&pos, NAN, 0, 1512, 982, &x, &y));
    pos.screen_size.width = 0;
    assert(!sc_reverse_macos_point(&pos, 0, 0, 1512, 982, &x, &y));
    uint8_t avcc[] = {0, 0, 0, 2, 0x65, 1, 0, 0, 0, 1, 0x61};
    uint8_t expected[] = {0, 0, 0, 1, 0x65, 1, 0, 0, 0, 1, 0x61};
    uint8_t *out; size_t size;
    assert(sc_reverse_macos_annexb(avcc, sizeof(avcc), 4, &out, &size));
    assert(size == sizeof(expected) && !memcmp(out, expected, size)); free(out);
    uint8_t short_nals[] = {1, 0x65, 2, 0x61, 0};
    assert(sc_reverse_macos_annexb(short_nals, sizeof(short_nals), 1, &out, &size)); free(out);
    assert(!sc_reverse_macos_annexb(avcc, sizeof(avcc) - 1, 4, &out, &size));
    uint8_t zero[] = {0, 0, 0, 0};
    assert(!sc_reverse_macos_annexb(zero, sizeof(zero), 4, &out, &size));
    uint8_t huge[] = {255, 255, 255, 255};
    assert(!sc_reverse_macos_annexb(huge, sizeof(huge), 4, &out, &size));
    assert(!sc_reverse_macos_annexb(NULL, 0, 4, &out, &size));
    assert(!sc_reverse_macos_annexb(avcc, sizeof(avcc), 0, &out, &size));
    assert(out == NULL && size == 0);
    return 0;
}

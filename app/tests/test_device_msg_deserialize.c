#include "common.h"

#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "device_msg.h"

static void test_deserialize_clipboard(void) {
    const uint8_t input[] = {
        DEVICE_MSG_TYPE_CLIPBOARD,
        0x00, 0x00, 0x00, 0x03, // text length
        0x41, 0x42, 0x43, // "ABC"
    };

    struct sc_device_msg msg;
    ssize_t r = sc_device_msg_deserialize(input, sizeof(input), &msg);
    assert(r == 8);

    assert(msg.type == DEVICE_MSG_TYPE_CLIPBOARD);
    assert(msg.clipboard.text);
    assert(!strcmp("ABC", msg.clipboard.text));

    sc_device_msg_destroy(&msg);
}

static void test_deserialize_clipboard_big(void) {
    uint8_t input[DEVICE_MSG_MAX_SIZE];
    input[0] = DEVICE_MSG_TYPE_CLIPBOARD;
    input[1] = (DEVICE_MSG_TEXT_MAX_LENGTH & 0xff000000u) >> 24;
    input[2] = (DEVICE_MSG_TEXT_MAX_LENGTH & 0x00ff0000u) >> 16;
    input[3] = (DEVICE_MSG_TEXT_MAX_LENGTH & 0x0000ff00u) >> 8;
    input[4] =  DEVICE_MSG_TEXT_MAX_LENGTH & 0x000000ffu;

    memset(input + 5, 'a', DEVICE_MSG_TEXT_MAX_LENGTH);

    struct sc_device_msg msg;
    ssize_t r = sc_device_msg_deserialize(input, sizeof(input), &msg);
    assert(r == DEVICE_MSG_MAX_SIZE);

    assert(msg.type == DEVICE_MSG_TYPE_CLIPBOARD);
    assert(msg.clipboard.text);
    assert(strlen(msg.clipboard.text) == DEVICE_MSG_TEXT_MAX_LENGTH);
    assert(msg.clipboard.text[0] == 'a');

    sc_device_msg_destroy(&msg);
}

static void test_deserialize_ack_set_clipboard(void) {
    const uint8_t input[] = {
        DEVICE_MSG_TYPE_ACK_CLIPBOARD,
        0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, // sequence
    };

    struct sc_device_msg msg;
    ssize_t r = sc_device_msg_deserialize(input, sizeof(input), &msg);
    assert(r == 9);

    assert(msg.type == DEVICE_MSG_TYPE_ACK_CLIPBOARD);
    assert(msg.ack_clipboard.sequence == UINT64_C(0x0102030405060708));
}

static void test_deserialize_uhid_output(void) {
    const uint8_t input[] = {
        DEVICE_MSG_TYPE_UHID_OUTPUT,
        0, 42, // id
        0, 5, // size
        0x01, 0x02, 0x03, 0x04, 0x05, // data
    };

    struct sc_device_msg msg;
    ssize_t r = sc_device_msg_deserialize(input, sizeof(input), &msg);
    assert(r == 10);

    assert(msg.type == DEVICE_MSG_TYPE_UHID_OUTPUT);
    assert(msg.uhid_output.id == 42);
    assert(msg.uhid_output.size == 5);

    uint8_t expected[] = {1, 2, 3, 4, 5};
    assert(!memcmp(msg.uhid_output.data, expected, sizeof(expected)));

    sc_device_msg_destroy(&msg);
}

static void test_deserialize_reverse_touch(void) {
    const uint8_t input[] = {
        DEVICE_MSG_TYPE_REVERSE_TOUCH,
        AMOTION_EVENT_ACTION_MOVE,
        0, 0, 0, 0, 0, 0, 0, 7, // pointer id
        0, 0, 0, 123, // x
        0, 0, 1, 200, // y
        0x04, 0x38, // width 1080
        0x09, 0x60, // height 2400
        0x80, 0x00, // pressure 0.5
        0, 0, 0, 0, // action button
        0, 0, 0, 1, // buttons
    };

    struct sc_device_msg msg;
    ssize_t r = sc_device_msg_deserialize(input, sizeof(input), &msg);
    assert(r == 32);
    assert(msg.type == DEVICE_MSG_TYPE_REVERSE_TOUCH);
    assert(msg.reverse_touch.action == AMOTION_EVENT_ACTION_MOVE);
    assert(msg.reverse_touch.pointer_id == 7);
    assert(msg.reverse_touch.position.point.x == 123);
    assert(msg.reverse_touch.position.point.y == 456);
    assert(msg.reverse_touch.position.screen_size.width == 1080);
    assert(msg.reverse_touch.position.screen_size.height == 2400);
    assert(msg.reverse_touch.pressure == 0.5f);
    assert(msg.reverse_touch.buttons == AMOTION_EVENT_BUTTON_PRIMARY);
}

static void test_deserialize_reverse_frame_ack(void) {
    const uint8_t input[] = {
        DEVICE_MSG_TYPE_REVERSE_FRAME_ACK,
        0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
    };

    struct sc_device_msg msg;
    ssize_t r = sc_device_msg_deserialize(input, sizeof(input), &msg);
    assert(r == 9);
    assert(msg.type == DEVICE_MSG_TYPE_REVERSE_FRAME_ACK);
    assert(msg.reverse_frame_ack.pts
           == INT64_C(0x0102030405060708));
    uint8_t audio[sizeof(input)];
    memcpy(audio, input, sizeof(input));
    audio[0] = DEVICE_MSG_TYPE_REVERSE_AUDIO_ACK;
    assert(sc_device_msg_deserialize(audio, sizeof(audio), &msg) == 9);
    assert(msg.type == DEVICE_MSG_TYPE_REVERSE_AUDIO_ACK);
    assert(msg.reverse_frame_ack.pts == INT64_C(0x0102030405060708));
    assert(sc_device_msg_deserialize(audio, 8, &msg) == 0);
}

static void test_deserialize_reverse_system_action(void) {
    const uint8_t input[] = {
        DEVICE_MSG_TYPE_REVERSE_SYSTEM_ACTION,
        SC_REVERSE_SYSTEM_ACTION_LOCK,
    };

    struct sc_device_msg msg;
    ssize_t r = sc_device_msg_deserialize(input, sizeof(input), &msg);
    assert(r == 2);
    assert(msg.type == DEVICE_MSG_TYPE_REVERSE_SYSTEM_ACTION);
    assert(msg.reverse_system_action.action == SC_REVERSE_SYSTEM_ACTION_LOCK);
    const uint8_t pause[] = {5, 7};
    assert(sc_device_msg_deserialize(pause, sizeof(pause), &msg) == 2);
    assert(msg.reverse_system_action.action == SC_REVERSE_SYSTEM_ACTION_PAUSE_VIDEO);
    const uint8_t resume[] = {5, 8};
    assert(sc_device_msg_deserialize(resume, sizeof(resume), &msg) == 2);
    assert(msg.reverse_system_action.action == SC_REVERSE_SYSTEM_ACTION_RESUME_VIDEO);
    assert(sc_device_msg_deserialize(resume, 1, &msg) == 0);
}

static void test_deserialize_reverse_scroll(void) {
    uint8_t input[] = {7, 0, 0, 0, 123, 0, 0, 1, 200,
                       0x04, 0x38, 0x09, 0x60,
                       0xff, 0xff, 0xff, 0xd8, 0, 0, 0, 80};
    struct sc_device_msg msg;
    for (size_t n = 0; n < sizeof(input); ++n) {
        assert(sc_device_msg_deserialize(input, n, &msg) == 0);
    }
    assert(sc_device_msg_deserialize(input, sizeof(input), &msg) == 21);
    assert(msg.type == DEVICE_MSG_TYPE_REVERSE_SCROLL);
    assert(msg.reverse_scroll.position.point.x == 123);
    assert(msg.reverse_scroll.position.point.y == 456);
    assert(msg.reverse_scroll.position.screen_size.width == 1080);
    assert(msg.reverse_scroll.position.screen_size.height == 2400);
    assert(msg.reverse_scroll.dx == -40);
    assert(msg.reverse_scroll.dy == 80);
    input[20] = 121;
    assert(sc_device_msg_deserialize(input, sizeof(input), &msg) == -1);
}

static void test_reverse_keyboard(void) {
    struct sc_device_msg msg;
    uint8_t key[] = {8, 0, 0, 4, 8};
    for (unsigned n = 0; n < sizeof(key); ++n) assert(sc_device_msg_deserialize(key, n, &msg) == 0);
    assert(sc_device_msg_deserialize(key, sizeof(key), &msg) == 5);
    assert(msg.reverse_key.usage == 4 && msg.reverse_key.modifiers == 8);
    key[1] = 2; assert(sc_device_msg_deserialize(key, sizeof(key), &msg) == -1);
    key[3] = key[4] = 0; assert(sc_device_msg_deserialize(key, sizeof(key), &msg) == 5);
    const uint8_t unicode[] = {9, 0, 4, 0xf0, 0x9f, 0x91, 0x8b};
    for (unsigned n = 0; n < sizeof(unicode); ++n) assert(sc_device_msg_deserialize(unicode, n, &msg) == 0);
    assert(sc_device_msg_deserialize(unicode, sizeof(unicode), &msg) == sizeof(unicode));
    assert(msg.reverse_text.length == 4 && !memcmp(msg.reverse_text.text, unicode + 3, 4));
    const uint8_t invalid[][7] = {{9,0,1,0}, {9,0,2,0xc0,0x80}, {9,0,3,0xed,0xa0,0x80},
        {9,0,4,0xf4,0x90,0x80,0x80}, {9,2,1,0,0,0,0}, {9,0,1,0x1b}};
    for (unsigned i = 0; i < sizeof(invalid)/sizeof(*invalid); ++i)
        assert(sc_device_msg_deserialize(invalid[i], sizeof(*invalid), &msg) == -1);
    uint8_t maximum[515] = {9,2,0}; memset(maximum + 3, 'x', 512);
    assert(sc_device_msg_deserialize(maximum, sizeof(maximum), &msg) == 515);
    sc_device_msg_destroy(&msg);
}

int main(int argc, char *argv[]) {
    (void) argc;
    (void) argv;

    test_deserialize_clipboard();
    test_deserialize_clipboard_big();
    test_deserialize_ack_set_clipboard();
    test_deserialize_uhid_output();
    test_deserialize_reverse_touch();
    test_deserialize_reverse_frame_ack();
    test_deserialize_reverse_system_action();
    test_deserialize_reverse_scroll();
    test_reverse_keyboard();
    return 0;
}

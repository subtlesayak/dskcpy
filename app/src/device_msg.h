#ifndef SC_DEVICEMSG_H
#define SC_DEVICEMSG_H

#include "common.h"

#include <stddef.h>
#include <stdint.h>
#include <sys/types.h>

#include "android/input.h"
#include "coords.h"

#define DEVICE_MSG_MAX_SIZE (1 << 18) // 256k
// type: 1 byte; length: 4 bytes
#define DEVICE_MSG_TEXT_MAX_LENGTH (DEVICE_MSG_MAX_SIZE - 5)

enum sc_device_msg_type {
    DEVICE_MSG_TYPE_CLIPBOARD,
    DEVICE_MSG_TYPE_ACK_CLIPBOARD,
    DEVICE_MSG_TYPE_UHID_OUTPUT,
    DEVICE_MSG_TYPE_REVERSE_TOUCH,
    DEVICE_MSG_TYPE_REVERSE_FRAME_ACK,
    DEVICE_MSG_TYPE_REVERSE_SYSTEM_ACTION,
    DEVICE_MSG_TYPE_REVERSE_AUDIO_ACK,
    DEVICE_MSG_TYPE_REVERSE_SCROLL,
};

enum sc_reverse_system_action {
    SC_REVERSE_SYSTEM_ACTION_VOLUME_DOWN,
    SC_REVERSE_SYSTEM_ACTION_VOLUME_UP,
    SC_REVERSE_SYSTEM_ACTION_VOLUME_MUTE,
    SC_REVERSE_SYSTEM_ACTION_MINIMIZE,
    SC_REVERSE_SYSTEM_ACTION_MAXIMIZE_RESTORE,
    SC_REVERSE_SYSTEM_ACTION_CLOSE,
    SC_REVERSE_SYSTEM_ACTION_LOCK,
    SC_REVERSE_SYSTEM_ACTION_PAUSE_VIDEO,
    SC_REVERSE_SYSTEM_ACTION_RESUME_VIDEO,
    SC_REVERSE_SYSTEM_ACTION_STOP_SESSION,
    SC_REVERSE_SYSTEM_ACTION_AUDIO_ENABLE,
    SC_REVERSE_SYSTEM_ACTION_AUDIO_DISABLE,
};

struct sc_device_msg {
    enum sc_device_msg_type type;
    union {
        struct {
            char *text; // owned, to be freed by free()
        } clipboard;
        struct {
            uint64_t sequence;
        } ack_clipboard;
        struct {
            uint16_t id;
            uint16_t size;
            uint8_t *data; // owned, to be freed by free()
        } uhid_output;
        struct {
            enum android_motionevent_action action;
            uint64_t pointer_id;
            struct sc_position position;
            float pressure;
            enum android_motionevent_buttons action_button;
            enum android_motionevent_buttons buttons;
        } reverse_touch;
        struct {
            struct sc_position position;
            // Viewport pixels, positive right/down; bounded to +/-120.
            int32_t dx;
            int32_t dy;
        } reverse_scroll;
        struct {
            int64_t pts;
        } reverse_frame_ack;
        struct {
            enum sc_reverse_system_action action;
        } reverse_system_action;
    };
};

// return the number of bytes consumed (0 for no msg available, -1 on error)
ssize_t
sc_device_msg_deserialize(const uint8_t *buf, size_t len,
                          struct sc_device_msg *msg);

void
sc_device_msg_destroy(struct sc_device_msg *msg);

#endif

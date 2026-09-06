#include "device_msg.h"

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "util/binary.h"
#include "util/log.h"

ssize_t
sc_device_msg_deserialize(const uint8_t *buf, size_t len,
                          struct sc_device_msg *msg) {
    if (!len) {
        return 0; // no message
    }

    msg->type = buf[0];
    switch (msg->type) {
        case DEVICE_MSG_TYPE_CLIPBOARD: {
            if (len < 5) {
                // at least type + empty string length
                return 0; // no complete message
            }
            size_t clipboard_len = sc_read32be(&buf[1]);
            if (clipboard_len > len - 5) {
                return 0; // no complete message
            }
            char *text = malloc(clipboard_len + 1);
            if (!text) {
                LOG_OOM();
                return -1;
            }
            if (clipboard_len) {
                memcpy(text, &buf[5], clipboard_len);
            }
            text[clipboard_len] = '\0';

            msg->clipboard.text = text;
            return 5 + clipboard_len;
        }
        case DEVICE_MSG_TYPE_ACK_CLIPBOARD: {
            if (len < 9) {
                return 0; // no complete message
            }
            uint64_t sequence = sc_read64be(&buf[1]);
            msg->ack_clipboard.sequence = sequence;
            return 9;
        }
        case DEVICE_MSG_TYPE_UHID_OUTPUT: {
            if (len < 5) {
                // at least id + size
                return 0; // not available
            }
            uint16_t id = sc_read16be(&buf[1]);
            size_t size = sc_read16be(&buf[3]);
            if (size > len - 5) {
                return 0; // not available
            }
            uint8_t *data = malloc(size);
            if (!data) {
                LOG_OOM();
                return -1;
            }
            if (size) {
                memcpy(data, &buf[5], size);
            }

            msg->uhid_output.id = id;
            msg->uhid_output.size = size;
            msg->uhid_output.data = data;

            return 5 + size;
        }
        case DEVICE_MSG_TYPE_REVERSE_TOUCH: {
            // type: 1 byte; action: 1; pointer id: 8; position: 12;
            // pressure: 2; action button: 4; buttons: 4
            if (len < 32) {
                return 0; // no complete message
            }

            msg->reverse_touch.action = (enum android_motionevent_action) buf[1];
            msg->reverse_touch.pointer_id = sc_read64be(&buf[2]);
            msg->reverse_touch.position.point.x = (int32_t) sc_read32be(&buf[10]);
            msg->reverse_touch.position.point.y = (int32_t) sc_read32be(&buf[14]);
            msg->reverse_touch.position.screen_size.width = sc_read16be(&buf[18]);
            msg->reverse_touch.position.screen_size.height = sc_read16be(&buf[20]);
            uint16_t pressure = sc_read16be(&buf[22]);
            msg->reverse_touch.pressure = pressure == 0xffff
                                        ? 1.0f : pressure / 65536.0f;
            msg->reverse_touch.action_button =
                (enum android_motionevent_buttons) sc_read32be(&buf[24]);
            msg->reverse_touch.buttons =
                (enum android_motionevent_buttons) sc_read32be(&buf[28]);

            return 32;
        }
        case DEVICE_MSG_TYPE_REVERSE_SCROLL:
            if (len < 21) {
                return 0;
            }
            msg->reverse_scroll.position.point.x = (int32_t) sc_read32be(&buf[1]);
            msg->reverse_scroll.position.point.y = (int32_t) sc_read32be(&buf[5]);
            msg->reverse_scroll.position.screen_size.width = sc_read16be(&buf[9]);
            msg->reverse_scroll.position.screen_size.height = sc_read16be(&buf[11]);
            msg->reverse_scroll.dx = (int32_t) sc_read32be(&buf[13]);
            msg->reverse_scroll.dy = (int32_t) sc_read32be(&buf[17]);
            if (msg->reverse_scroll.dx < -120 || msg->reverse_scroll.dx > 120
                    || msg->reverse_scroll.dy < -120 || msg->reverse_scroll.dy > 120) {
                return -1;
            }
            return 21;
        case DEVICE_MSG_TYPE_REVERSE_FRAME_ACK:
        case DEVICE_MSG_TYPE_REVERSE_AUDIO_ACK:
            if (len < 9) {
                return 0;
            }
            msg->reverse_frame_ack.pts = (int64_t) sc_read64be(&buf[1]);
            return 9;
        case DEVICE_MSG_TYPE_REVERSE_SYSTEM_ACTION:
            if (len < 2) {
                return 0;
            }
            msg->reverse_system_action.action =
                (enum sc_reverse_system_action) buf[1];
            return 2;
        default:
            LOGW("Unknown device message type: %d", (int) msg->type);
            return -1; // error, we cannot recover
    }
}

void
sc_device_msg_destroy(struct sc_device_msg *msg) {
    switch (msg->type) {
        case DEVICE_MSG_TYPE_CLIPBOARD:
            free(msg->clipboard.text);
            break;
        case DEVICE_MSG_TYPE_UHID_OUTPUT:
            free(msg->uhid_output.data);
            break;
        default:
            // nothing to do
            break;
    }
}

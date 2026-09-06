#ifndef SC_REVERSE_AUDIO_H
#define SC_REVERSE_AUDIO_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// SRD1 multiplexed packet flags. Only send after receiver AUDIO_ENABLE.
#define SC_REVERSE_AUDIO_CONFIG 4u
#define SC_REVERSE_AUDIO_PACKET 8u
#define SC_REVERSE_AUDIO_UNAVAILABLE 16u
#define SC_REVERSE_AUDIO_WINDOW 4

struct sc_reverse_audio_callbacks {
    bool (*stopped)(void *userdata);
    bool (*enabled)(void *userdata);
    int64_t (*acked_pts)(void *userdata);
    bool (*send)(void *userdata, const uint8_t *data, size_t size,
                 int64_t pts, uint32_t flags);
};

void sc_reverse_audio_run(const struct sc_reverse_audio_callbacks *cbs, void *userdata);
#endif

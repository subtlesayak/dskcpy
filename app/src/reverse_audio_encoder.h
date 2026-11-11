#ifndef SC_REVERSE_AUDIO_ENCODER_H
#define SC_REVERSE_AUDIO_ENCODER_H

#include "reverse_audio.h"

#define SC_REVERSE_AUDIO_FRAMES 480
#define SC_REVERSE_AUDIO_MAX_AGE_US INT64_C(80000)
#define SC_REVERSE_AUDIO_MAX_CHUNK 4800

struct sc_reverse_audio_encoder;

struct sc_reverse_audio_stats {
    uint64_t packets;
    uint64_t stale_frames;
    uint64_t window_frames;
    uint64_t catchup_frames;
};

// Worker-only bounded feeding: retain the caller's fresh PCM while the existing
// ACK window drains, stop at the age cutoff or cancellation, and never queue
// another PCM copy. The clock is monotonic; wait must yield and return promptly.
struct sc_reverse_audio_wait {
    int64_t (*now)(void *userdata);
    void (*wait)(void *userdata);
    void *userdata;
};

// Single worker owns the encoder. Destroy on mute/pause; do not flush its tail.
struct sc_reverse_audio_encoder *
sc_reverse_audio_encoder_create(const struct sc_reverse_audio_callbacks *cbs,
                               void *userdata);
void sc_reverse_audio_encoder_destroy(struct sc_reverse_audio_encoder *encoder);
void sc_reverse_audio_encoder_discard_partial(struct sc_reverse_audio_encoder *encoder);
// Refresh cumulative ACKs and report conservative PCM capacity in the existing
// bounded packet window. A caller may retain fresh PCM and retry instead of
// asking push() to discard it while the receiver catches up. Never blocks.
size_t sc_reverse_audio_encoder_available_frames(struct sc_reverse_audio_encoder *encoder);
bool sc_reverse_audio_encoder_push(struct sc_reverse_audio_encoder *encoder,
                                  const int16_t *stereo, size_t frames,
                                  int64_t captured_us, int64_t now_us);

bool sc_reverse_audio_encoder_feed(struct sc_reverse_audio_encoder *encoder,
                                  const int16_t *stereo, size_t frames,
                                  int64_t received_us,
                                  const struct sc_reverse_audio_wait *wait);
void sc_reverse_audio_encoder_get_stats(const struct sc_reverse_audio_encoder *encoder,
                                       struct sc_reverse_audio_stats *stats);

// Input is either two Float32 planes or one interleaved stereo buffer.
void sc_reverse_audio_from_float(int16_t *out, const float *left,
                                const float *right, size_t frames, bool planar);
#endif

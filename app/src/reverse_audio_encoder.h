#ifndef SC_REVERSE_AUDIO_ENCODER_H
#define SC_REVERSE_AUDIO_ENCODER_H

#include "reverse_audio.h"

#define SC_REVERSE_AUDIO_FRAMES 480
#define SC_REVERSE_AUDIO_MAX_AGE_US INT64_C(80000)
#define SC_REVERSE_AUDIO_MAX_CHUNK 4800

struct sc_reverse_audio_encoder;

// Single worker owns the encoder. Destroy on mute/pause; do not flush its tail.
struct sc_reverse_audio_encoder *
sc_reverse_audio_encoder_create(const struct sc_reverse_audio_callbacks *cbs,
                               void *userdata);
void sc_reverse_audio_encoder_destroy(struct sc_reverse_audio_encoder *encoder);
void sc_reverse_audio_encoder_discard_partial(struct sc_reverse_audio_encoder *encoder);
bool sc_reverse_audio_encoder_push(struct sc_reverse_audio_encoder *encoder,
                                  const int16_t *stereo, size_t frames,
                                  int64_t captured_us, int64_t now_us);

// Input is either two Float32 planes or one interleaved stereo buffer.
void sc_reverse_audio_from_float(int16_t *out, const float *left,
                                const float *right, size_t frames, bool planar);
#endif

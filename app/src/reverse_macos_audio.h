#ifndef SC_REVERSE_MACOS_AUDIO_H
#define SC_REVERSE_MACOS_AUDIO_H

#include <CoreMedia/CoreMedia.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// out holds at least SC_REVERSE_AUDIO_MAX_CHUNK stereo frames.
bool sc_reverse_macos_audio_pcm(CMSampleBufferRef sample, int16_t *out, size_t *frames);
#endif

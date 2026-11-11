#ifndef SC_REVERSE_MACOS_AUDIO_H
#define SC_REVERSE_MACOS_AUDIO_H

#include <CoreMedia/CoreMedia.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// Capture callbacks must not block on encoding/socket I/O. Retain a small FIFO
// through short worker stalls instead of overwriting every unconsumed chunk.
// The worker still enforces SC_REVERSE_AUDIO_MAX_AGE_US before encoding.
#define SC_REVERSE_MACOS_AUDIO_QUEUE_CAPACITY 4
struct sc_reverse_macos_audio_entry {
    CMSampleBufferRef sample;
    int64_t received_us;
    uint64_t sequence;
};
struct sc_reverse_macos_audio_queue {
    struct sc_reverse_macos_audio_entry entries[SC_REVERSE_MACOS_AUDIO_QUEUE_CAPACITY];
    unsigned head, count;
    uint64_t sequence;
};
// Caller serializes all access. Push retains; pop transfers that retain.
// Returns true when overflow discards the oldest chunk. Clear releases all.
bool sc_reverse_macos_audio_queue_push(struct sc_reverse_macos_audio_queue *queue,
                                      CMSampleBufferRef sample, int64_t received_us);
bool sc_reverse_macos_audio_queue_pop(struct sc_reverse_macos_audio_queue *queue,
                                     struct sc_reverse_macos_audio_entry *entry);
void sc_reverse_macos_audio_queue_clear(struct sc_reverse_macos_audio_queue *queue);

// out holds at least SC_REVERSE_AUDIO_MAX_CHUNK stereo frames.
bool sc_reverse_macos_audio_pcm(CMSampleBufferRef sample, int16_t *out, size_t *frames);
#endif

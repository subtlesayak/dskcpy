#include "reverse_macos_audio.h"
#include "reverse_audio_encoder.h"
#include <stddef.h>
#include <stdlib.h>

bool sc_reverse_macos_audio_queue_push(struct sc_reverse_macos_audio_queue *queue,
                                      CMSampleBufferRef sample, int64_t received_us) {
    bool dropped = queue->count == SC_REVERSE_MACOS_AUDIO_QUEUE_CAPACITY;
    if (dropped) {
        CFRelease(queue->entries[queue->head].sample);
        queue->head = (queue->head + 1) % SC_REVERSE_MACOS_AUDIO_QUEUE_CAPACITY;
        --queue->count;
    }
    unsigned tail = (queue->head + queue->count++) % SC_REVERSE_MACOS_AUDIO_QUEUE_CAPACITY;
    queue->entries[tail] = (struct sc_reverse_macos_audio_entry) {
        .sample = (CMSampleBufferRef) CFRetain(sample),
        .received_us = received_us, .sequence = ++queue->sequence,
    };
    return dropped;
}

bool sc_reverse_macos_audio_queue_pop(struct sc_reverse_macos_audio_queue *queue,
                                     struct sc_reverse_macos_audio_entry *entry) {
    if (!queue->count) return false;
    *entry = queue->entries[queue->head];
    queue->entries[queue->head].sample = NULL;
    queue->head = (queue->head + 1) % SC_REVERSE_MACOS_AUDIO_QUEUE_CAPACITY;
    --queue->count;
    return true;
}

void sc_reverse_macos_audio_queue_clear(struct sc_reverse_macos_audio_queue *queue) {
    struct sc_reverse_macos_audio_entry entry;
    while (sc_reverse_macos_audio_queue_pop(queue, &entry)) CFRelease(entry.sample);
}

bool sc_reverse_macos_audio_pcm(CMSampleBufferRef sample, int16_t *pcm, size_t *frames) {
    if (!sample || !pcm || !frames) return false;
    CMAudioFormatDescriptionRef format = CMSampleBufferGetFormatDescription(sample);
    const AudioStreamBasicDescription *asbd = format ? CMAudioFormatDescriptionGetStreamBasicDescription(format) : NULL;
    if (!asbd || asbd->mFormatID != kAudioFormatLinearPCM || asbd->mSampleRate != 48000
            || asbd->mChannelsPerFrame != 2 || asbd->mBitsPerChannel != 32
            || !(asbd->mFormatFlags & kAudioFormatFlagIsFloat)
            || (asbd->mFormatFlags & kAudioFormatFlagIsBigEndian)) return false;
    CMItemCount count = CMSampleBufferGetNumSamples(sample);
    if (count <= 0 || count > SC_REVERSE_AUDIO_MAX_CHUNK) return false;
    bool planar = asbd->mFormatFlags & kAudioFormatFlagIsNonInterleaved;
    if (asbd->mBytesPerFrame != (planar ? 4u : 8u)) return false;
    // Query CoreMedia's exact list size. Keep the allocation bounded by the
    // two requested channels, rather than guessing an overallocated list size.
    size_t size = 0;
    OSStatus status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sample, &size, NULL, 0,
        kCFAllocatorDefault, kCFAllocatorDefault, kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment, NULL);
    if (status != noErr || size < sizeof(AudioBufferList)
            || size > offsetof(AudioBufferList, mBuffers) + 2 * sizeof(AudioBuffer)) return false;
    AudioBufferList *list = calloc(1, size);
    if (!list) return false;
    CMBlockBufferRef block = NULL;
    status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sample, NULL, list, size,
        kCFAllocatorDefault, kCFAllocatorDefault, kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment, &block);
    bool ok = status == noErr && list->mNumberBuffers == (planar ? 2u : 1u);
    if (ok) {
        for (unsigned i = 0; i < list->mNumberBuffers; ++i) {
            AudioBuffer buffer = list->mBuffers[i];
            if (!buffer.mData || buffer.mNumberChannels != (planar ? 1u : 2u)
                    || buffer.mDataByteSize < (size_t)count * asbd->mBytesPerFrame) ok = false;
        }
    }
    if (ok) {
        sc_reverse_audio_from_float(pcm, list->mBuffers[0].mData,
            planar ? list->mBuffers[1].mData : NULL, (size_t)count, planar);
        *frames = (size_t)count;
    }
    if (block) CFRelease(block);
    free(list);
    return ok;
}

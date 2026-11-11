#include "reverse_macos_audio.h"
#include "reverse_audio_encoder.h"
#include <stddef.h>
#include <stdlib.h>
#include <math.h>
#include <libswresample/swresample.h>
#include <libavutil/channel_layout.h>

void sc_reverse_macos_audio_converter_reset(struct sc_reverse_macos_audio_converter *c) {
    swr_free(&c->resampler); c->rate = c->channels = 0; ++c->generation;
}

bool sc_reverse_macos_audio_convert(struct sc_reverse_macos_audio_converter *c,
                                   CMSampleBufferRef sample, int16_t *out, size_t *frames) {
    if (!sample || !out || !frames) return false;
    *frames = 0;
    CMAudioFormatDescriptionRef format = CMSampleBufferGetFormatDescription(sample);
    const AudioStreamBasicDescription *a = format ? CMAudioFormatDescriptionGetStreamBasicDescription(format) : NULL;
    if (!a || a->mFormatID != kAudioFormatLinearPCM || !isfinite(a->mSampleRate) || a->mSampleRate < 32000 || a->mSampleRate > 192000
            || a->mSampleRate != (unsigned)a->mSampleRate || !a->mChannelsPerFrame || a->mChannelsPerFrame > 2
            || (a->mFormatFlags & kAudioFormatFlagIsBigEndian)) return false;
    if (a->mSampleRate == 48000 && a->mChannelsPerFrame == 2 && a->mBitsPerChannel == 32
            && (a->mFormatFlags & kAudioFormatFlagIsFloat)) {
        if (c->resampler) sc_reverse_macos_audio_converter_reset(c);
        return sc_reverse_macos_audio_pcm(sample, out, frames);
    }
    bool planar = a->mFormatFlags & kAudioFormatFlagIsNonInterleaved;
    enum AVSampleFormat input;
    if (a->mBitsPerChannel == 32 && (a->mFormatFlags & kAudioFormatFlagIsFloat)) input = planar ? AV_SAMPLE_FMT_FLTP : AV_SAMPLE_FMT_FLT;
    else if (a->mBitsPerChannel == 16 && (a->mFormatFlags & kAudioFormatFlagIsSignedInteger)
            && !(a->mFormatFlags & kAudioFormatFlagIsFloat)) input = planar ? AV_SAMPLE_FMT_S16P : AV_SAMPLE_FMT_S16;
    else return false;
    unsigned stride = (a->mBitsPerChannel / 8) * (planar ? 1 : a->mChannelsPerFrame);
    CMItemCount count = CMSampleBufferGetNumSamples(sample);
    if (a->mBytesPerFrame != stride || count <= 0 || count > SC_REVERSE_AUDIO_MAX_CHUNK) return false;
    if (!c->resampler || c->rate != a->mSampleRate || c->channels != a->mChannelsPerFrame || c->format != input) {
        sc_reverse_macos_audio_converter_reset(c);
        AVChannelLayout source, target = AV_CHANNEL_LAYOUT_STEREO;
        av_channel_layout_default(&source, a->mChannelsPerFrame);
        int result = swr_alloc_set_opts2(&c->resampler, &target, AV_SAMPLE_FMT_S16, 48000,
            &source, input, (int)a->mSampleRate, 0, NULL);
        av_channel_layout_uninit(&source);
        if (result < 0 || swr_init(c->resampler) < 0) { sc_reverse_macos_audio_converter_reset(c); return false; }
        c->rate = (unsigned)a->mSampleRate; c->channels = a->mChannelsPerFrame; c->format = input;
    }
    if (swr_get_out_samples(c->resampler, (int)count) > SC_REVERSE_MACOS_AUDIO_OUTPUT_FRAMES) return false;
    size_t capacity = 0;
    OSStatus status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sample, &capacity, NULL, 0,
        kCFAllocatorDefault, kCFAllocatorDefault, kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment, NULL);
    if (status != noErr || capacity < sizeof(AudioBufferList)
            || capacity > offsetof(AudioBufferList, mBuffers) + 2 * sizeof(AudioBuffer)) return false;
    AudioBufferList *list = calloc(1, capacity);
    if (!list) return false;
    CMBlockBufferRef block = NULL;
    status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sample, NULL, list, capacity,
        kCFAllocatorDefault, kCFAllocatorDefault, kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment, &block);
    unsigned buffers = planar ? a->mChannelsPerFrame : 1;
    bool valid = status == noErr && list->mNumberBuffers == buffers;
    const uint8_t *source[2] = {NULL, NULL};
    if (valid) for (unsigned i = 0; i < buffers; ++i) {
        AudioBuffer b = list->mBuffers[i];
        if (!b.mData || b.mNumberChannels != (planar ? 1 : a->mChannelsPerFrame)
                || b.mDataByteSize < (size_t)count * stride) valid = false;
        source[i] = b.mData;
    }
    uint8_t *target[] = {(uint8_t *)out};
    int result = valid ? swr_convert(c->resampler, target, SC_REVERSE_MACOS_AUDIO_OUTPUT_FRAMES, source, (int)count) : -1;
    if (block) CFRelease(block);
    free(list);
    if (result < 0) return false;
    *frames = (size_t)result; return true;
}

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

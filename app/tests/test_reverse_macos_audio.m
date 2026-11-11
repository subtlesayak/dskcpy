#include <assert.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include "reverse_macos_audio.h"
#include "reverse_audio_encoder.h"

// Real CoreMedia buffers, synthetic samples only. No screen/audio permissions,
// microphone, playback device or network is needed by this test.
static CMSampleBufferRef sample_buffer(bool planar, double rate, unsigned channels, unsigned count) {
    AudioStreamBasicDescription asbd = {
        .mSampleRate = rate, .mFormatID = kAudioFormatLinearPCM,
        .mFormatFlags = kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked
            | (planar ? kAudioFormatFlagIsNonInterleaved : 0),
        .mBytesPerPacket = 4 * (planar ? 1 : channels), .mFramesPerPacket = 1,
        .mBytesPerFrame = 4 * (planar ? 1 : channels),
        .mChannelsPerFrame = channels, .mBitsPerChannel = 32,
    };
    CMAudioFormatDescriptionRef format = NULL;
    assert(CMAudioFormatDescriptionCreate(kCFAllocatorDefault, &asbd, 0, NULL, 0, NULL, NULL, &format) == noErr);
    CMSampleTimingInfo timing = {.duration = CMTimeMake(1, (int32_t)rate),
        .presentationTimeStamp = CMTimeMake(0, (int32_t)rate), .decodeTimeStamp = kCMTimeInvalid};
    CMSampleBufferRef sample = NULL;
    size_t sample_size = asbd.mBytesPerFrame;
    assert(CMSampleBufferCreate(kCFAllocatorDefault, NULL, false, NULL, NULL, format,
        count, 1, &timing, 1, &sample_size, &sample) == noErr);
    unsigned buffers = planar ? channels : 1;
    AudioBufferList *list = calloc(1, offsetof(AudioBufferList, mBuffers) + buffers * sizeof(AudioBuffer));
    assert(list); list->mNumberBuffers = buffers;
    for (unsigned i = 0; i < buffers; ++i) {
        unsigned samples = count * (planar ? 1 : channels);
        float *data = malloc(samples * sizeof(float)); assert(data);
        for (unsigned j = 0; j < samples; ++j) data[j] = (planar ? i : j % channels) ? -0.5f : 0.5f;
        list->mBuffers[i] = (AudioBuffer){.mNumberChannels = planar ? 1 : channels,
            .mDataByteSize = samples * sizeof(float), .mData = data};
    }
    assert(CMSampleBufferSetDataBufferFromAudioBufferList(sample, kCFAllocatorDefault,
        kCFAllocatorDefault, kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment, list) == noErr);
    assert(CMSampleBufferSetDataReady(sample) == noErr);
    for (unsigned i = 0; i < buffers; ++i) free(list->mBuffers[i].mData);
    free(list); CFRelease(format);
    return sample;
}

static void test_capture_queue(void) {
    struct sc_reverse_macos_audio_queue queue = {0};
    struct sc_reverse_macos_audio_entry entry;
    assert(!sc_reverse_macos_audio_queue_pop(&queue, &entry));
    // A temporary callback/worker stall preserves chronological PCM, including
    // the retain after the capture callback releases its reference.
    for (unsigned i = 0; i < 4; ++i) {
        CMSampleBufferRef sample = sample_buffer(true, 48000, 2, 480 + i);
        assert(!sc_reverse_macos_audio_queue_push(&queue, sample, 1000 + i));
        CFRelease(sample);
    }
    for (unsigned i = 0; i < 4; ++i) {
        assert(sc_reverse_macos_audio_queue_pop(&queue, &entry));
        assert(entry.sequence == i + 1 && entry.received_us == 1000 + i);
        assert(CMSampleBufferGetNumSamples(entry.sample) == 480 + i);
        CFRelease(entry.sample);
    }
    // A prolonged stall keeps only the bounded newest samples and exposes a
    // sequence gap so callers can discard pre-gap partial Opus frames.
    for (unsigned i = 0; i < 7; ++i) {
        CMSampleBufferRef sample = sample_buffer(true, 48000, 2, 500 + i);
        assert(sc_reverse_macos_audio_queue_push(&queue, sample, 2000 + i) == (i >= 4));
        CFRelease(sample);
    }
    for (unsigned i = 3; i < 7; ++i) {
        assert(sc_reverse_macos_audio_queue_pop(&queue, &entry));
        assert(entry.sequence == 5 + i && entry.received_us == 2000 + i);
        assert(CMSampleBufferGetNumSamples(entry.sample) == 500 + i);
        CFRelease(entry.sample);
    }
    CMSampleBufferRef sample = sample_buffer(true, 48000, 2, 480);
    assert(!sc_reverse_macos_audio_queue_push(&queue, sample, 3000));
    CFRelease(sample);
    sc_reverse_macos_audio_queue_clear(&queue); // Mute/Home must retain no tail.
    sc_reverse_macos_audio_queue_clear(&queue); // Repeated cleanup is harmless.
    assert(!sc_reverse_macos_audio_queue_pop(&queue, &entry));
}

int main(void) {
    test_capture_queue();
    int16_t pcm[SC_REVERSE_AUDIO_MAX_CHUNK * 2]; size_t count = 0;
    assert(!sc_reverse_macos_audio_pcm(NULL, pcm, &count));
    for (unsigned planar = 0; planar <= 1; ++planar) {
        CMSampleBufferRef sample = sample_buffer(planar, 48000, 2, 1024);
        assert(CMSampleBufferDataIsReady(sample));
        bool converted = sc_reverse_macos_audio_pcm(sample, pcm, &count);
        if (!converted) {
            const AudioStreamBasicDescription *asbd = CMAudioFormatDescriptionGetStreamBasicDescription(CMSampleBufferGetFormatDescription(sample));
            fprintf(stderr, "Synthetic PCM: planar=%u samples=%ld bytes=%zu rate=%.0f channels=%u bits=%u flags=%u stride=%u\n",
                planar, (long)CMSampleBufferGetNumSamples(sample), CMSampleBufferGetTotalSampleSize(sample),
                asbd->mSampleRate, (unsigned)asbd->mChannelsPerFrame, (unsigned)asbd->mBitsPerChannel,
                (unsigned)asbd->mFormatFlags, (unsigned)asbd->mBytesPerFrame);
            size_t size = offsetof(AudioBufferList, mBuffers) + 2 * sizeof(AudioBuffer), needed = 0;
            AudioBufferList *list = calloc(1, size); assert(list);
            CMBlockBufferRef block = NULL;
            OSStatus status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sample, &needed, list, size,
                kCFAllocatorDefault, kCFAllocatorDefault, kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment, &block);
            fprintf(stderr, "Synthetic PCM list: status=%d capacity=%zu needed=%zu buffers=%u\n", (int)status, size, needed, (unsigned)list->mNumberBuffers);
            if (status == noErr) for (unsigned i = 0; i < list->mNumberBuffers && i < 2; ++i)
                fprintf(stderr, "Synthetic PCM buffer: channels=%u bytes=%u data=%s\n", (unsigned)list->mBuffers[i].mNumberChannels,
                    (unsigned)list->mBuffers[i].mDataByteSize, list->mBuffers[i].mData ? "present" : "missing");
            if (block) CFRelease(block);
            free(list);
        }
        assert(converted && count == 1024);
        for (size_t i = 0; i < count; ++i) assert(pcm[2*i] == 16384 && pcm[2*i+1] == -16384);
        CFRelease(sample);
    }
    CMSampleBufferRef sample = sample_buffer(true, 44100, 2, 480);
    assert(!sc_reverse_macos_audio_pcm(sample, pcm, &count)); CFRelease(sample);
    sample = sample_buffer(true, 48000, 1, 480);
    assert(!sc_reverse_macos_audio_pcm(sample, pcm, &count)); CFRelease(sample);
    sample = sample_buffer(true, 48000, 2, SC_REVERSE_AUDIO_MAX_CHUNK + 1);
    assert(!sc_reverse_macos_audio_pcm(sample, pcm, &count)); CFRelease(sample);
    return 0;
}

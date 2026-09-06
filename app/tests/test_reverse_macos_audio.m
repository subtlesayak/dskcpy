#include <assert.h>
#include <stdlib.h>
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
    assert(CMSampleBufferCreate(kCFAllocatorDefault, NULL, false, NULL, NULL, format,
        count, 1, &timing, 0, NULL, &sample) == noErr);
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

int main(void) {
    int16_t pcm[SC_REVERSE_AUDIO_MAX_CHUNK * 2]; size_t count = 0;
    assert(!sc_reverse_macos_audio_pcm(NULL, pcm, &count));
    for (unsigned planar = 0; planar <= 1; ++planar) {
        CMSampleBufferRef sample = sample_buffer(planar, 48000, 2, 1024);
        assert(CMSampleBufferDataIsReady(sample));
        assert(sc_reverse_macos_audio_pcm(sample, pcm, &count) && count == 1024);
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

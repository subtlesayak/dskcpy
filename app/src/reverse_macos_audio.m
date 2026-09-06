#include "reverse_macos_audio.h"
#include "reverse_audio_encoder.h"
#include <stddef.h>
#include <stdlib.h>

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
    // Enough room for the two requested channels; reject unexpected layouts.
    size_t size = offsetof(AudioBufferList, mBuffers) + 2 * sizeof(AudioBuffer);
    AudioBufferList *list = malloc(size);
    if (!list) return false;
    CMBlockBufferRef block = NULL;
    OSStatus status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sample, NULL, list, size,
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

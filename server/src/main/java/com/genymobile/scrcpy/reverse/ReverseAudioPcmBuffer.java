package com.genymobile.scrcpy.reverse;

import java.nio.ByteBuffer;

/** One reusable PCM buffer: short nonblocking writes retain their unwritten tail. */
final class ReverseAudioPcmBuffer {
    static final long MAX_AGE_NS = 80_000_000L;
    static final int MAX_BYTES = 48000 * 2 * 2 * 80 / 1000;
    interface Writer { int write(ByteBuffer pcm); }

    private final ByteBuffer pcm = ByteBuffer.allocateDirect(MAX_BYTES);
    private long epoch;
    private long receivedNs;

    ReverseAudioPcmBuffer() { clear(); }

    boolean hasPending() { return pcm.hasRemaining(); }

    void offer(ByteBuffer source, long currentEpoch, long nowNs) {
        if (hasPending()) throw new IllegalStateException("Unwritten PCM must not be overwritten");
        int size = source.remaining();
        if (size <= 0 || size > MAX_BYTES || size % 4 != 0) throw new IllegalArgumentException("Invalid stereo PCM size");
        pcm.clear();
        pcm.put(source).flip();
        epoch = currentEpoch;
        receivedNs = nowNs;
    }

    int write(Writer writer, long currentEpoch, long nowNs) {
        if (!hasPending()) return 0;
        long age = nowNs - receivedNs;
        if (epoch != currentEpoch || age < 0 || age > MAX_AGE_NS) {
            clear();
            return 0;
        }
        int before = pcm.remaining();
        int written = writer.write(pcm);
        if (written < 0 || written > before || written % 4 != 0 || pcm.remaining() != before - written) {
            throw new IllegalStateException("Invalid audio output write");
        }
        if (!hasPending()) clear();
        return written;
    }

    void clear() { pcm.clear(); pcm.limit(0); }
}

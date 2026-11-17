package com.genymobile.scrcpy.reverse;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import org.junit.Test;
import static org.junit.Assert.*;

public class ReverseAudioPcmBufferTest {
    @Test public void partialAndZeroWritesKeepEverySampleInOrder() {
        ReverseAudioPcmBuffer pending = new ReverseAudioPcmBuffer();
        byte[] input = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12};
        pending.offer(ByteBuffer.wrap(input), 1, 100);
        assertEquals(0, pending.write(pcm -> 0, 1, 101));
        assertTrue(pending.hasPending());
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        ReverseAudioPcmBuffer.Writer sink = pcm -> {
            int count = Math.min(4, pcm.remaining());
            for (int i = 0; i < count; ++i) output.write(pcm.get());
            return count;
        };
        assertEquals(4, pending.write(sink, 1, 102));
        assertTrue(pending.hasPending());
        assertEquals(4, pending.write(sink, 1, 103));
        assertTrue(pending.hasPending());
        assertEquals(4, pending.write(sink, 1, 104));
        assertFalse(pending.hasPending());
        assertArrayEquals(input, output.toByteArray());
    }

    @Test public void muteEpochDropsUnwrittenTailBeforeResume() {
        ReverseAudioPcmBuffer pending = new ReverseAudioPcmBuffer();
        pending.offer(ByteBuffer.wrap(new byte[8]), 1, 100);
        assertEquals(0, pending.write(pcm -> { fail("Old epoch reached the output"); return 0; }, 3, 101));
        assertFalse(pending.hasPending());
        pending.offer(ByteBuffer.wrap(new byte[4]), 3, 102);
        assertEquals(4, pending.write(pcm -> { pcm.position(pcm.limit()); return 4; }, 3, 103));
    }

    @Test public void delayedOutputIsDroppedAtTheSameBoundedAge() {
        ReverseAudioPcmBuffer pending = new ReverseAudioPcmBuffer();
        pending.offer(ByteBuffer.wrap(new byte[4]), 1, 100);
        assertEquals(0, pending.write(pcm -> { fail("Stale sound reached output"); return 0; }, 1,
                101 + ReverseAudioPcmBuffer.MAX_AGE_NS));
        assertFalse(pending.hasPending());
        pending.offer(ByteBuffer.wrap(new byte[4]), 1, 100);
        assertEquals(4, pending.write(pcm -> { pcm.position(pcm.limit()); return 4; }, 1,
                100 + ReverseAudioPcmBuffer.MAX_AGE_NS));
    }

    @Test public void clearAndFutureClockNeverReplayPcm() {
        ReverseAudioPcmBuffer pending = new ReverseAudioPcmBuffer();
        pending.offer(ByteBuffer.wrap(new byte[4]), 1, 100);
        pending.clear();
        assertEquals(0, pending.write(pcm -> { fail(); return 0; }, 1, 101));
        pending.offer(ByteBuffer.wrap(new byte[4]), 1, 100);
        assertEquals(0, pending.write(pcm -> { fail(); return 0; }, 1, 99));
        assertFalse(pending.hasPending());
    }

    @Test(expected = IllegalStateException.class) public void freshUnwrittenPcmCannotBeOverwritten() {
        ReverseAudioPcmBuffer pending = new ReverseAudioPcmBuffer();
        pending.offer(ByteBuffer.wrap(new byte[4]), 1, 100);
        pending.offer(ByteBuffer.wrap(new byte[4]), 1, 101);
    }
    @Test(expected = IllegalArgumentException.class) public void decodedPcmAllocationIsBounded() {
        new ReverseAudioPcmBuffer().offer(ByteBuffer.wrap(new byte[ReverseAudioPcmBuffer.MAX_BYTES + 4]), 1, 100);
    }
    @Test(expected = IllegalStateException.class) public void failedOutputDoesNotLookLikeSuccess() {
        ReverseAudioPcmBuffer pending = new ReverseAudioPcmBuffer();
        pending.offer(ByteBuffer.wrap(new byte[4]), 1, 100);
        pending.write(pcm -> -1, 1, 101);
    }
    @Test(expected = IllegalStateException.class) public void outputMustReportItsActualConsumption() {
        ReverseAudioPcmBuffer pending = new ReverseAudioPcmBuffer();
        pending.offer(ByteBuffer.wrap(new byte[4]), 1, 100);
        pending.write(pcm -> 4, 1, 101);
    }
}

package com.genymobile.scrcpy.reverse;

import org.junit.Test;
import static org.junit.Assert.*;

public class ReverseAudioBufferTest {
    private ReversePacketReader.Packet packet(long pts, int flags) {
        return new ReversePacketReader.Packet(new byte[] {1}, pts, flags);
    }
    @Test public void audioQueueDropsOldestAndPreservesConfig() throws Exception {
        ReverseAudioBuffer buffer = new ReverseAudioBuffer();
        buffer.offer(packet(0, ReversePacketReader.AUDIO_CONFIG), 0);
        for (int i = 1; i <= 8; ++i) buffer.offer(packet(i, ReversePacketReader.AUDIO_PACKET), i);
        assertEquals(ReversePacketReader.AUDIO_CONFIG, buffer.poll().packet.flags);
        for (int i = 5; i <= 8; ++i) assertEquals(i, buffer.poll().packet.ptsUs);
        assertNull(buffer.poll());
    }
    @Test public void newConfigurationFlushesPriorAudio() throws Exception {
        ReverseAudioBuffer buffer = new ReverseAudioBuffer();
        buffer.offer(packet(10, ReversePacketReader.AUDIO_PACKET), 0);
        assertEquals(10, buffer.offer(packet(0, ReversePacketReader.AUDIO_CONFIG), 1));
        assertEquals(ReversePacketReader.AUDIO_CONFIG, buffer.poll().packet.flags);
        assertNull(buffer.poll());
    }
    @Test public void pauseClearsBufferedAudioAndReportsCumulativeAck() throws Exception {
        ReverseAudioBuffer buffer = new ReverseAudioBuffer();
        buffer.offer(packet(10, ReversePacketReader.AUDIO_PACKET), 0);
        buffer.offer(packet(20, ReversePacketReader.AUDIO_PACKET), 0);
        assertEquals(20, buffer.clear());
        assertNull(buffer.poll());
    }
    @Test public void staleAudioIsNeverReplayedAfterNetworkDelay() {
        ReverseAudioBuffer.Entry entry = new ReverseAudioBuffer.Entry(packet(1, ReversePacketReader.AUDIO_PACKET), 10);
        assertFalse(entry.stale(10 + ReverseAudioBuffer.MAX_AGE_NS));
        assertTrue(entry.stale(11 + ReverseAudioBuffer.MAX_AGE_NS));
    }
    @Test public void pauseDiscardsSoundButRetainsPendingConfiguration() throws Exception {
        ReverseAudioBuffer buffer = new ReverseAudioBuffer();
        buffer.offer(packet(0, ReversePacketReader.AUDIO_CONFIG), 0);
        buffer.offer(packet(10, ReversePacketReader.AUDIO_PACKET), 1);
        assertEquals(10, buffer.clearData());
        assertEquals(ReversePacketReader.AUDIO_CONFIG, buffer.poll().packet.flags);
        assertNull(buffer.poll());
    }
}

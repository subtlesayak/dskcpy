package com.genymobile.scrcpy.reverse;

import java.util.ArrayDeque;

/** Bounded audio-only queue. Configuration cannot be evicted by audio data. */
final class ReverseAudioBuffer {
    static final int CAPACITY = 4;
    static final long MAX_AGE_NS = 80_000_000L;
    static final class Entry {
        final ReversePacketReader.Packet packet;
        final long receivedNs;
        Entry(ReversePacketReader.Packet packet, long receivedNs) { this.packet = packet; this.receivedNs = receivedNs; }
        boolean stale(long now) { return now - receivedNs > MAX_AGE_NS; }
    }
    private final ArrayDeque<Entry> packets = new ArrayDeque<>();
    private Entry config;
    synchronized long offer(ReversePacketReader.Packet packet, long now) {
        long dropped = -1;
        if (packet.flags != ReversePacketReader.AUDIO_PACKET) {
            dropped = clear();
            config = new Entry(packet, now);
        } else {
            if (packets.size() == CAPACITY) dropped = packets.removeFirst().packet.ptsUs;
            packets.addLast(new Entry(packet, now));
        }
        notifyAll();
        return dropped;
    }
    synchronized Entry poll() throws InterruptedException {
        if (config == null && packets.isEmpty()) wait(5);
        // A configuration may arrive while waiting: inspect it again before
        // returning data so the new stream is never decoded with old state.
        if (config != null) { Entry result = config; config = null; return result; }
        return packets.pollFirst();
    }
    synchronized long clear() {
        config = null;
        return clearData();
    }
    synchronized long clearData() {
        long dropped = packets.isEmpty() ? -1 : packets.getLast().packet.ptsUs;
        packets.clear();
        return dropped;
    }
}

package com.genymobile.scrcpy.reverse;

import java.io.Closeable;
import java.io.DataInputStream;
import java.io.IOException;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.TimeUnit;

/** Reads complete wire packets without blocking the codec's output-drain loop. */
final class ReversePacketReader implements Closeable {
    interface AudioSink { void accept(Packet packet); }
    static final int AUDIO_CONFIG = 4;
    static final int AUDIO_PACKET = 8;
    static final int AUDIO_UNAVAILABLE = 16;
    static final int MAX_FRAME_SIZE = 16 * 1024 * 1024;
    private static final int QUEUE_CAPACITY = 2;

    static final class Packet {
        final byte[] data;
        final long ptsUs;
        final int flags;

        Packet(byte[] data, long ptsUs, int flags) {
            this.data = data;
            this.ptsUs = ptsUs;
            this.flags = flags;
        }
    }

    private final DataInputStream input;
    private final Closeable transport;
    private final AudioSink audio;
    private final ArrayBlockingQueue<Packet> packets = new ArrayBlockingQueue<>(QUEUE_CAPACITY);
    private final Thread thread;
    private volatile boolean closed;
    private volatile boolean finished;
    private volatile IOException failure;

    ReversePacketReader(DataInputStream input, Closeable transport) {
        this(input, transport, null);
    }

    ReversePacketReader(DataInputStream input, Closeable transport, AudioSink audio) {
        this.input = input;
        this.transport = transport;
        this.audio = audio;
        thread = new Thread(this::readPackets, "reverse-video-read");
    }

    void start() {
        thread.start();
    }

    private void readPackets() {
        try {
            while (!closed) {
                // EOF is normal only at a packet boundary, never mid-header.
                int first = input.read();
                if (first < 0) {
                    break;
                }
                int size = (first << 24) | (input.readUnsignedByte() << 16)
                        | (input.readUnsignedByte() << 8) | input.readUnsignedByte();
                if (size <= 0 || size > MAX_FRAME_SIZE) {
                    throw new IOException("Invalid reverse-display frame size: " + size);
                }
                long ptsUs = input.readLong();
                int flags = input.readInt();
                boolean audioPacket = flags == AUDIO_CONFIG || flags == AUDIO_PACKET || flags == AUDIO_UNAVAILABLE;
                if (audioPacket && size > 4096) throw new IOException("Oversized reverse audio packet");
                if (!audioPacket && (flags & ~3) != 0) throw new IOException("Unknown reverse packet flags");
                byte[] data = new byte[size];
                input.readFully(data);
                if (audioPacket) {
                    if (audio == null) throw new IOException("Audio was not negotiated");
                    audio.accept(new Packet(data, ptsUs, flags));
                    continue;
                }
                // Never drop compressed reference frames. A full queue applies
                // backpressure; stale decoded output is dropped by the codec loop.
                packets.put(new Packet(data, ptsUs, flags));
            }
        } catch (IOException e) {
            if (!closed) {
                failure = e;
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } finally {
            finished = true;
        }
    }

    Packet poll(long timeoutMs) throws IOException, InterruptedException {
        Packet packet = packets.poll(timeoutMs, TimeUnit.MILLISECONDS);
        if (packet == null && finished && failure != null) {
            throw failure;
        }
        return packet;
    }

    boolean isFinished() {
        return finished && packets.isEmpty();
    }

    @Override
    public void close() throws IOException {
        closed = true;
        thread.interrupt();
        // Closing the socket input wakes a blocked readFully. Codec teardown
        // happens only after this worker has left the stream.
        try {
            // Close the owner, not a buffered wrapper whose read may hold its
            // monitor while blocked on the underlying socket.
            transport.close();
        } finally {
            try {
                thread.join();
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            packets.clear();
        }
    }
}

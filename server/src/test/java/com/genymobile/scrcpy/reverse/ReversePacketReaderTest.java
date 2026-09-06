package com.genymobile.scrcpy.reverse;

import org.junit.Test;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayDeque;
import java.util.Arrays;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.junit.Assert.*;

public class ReversePacketReaderTest {
    @Test(timeout = 3000)
    public void multiplexedAudioNeverEntersVideoQueue() throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        bytes.write(packet(19, 0, ReversePacketReader.AUDIO_CONFIG));
        bytes.write(packet(4, 100, ReversePacketReader.AUDIO_PACKET));
        bytes.write(packet(4, 200, 2));
        java.util.List<Integer> audioFlags = new java.util.concurrent.CopyOnWriteArrayList<>();
        InputStream input = new ByteArrayInputStream(bytes.toByteArray());
        try (ReversePacketReader reader = new ReversePacketReader(new DataInputStream(input), input, p -> audioFlags.add(p.flags))) {
            reader.start();
            assertEquals(200, reader.poll(1000).ptsUs);
            assertEquals(Arrays.asList(4, 8), audioFlags);
            assertNull(reader.poll(20));
        }
    }

    @Test(timeout = 3000)
    public void audioSizeAndNegotiationAreValidated() throws Exception {
        for (byte[] wire : new byte[][] {packet(4097, 0, 8), packet(4, 0, 8), packet(4, 0, 32)}) {
            InputStream input = new ByteArrayInputStream(wire);
            try (ReversePacketReader reader = new ReversePacketReader(new DataInputStream(input), input)) {
                reader.start();
                try { reader.poll(500); fail("Invalid audio must fail"); } catch (IOException expected) { }
            }
        }
    }
    private static byte[] packet(int size, long pts, int flags) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        DataOutputStream output = new DataOutputStream(bytes);
        output.writeInt(size);
        output.writeLong(pts);
        output.writeInt(flags);
        if (size > 0 && size < 1024) {
            output.write(new byte[size]);
        }
        return bytes.toByteArray();
    }

    private static final class FragmentedInput extends InputStream {
        final ArrayDeque<Integer> bytes = new ArrayDeque<>();
        final CountDownLatch waiting = new CountDownLatch(1);
        boolean ended;

        synchronized void feed(byte[] data) {
            for (byte value : data) {
                bytes.add(value & 0xff);
            }
            notifyAll();
        }

        @Override
        public synchronized int read() throws IOException {
            while (bytes.isEmpty() && !ended) {
                waiting.countDown();
                try {
                    wait();
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    throw new IOException(e);
                }
            }
            return bytes.isEmpty() ? -1 : bytes.removeFirst();
        }

        @Override
        public synchronized void close() {
            ended = true;
            notifyAll();
        }
    }

    @Test(timeout = 3000)
    public void fragmentedHeaderAndPayloadNeverBlockCodecPolling() throws Exception {
        FragmentedInput input = new FragmentedInput();
        byte[] wire = packet(4, 12345, 2);
        input.feed(Arrays.copyOfRange(wire, 0, 7));
        try (ReversePacketReader reader = new ReversePacketReader(new DataInputStream(input), input)) {
            reader.start();
            assertTrue(input.waiting.await(1, TimeUnit.SECONDS));
            assertNull(reader.poll(5)); // codec remains free to drain output
            input.feed(Arrays.copyOfRange(wire, 7, 18));
            assertNull(reader.poll(5)); // incomplete payload is not published
            input.feed(Arrays.copyOfRange(wire, 18, wire.length));
            ReversePacketReader.Packet result = reader.poll(1000);
            assertNotNull(result);
            assertEquals(12345, result.ptsUs);
            assertEquals(2, result.flags);
            assertEquals(4, result.data.length);
            assertNull(reader.poll(5)); // idle desktop never blocks output
        }
    }

    @Test(timeout = 3000)
    public void configAndReferenceFramesStayInOrder() throws Exception {
        ByteArrayOutputStream wire = new ByteArrayOutputStream();
        wire.write(packet(4, 0, 1));
        for (int i = 1; i <= 6; i++) {
            wire.write(packet(4, i, i == 1 ? 2 : 0));
        }
        InputStream input = new ByteArrayInputStream(wire.toByteArray());
        try (ReversePacketReader reader = new ReversePacketReader(new DataInputStream(input), input)) {
            reader.start();
            for (int i = 0; i <= 6; i++) {
                ReversePacketReader.Packet result = reader.poll(1000);
                assertNotNull(result);
                assertEquals(i, result.ptsUs);
                assertEquals(i == 0 ? 1 : i == 1 ? 2 : 0, result.flags);
            }
            assertNull(reader.poll(20));
            assertTrue(reader.isFinished());
        }
    }

    @Test(timeout = 3000)
    public void malformedAndTruncatedPacketsFailInsteadOfHanging() throws Exception {
        byte[][] invalid = {
            packet(-1, 0, 0), packet(0, 0, 0),
            packet(ReversePacketReader.MAX_FRAME_SIZE + 1, 0, 0),
            new byte[] {0, 0}, Arrays.copyOf(packet(8, 0, 0), 18),
        };
        for (byte[] bytes : invalid) {
            InputStream input = new ByteArrayInputStream(bytes);
            try (ReversePacketReader reader = new ReversePacketReader(new DataInputStream(input), input)) {
                reader.start();
                try {
                    reader.poll(100);
                    fail("Malformed packet must report failure");
                } catch (IOException expected) {
                    assertTrue(reader.isFinished());
                }
            }
        }
    }

    @Test(timeout = 3000)
    public void closingWakesAnIdleNetworkRead() throws Exception {
        FragmentedInput input = new FragmentedInput();
        ReversePacketReader reader = new ReversePacketReader(new DataInputStream(input), input);
        reader.start();
        assertTrue(input.waiting.await(1, TimeUnit.SECONDS));
        reader.close();
        assertTrue(reader.isFinished());
    }

    @Test(timeout = 3000)
    public void readAheadIsBoundedAndClosingWakesAFullQueue() throws Exception {
        byte[] one = packet(4, 10, 0);
        ByteArrayOutputStream wire = new ByteArrayOutputStream();
        for (int i = 0; i < 10; i++) {
            wire.write(one);
        }
        CountDownLatch thirdPacket = new CountDownLatch(1);
        ByteArrayInputStream input = new ByteArrayInputStream(wire.toByteArray()) {
            @Override
            public synchronized int read(byte[] buffer, int offset, int length) {
                int count = super.read(buffer, offset, length);
                if (pos == 3 * one.length) {
                    thirdPacket.countDown();
                }
                return count;
            }
        };
        ReversePacketReader reader = new ReversePacketReader(new DataInputStream(input), input);
        reader.start();
        assertTrue(thirdPacket.await(1, TimeUnit.SECONDS));
        assertEquals(7 * one.length, input.available());
        reader.close();
        assertTrue(reader.isFinished());
    }
}

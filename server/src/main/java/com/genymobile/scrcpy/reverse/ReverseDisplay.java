package com.genymobile.scrcpy.reverse;

import com.genymobile.scrcpy.AsyncProcessor;
import com.genymobile.scrcpy.AndroidVersions;
import com.genymobile.scrcpy.control.ControlChannel;
import com.genymobile.scrcpy.control.DeviceMessage;
import com.genymobile.scrcpy.control.DeviceMessageSender;
import com.genymobile.scrcpy.device.DesktopConnection;
import com.genymobile.scrcpy.util.Ln;

import android.media.MediaCodec;
import android.media.MediaFormat;
import android.graphics.SurfaceTexture;
import android.os.Bundle;
import android.view.Surface;

import java.io.BufferedInputStream;
import java.io.ByteArrayInputStream;
import java.io.Closeable;
import java.io.DataInputStream;
import java.io.FileDescriptor;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.util.concurrent.atomic.AtomicBoolean;

/** Receives the host desktop stream and decodes it directly to a Surface. */
public final class ReverseDisplay implements AsyncProcessor, ReverseDisplayWindow.SurfaceListener {

    public interface VideoSizeListener {
        void onVideoSize(int width, int height);
    }

    private static final int MAGIC = 0x53524431; // "SRD1"
    private static final int CODEC_H264 = 1;
    private static final int FLAG_CODEC_CONFIG = 1;
    private static final int MAX_PENDING_FRAMES = 2;

    private final DesktopConnection connection;
    private final InputStream videoInputStream;
    private final Closeable transport;
    private final DeviceMessageSender sender;
    private final VideoSizeListener videoSizeListener;
    private final boolean resumable;
    private final Object surfaceLock = new Object();
    private final AtomicBoolean stopped = new AtomicBoolean();

    private Surface surface;
    private Surface parkingSurface;
    private MediaCodec activeDecoder;
    private boolean renderingEnabled = true;
    private Thread thread;
    private TerminationListener terminationListener;
    private ReverseAudioPlayer audio;

    void prepareAudio(android.content.Context context, ReverseAudioPlayer.Listener listener) {
        audio = new ReverseAudioPlayer(context, sender, listener);
    }

    void setAudioEnabled(boolean enabled) {
        if (audio != null) audio.setEnabled(enabled);
    }

    public ReverseDisplay(DesktopConnection connection) {
        this.connection = connection;
        FileDescriptor videoFd = connection.getVideoFd();
        ControlChannel controlChannel = connection.getControlChannel();
        if (videoFd == null || controlChannel == null) {
            throw new IllegalArgumentException("Reverse display requires video and control sockets");
        }
        videoInputStream = new FileInputStream(videoFd);
        transport = connection;
        sender = new DeviceMessageSender(controlChannel);
        videoSizeListener = null;
        resumable = false;
    }

    /**
     * Create a reverse-display decoder backed by an application-owned socket.
     *
     * <p>The companion activity uses this constructor because it owns the
     * normal application window while the host still provides the stream.
     */
    public ReverseDisplay(InputStream videoInputStream, OutputStream controlOutputStream,
            Closeable transport) {
        this(videoInputStream, controlOutputStream, transport, null);
    }

    public ReverseDisplay(InputStream videoInputStream, OutputStream controlOutputStream,
            Closeable transport, VideoSizeListener videoSizeListener) {
        this(videoInputStream, controlOutputStream, transport, videoSizeListener, false);
    }

    public ReverseDisplay(InputStream videoInputStream, OutputStream controlOutputStream,
            Closeable transport, VideoSizeListener videoSizeListener, boolean resumable) {
        if (videoInputStream == null || controlOutputStream == null || transport == null) {
            throw new IllegalArgumentException("Reverse display streams must not be null");
        }
        connection = null;
        this.videoInputStream = videoInputStream;
        this.transport = transport;
        ControlChannel controlChannel = new ControlChannel(
                new ByteArrayInputStream(new byte[0]), controlOutputStream);
        sender = new DeviceMessageSender(controlChannel);
        this.videoSizeListener = videoSizeListener;
        this.resumable = resumable && android.os.Build.VERSION.SDK_INT >= 23;
    }

    public DeviceMessageSender getSender() {
        return sender;
    }

    public void onSurfaceCreated(Surface surface) {
        synchronized (surfaceLock) {
            if (resumable && android.os.Build.VERSION.SDK_INT >= 23 && activeDecoder != null && this.surface != surface) {
                activeDecoder.setOutputSurface(surface);
            }
            this.surface = surface;
            surfaceLock.notifyAll();
        }
    }

    public void onSurfaceDestroyed(Surface surface) {
        synchronized (surfaceLock) {
            if (this.surface == surface) {
                // Switch before SurfaceView's callback returns and Android destroys it.
                // Both surfaces are GPU consumers; queued background output is discarded.
                if (resumable && android.os.Build.VERSION.SDK_INT >= 23 && activeDecoder != null) {
                    activeDecoder.setOutputSurface(parkingSurface);
                }
                this.surface = null;
            }
        }
        if (!resumable) stop();
    }

    public void setRenderingEnabled(boolean enabled) {
        synchronized (surfaceLock) { renderingEnabled = enabled; }
    }

    @Override
    public void start(TerminationListener listener) {
        terminationListener = listener;
        sender.start();
        if (audio != null) audio.start();
        thread = new Thread(this::run, "reverse-display");
        thread.start();
    }

    private void run() {
        boolean fatalError = false;
        try {
            decode();
        } catch (Throwable e) {
            if (!stopped.get()) {
                fatalError = true;
                Ln.e("Reverse display stopped", e);
            }
        } finally {
            if (audio != null) audio.stop();
            if (terminationListener != null) {
                terminationListener.onTerminated(fatalError);
            }
        }
    }

    private Surface waitForSurface() throws InterruptedException {
        synchronized (surfaceLock) {
            while (surface == null && !stopped.get()) {
                surfaceLock.wait(100);
            }
            return surface;
        }
    }

    private void decode() throws IOException, InterruptedException {
        // Packet-reader teardown closes this input to wake blocked network IO;
        // the owning connection lifecycle also closes the control socket.
        DataInputStream input = new DataInputStream(new BufferedInputStream(videoInputStream, 8192));
        int magic = input.readInt();
        int codecId = input.readInt();
        int width = input.readInt();
        int height = input.readInt();
        if (magic != MAGIC) {
            throw new IOException("Invalid reverse-display stream magic");
        }
        if (codecId != CODEC_H264) {
            throw new IOException("Unsupported reverse-display codec: " + codecId);
        }
        if (width < 2 || height < 2 || width > 16384 || height > 16384) {
            throw new IOException("Invalid reverse-display size: " + width + "x" + height);
        }
        if (videoSizeListener != null) {
            videoSizeListener.onVideoSize(width, height);
        }

        Surface outputSurface = resumable ? null : waitForSurface();
        if (!resumable && (outputSurface == null || !outputSurface.isValid())) {
            return;
        }

        MediaFormat format = MediaFormat.createVideoFormat("video/avc", width, height);
        if (android.os.Build.VERSION.SDK_INT >= AndroidVersions.API_30_ANDROID_11) {
            format.setInteger(MediaFormat.KEY_LOW_LATENCY, 1);
        }
        if (android.os.Build.VERSION.SDK_INT >= 23) format.setInteger(MediaFormat.KEY_PRIORITY, 0);

        MediaCodec decoder = MediaCodec.createDecoderByType("video/avc");
        SurfaceTexture parkingTexture = null;
        try {
            synchronized (surfaceLock) {
                if (stopped.get()) return;
                if (resumable) {
                    // Detached, app-owned Surface survives Home, Back and Activity recreation.
                    // Never render into it, so no GL consumer or frame queue is needed.
                    parkingTexture = android.os.Build.VERSION.SDK_INT >= 26 ? new SurfaceTexture(false) : new SurfaceTexture(0);
                    parkingTexture.setDefaultBufferSize(width, height);
                    parkingSurface = new Surface(parkingTexture);
                    outputSurface = surface != null && surface.isValid() ? surface : parkingSurface;
                }
                decoder.configure(format, outputSurface, null, 0);
                decoder.start();
                activeDecoder = decoder;
            }
            if (android.os.Build.VERSION.SDK_INT >= AndroidVersions.API_30_ANDROID_11) {
                try {
                    Bundle parameters = new Bundle();
                    parameters.putInt(MediaCodec.PARAMETER_KEY_LOW_LATENCY, 1);
                    decoder.setParameters(parameters);
                } catch (IllegalArgumentException | IllegalStateException e) {
                    // KEY_LOW_LATENCY on the format remains the portable hint.
                    Ln.w("Decoder rejected the dynamic low-latency hint");
                }
            }
            try (ReversePacketReader reader = new ReversePacketReader(input, transport, audio)) {
                reader.start();
                decodePackets(reader, decoder);
            }
        } finally {
            synchronized (surfaceLock) {
                activeDecoder = null;
                try {
                    decoder.stop();
                } catch (IllegalStateException e) {
                    // The codec may already have failed or been interrupted.
                }
                decoder.release();
                if (parkingSurface != null) { parkingSurface.release(); parkingSurface = null; }
                if (parkingTexture != null) parkingTexture.release();
            }
        }
    }

    private void decodePackets(ReversePacketReader reader, MediaCodec decoder)
            throws IOException, InterruptedException {
        MediaCodec.BufferInfo bufferInfo = new MediaCodec.BufferInfo();
        DrainResult drainResult = new DrainResult();
        int pendingFrames = 0;
        while (!stopped.get()) {
            // Do not let the socket and decoder queue an ever-growing video
            // history. Waiting here propagates backpressure to the host, which
            // then captures the newest desktop image once a slot is available.
            while (pendingFrames >= MAX_PENDING_FRAMES && !stopped.get()) {
                drain(decoder, bufferInfo, 10_000, drainResult);
                pendingFrames = Math.max(0,
                        pendingFrames - drainResult.outputFrameCount);
                if (drainResult.endOfStream) {
                    return;
                }
            }

            // Socket availability is not packet completeness. Poll only for
            // fully read packets so fragmented headers/payloads never prevent
            // presenting an already-decoded frame or sending its ACK.
            ReversePacketReader.Packet packet = reader.poll(pendingFrames > 0 ? 0 : 5);
            if (packet == null) {
                drain(decoder, bufferInfo, pendingFrames > 0 ? 5_000 : 0, drainResult);
                pendingFrames = Math.max(0, pendingFrames - drainResult.outputFrameCount);
                if (drainResult.endOfStream) {
                    return;
                }
                if (reader.isFinished()) {
                    break;
                }
                continue;
            }
            int size = packet.data.length;

            int inputBufferId;
            do {
                inputBufferId = decoder.dequeueInputBuffer(10_000);
                if (inputBufferId < 0) {
                    drain(decoder, bufferInfo, 0, drainResult);
                    pendingFrames = Math.max(0,
                            pendingFrames - drainResult.outputFrameCount);
                }
            } while (inputBufferId < 0 && !stopped.get());
            if (stopped.get()) {
                return;
            }

            ByteBuffer inputBuffer = decoder.getInputBuffer(inputBufferId);
            if (inputBuffer == null || inputBuffer.capacity() < size) {
                throw new IOException("Decoder input buffer is too small: " + size);
            }
            inputBuffer.clear();
            inputBuffer.put(packet.data);
            int codecFlags = (packet.flags & FLAG_CODEC_CONFIG) != 0
                    ? MediaCodec.BUFFER_FLAG_CODEC_CONFIG : 0;
            decoder.queueInputBuffer(inputBufferId, 0, size, packet.ptsUs, codecFlags);
            if (codecFlags == 0) {
                ++pendingFrames;
            }
            drain(decoder, bufferInfo, 0, drainResult);
            pendingFrames = Math.max(0,
                    pendingFrames - drainResult.outputFrameCount);
        }

        if (!stopped.get()) {
            int inputBufferId = decoder.dequeueInputBuffer(100_000);
            if (inputBufferId >= 0) {
                decoder.queueInputBuffer(inputBufferId, 0, 0, 0,
                        MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                while (!stopped.get()) {
                    drain(decoder, bufferInfo, 100_000, drainResult);
                    if (drainResult.endOfStream) {
                        break;
                    }
                }
            }
        }
    }

    private final class DrainResult {
        private int outputFrameCount;
        private boolean endOfStream;

        void reset() {
            outputFrameCount = 0;
            endOfStream = false;
        }
    }

    private void drain(MediaCodec decoder, MediaCodec.BufferInfo info,
            long timeoutUs, DrainResult result) {
        synchronized (surfaceLock) {
            drainLocked(decoder, info, timeoutUs, result);
        }
    }

    private void drainLocked(MediaCodec decoder, MediaCodec.BufferInfo info,
            long timeoutUs, DrainResult result) {
        result.reset();
        int newestOutputBufferId = -1;
        int newestOutputFlags = 0;
        long newestOutputPts = 0;
        for (;;) {
            int outputBufferId = decoder.dequeueOutputBuffer(info, timeoutUs);
            if (outputBufferId >= 0) {
                if ((info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) {
                    // Codec configuration updates are metadata, not a frame.
                    // Presenting one to the Surface can cause a black flash at
                    // an IDR boundary on some vendor decoders.
                    decoder.releaseOutputBuffer(outputBufferId, false);
                    timeoutUs = 0;
                    continue;
                }
                ++result.outputFrameCount;
                if (newestOutputBufferId >= 0) {
                    // Keep display latency bounded: if several decoded frames
                    // are ready, discard every stale one and render only the
                    // newest. This is the same policy used by low-latency game
                    // streaming clients.
                    decoder.releaseOutputBuffer(newestOutputBufferId, false);
                }
                newestOutputBufferId = outputBufferId;
                newestOutputFlags = info.flags;
                newestOutputPts = info.presentationTimeUs;
                timeoutUs = 0;
                continue;
            }
            break;
        }

        if (newestOutputBufferId >= 0) {
            decoder.releaseOutputBuffer(newestOutputBufferId,
                    renderingEnabled && surface != null && surface.isValid());
            sender.send(DeviceMessage.createReverseFrameAck(newestOutputPts));
            result.endOfStream = (newestOutputFlags
                    & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0;
        }
    }

    @Override
    public void stop() {
        if (audio != null) audio.stop();
        if (stopped.compareAndSet(false, true)) {
            synchronized (surfaceLock) {
                surfaceLock.notifyAll();
            }
            try {
                // A socket input stream is not interruptible by
                // Thread.interrupt(). Closing the owning transport wakes it.
                if (connection != null) {
                    connection.shutdown();
                } else {
                    transport.close();
                }
            } catch (IOException e) {
                Ln.d("Reverse display connection already closed");
            }
        }
        sender.stop();
    }

    @Override
    public void join() throws InterruptedException {
        if (thread != null) {
            thread.join();
        }
        sender.join();
        if (audio != null) audio.join();
    }
}

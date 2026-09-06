package com.genymobile.scrcpy.reverse;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioTrack;
import android.media.MediaCodec;
import android.media.MediaFormat;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import com.genymobile.scrcpy.control.DeviceMessage;
import com.genymobile.scrcpy.control.DeviceMessageSender;
import com.genymobile.scrcpy.util.Ln;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/** Opus playback is independent of video draining and never blocks the socket reader. */
final class ReverseAudioPlayer implements ReversePacketReader.AudioSink {
    interface Listener { void onStatus(String status); }
    private final DeviceMessageSender sender;
    private final Listener listener;
    private final AudioManager manager;
    private final ReverseAudioBuffer queue = new ReverseAudioBuffer();
    private final Object trackLock = new Object();
    private final Handler main = new Handler(Looper.getMainLooper());
    private final AudioAttributes attributes = new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MOVIE).build();
    private final AudioManager.OnAudioFocusChangeListener focusListener = this::focusChanged;
    private AudioFocusRequest focusRequest;
    private volatile boolean stopped;
    private volatile boolean enabled;
    private boolean requested;
    private boolean hasFocus;
    private AudioTrack track;
    private MediaCodec codec; // Owned only by the audio thread.
    private Thread thread;
    private long writtenFrames;
    private long headBase;
    private long decodedFrames;
    private boolean reportedPlayback;
    private boolean reportedSignal;
    private int generation;

    ReverseAudioPlayer(Context context, DeviceMessageSender sender, Listener listener) {
        manager = (AudioManager) context.getApplicationContext().getSystemService(Context.AUDIO_SERVICE);
        this.sender = sender;
        this.listener = listener;
    }
    void start() { thread = new Thread(this::run, "reverse-audio-play"); thread.start(); }
    private void status(String text) { if (listener != null) main.post(() -> { if (!stopped) listener.onStatus(text); }); }

    void setEnabled(boolean value) {
        if (requested == value || stopped) return;
        requested = value;
        if (value && manager != null) {
            int result;
            if (Build.VERSION.SDK_INT >= 26) {
                focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                        .setAudioAttributes(attributes).setOnAudioFocusChangeListener(focusListener, main).build();
                result = manager.requestAudioFocus(focusRequest);
            } else result = manager.requestAudioFocus(focusListener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN);
            hasFocus = result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
        } else {
            abandonFocus();
            hasFocus = false;
        }
        applyEnabled(value && hasFocus);
        if (value && !hasFocus) status("Phone audio paused by another app");
    }

    private void focusChanged(int change) {
        if (stopped) return;
        hasFocus = change == AudioManager.AUDIOFOCUS_GAIN;
        applyEnabled(requested && hasFocus);
        if (requested && !hasFocus) status("Phone audio paused by another app");
    }
    private void applyEnabled(boolean value) {
        if (enabled == value) return;
        enabled = value;
        if (!value) ack(queue.clearData());
        synchronized (trackLock) {
            if (track != null) {
                if (value) {
                    // Focus/pause transitions can coalesce on the host. The
                    // existing track must resume even without a fresh config.
                    track.play();
                } else {
                    track.pause(); track.flush();
                    writtenFrames = 0;
                    headBase = playbackHead(track);
                    reportedPlayback = false;
                }
            }
        }
        sender.send(DeviceMessage.createReverseSystemAction(value
                ? DeviceMessage.REVERSE_SYSTEM_ACTION_AUDIO_ENABLE : DeviceMessage.REVERSE_SYSTEM_ACTION_AUDIO_DISABLE));
    }
    private void abandonFocus() {
        if (manager == null) return;
        if (Build.VERSION.SDK_INT >= 26 && focusRequest != null) manager.abandonAudioFocusRequest(focusRequest);
        else manager.abandonAudioFocus(focusListener);
        focusRequest = null;
    }
    private void ack(long pts) { if (pts >= 0) sender.send(DeviceMessage.createReverseAudioAck(pts)); }
    private static long playbackHead(AudioTrack output) { return ((long) output.getPlaybackHeadPosition()) & 0xffffffffL; }
    @Override public void accept(ReversePacketReader.Packet packet) {
        if (stopped || (!enabled && packet.flags == ReversePacketReader.AUDIO_PACKET)) { ack(packet.ptsUs); return; }
        ack(queue.offer(packet, System.nanoTime()));
    }

    private static ByteBuffer nativeLong(long value) {
        ByteBuffer data = ByteBuffer.allocate(8).order(ByteOrder.nativeOrder());
        data.putLong(value).flip(); return data;
    }
    private void configure(byte[] head) throws IOException {
        if (head.length != 19 || head[0] != 'O' || head[1] != 'p' || head[2] != 'u' || head[3] != 's'
                || head[4] != 'H' || head[5] != 'e' || head[6] != 'a' || head[7] != 'd'
                || head[8] != 1 || head[9] != 2 || head[18] != 0) throw new IOException("Unsupported Opus header");
        releaseDecoder();
        int skip = (head[10] & 255) | (head[11] & 255) << 8;
        MediaFormat format = MediaFormat.createAudioFormat("audio/opus", 48000, 2);
        format.setByteBuffer("csd-0", ByteBuffer.wrap(head));
        format.setByteBuffer("csd-1", nativeLong(skip * 1_000_000_000L / 48000));
        format.setByteBuffer("csd-2", nativeLong(80_000_000L));
        format.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 4096);
        if (Build.VERSION.SDK_INT >= 24) format.setInteger(MediaFormat.KEY_PCM_ENCODING, AudioFormat.ENCODING_PCM_16BIT);
        codec = MediaCodec.createDecoderByType("audio/opus");
        codec.configure(format, null, null, 0);
        codec.start();
        AudioFormat pcm = new AudioFormat.Builder().setSampleRate(48000)
                .setChannelMask(AudioFormat.CHANNEL_OUT_STEREO).setEncoding(AudioFormat.ENCODING_PCM_16BIT).build();
        int minimum = AudioTrack.getMinBufferSize(48000, AudioFormat.CHANNEL_OUT_STEREO, AudioFormat.ENCODING_PCM_16BIT);
        if (minimum <= 0) throw new IOException("Audio output format unavailable");
        synchronized (trackLock) {
            if (Build.VERSION.SDK_INT >= 23) {
                AudioTrack.Builder builder = new AudioTrack.Builder().setAudioAttributes(attributes).setAudioFormat(pcm)
                        .setTransferMode(AudioTrack.MODE_STREAM).setBufferSizeInBytes(Math.max(minimum, 7680));
                if (Build.VERSION.SDK_INT >= 26) builder.setPerformanceMode(AudioTrack.PERFORMANCE_MODE_LOW_LATENCY);
                track = builder.build();
            } else track = new AudioTrack(attributes, pcm, Math.max(minimum, 7680), AudioTrack.MODE_STREAM, AudioManager.AUDIO_SESSION_ID_GENERATE);
            if (track.getState() != AudioTrack.STATE_INITIALIZED) throw new IOException("Audio output initialization failed");
            writtenFrames = 0;
            headBase = playbackHead(track);
            reportedPlayback = false;
            if (enabled) track.play();
        }
        ++generation;
        Ln.i("Phone audio configured: Opus 48 kHz stereo, generation " + generation);
        status("Phone audio connected");
    }
    private void drain() {
        if (codec == null) return;
        MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
        int id;
        while (true) {
            id = codec.dequeueOutputBuffer(info, 0);
            if (id == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                MediaFormat actual = codec.getOutputFormat();
                if (actual.getInteger(MediaFormat.KEY_SAMPLE_RATE) != 48000 || actual.getInteger(MediaFormat.KEY_CHANNEL_COUNT) != 2
                        || (actual.containsKey(MediaFormat.KEY_PCM_ENCODING)
                        && actual.getInteger(MediaFormat.KEY_PCM_ENCODING) != AudioFormat.ENCODING_PCM_16BIT)) {
                    throw new IllegalStateException("Unsupported audio output format");
                }
                continue;
            }
            if (id < 0) break;
            ByteBuffer pcm = codec.getOutputBuffer(id);
            if (pcm != null && info.size > 0 && (info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0) {
                synchronized (trackLock) {
                    if (enabled && track != null) {
                        pcm.position(info.offset); pcm.limit(info.offset + info.size);
                        if (!reportedSignal) {
                            ByteBuffer samples = pcm.duplicate().order(ByteOrder.LITTLE_ENDIAN);
                            while (samples.remaining() >= 2) {
                                short sample = samples.getShort();
                                if (sample > 64 || sample < -64) {
                                    reportedSignal = true;
                                    Ln.i("Phone audio received non-silent PCM");
                                    break;
                                }
                            }
                        }
                        long played = (playbackHead(track) - headBase) & 0xffffffffL;
                        if (writtenFrames - played > 2880) {
                            track.pause(); track.flush(); track.play();
                            writtenFrames = 0; headBase = playbackHead(track);
                        }
                        int bytes = track.write(pcm, info.size, AudioTrack.WRITE_NON_BLOCKING);
                        if (bytes < 0) throw new IllegalStateException("Audio output write failed");
                        writtenFrames += bytes / 4;
                        decodedFrames += bytes / 4;
                        if (bytes > 0 && !reportedPlayback) {
                            reportedPlayback = true;
                            Ln.i("Phone audio playback started, generation " + generation);
                            status("Phone audio playing");
                        }
                    }
                }
            }
            codec.releaseOutputBuffer(id, false);
        }
    }
    private void run() {
        try {
            while (!stopped) {
                ReverseAudioBuffer.Entry entry = queue.poll();
                if (entry != null) {
                    ReversePacketReader.Packet packet = entry.packet;
                    try {
                        if (packet.flags == ReversePacketReader.AUDIO_CONFIG) configure(packet.data);
                        else if (packet.flags == ReversePacketReader.AUDIO_UNAVAILABLE) {
                            releaseDecoder(); status("Desktop audio unavailable");
                        } else {
                            if (enabled && codec != null && !entry.stale(System.nanoTime())) {
                                int id = codec.dequeueInputBuffer(0);
                                if (id >= 0) {
                                    ByteBuffer input = codec.getInputBuffer(id);
                                    if (input == null || input.capacity() < packet.data.length) throw new IOException("Audio packet too large");
                                    input.clear(); input.put(packet.data);
                                    codec.queueInputBuffer(id, 0, packet.data.length, packet.ptsUs, 0);
                                }
                            }
                            ack(packet.ptsUs);
                        }
                        drain();
                    } catch (IOException | RuntimeException e) {
                        enabled = false;
                        releaseDecoder();
                        ack(queue.clear());
                        ack(packet.ptsUs);
                        status("Phone audio unavailable; video continues");
                        Ln.w("Phone audio decoder/output unavailable; video continues");
                        sender.send(DeviceMessage.createReverseSystemAction(DeviceMessage.REVERSE_SYSTEM_ACTION_AUDIO_DISABLE));
                    }
                } else {
                    try { drain(); }
                    catch (RuntimeException error) {
                        enabled = false;
                        releaseDecoder();
                        ack(queue.clear());
                        status("Phone audio unavailable; video continues");
                        sender.send(DeviceMessage.createReverseSystemAction(DeviceMessage.REVERSE_SYSTEM_ACTION_AUDIO_DISABLE));
                    }
                }
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } catch (RuntimeException e) {
            enabled = false;
            ack(queue.clear());
            status("Phone audio unavailable; video continues");
            sender.send(DeviceMessage.createReverseSystemAction(DeviceMessage.REVERSE_SYSTEM_ACTION_AUDIO_DISABLE));
            Ln.w("Phone audio output stopped; video continues");
        } finally {
            releaseDecoder();
            Ln.i("Phone audio output frames: " + decodedFrames);
        }
    }
    private void releaseDecoder() {
        synchronized (trackLock) {
            if (track != null) { track.release(); track = null; }
        }
        if (codec != null) {
            try { codec.stop(); } catch (RuntimeException ignored) { }
            codec.release(); codec = null;
        }
    }
    void stop() {
        stopped = true;
        enabled = false;
        abandonFocus();
        if (thread != null) thread.interrupt();
        main.removeCallbacksAndMessages(null);
    }
    void join() throws InterruptedException { if (thread != null) thread.join(); }
}

#include "reverse_audio.h"

#ifdef _WIN32
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <libavcodec/avcodec.h>
#include <libavutil/opt.h>
#include <libavutil/time.h>
#include "util/log.h"
#include <string.h>

// Local GUIDs avoid requiring extra SDK/uuid import libraries.
static const GUID audio_enumerator_class = {0xbcde0395,0xe52f,0x467c,{0x8e,0x3d,0xc4,0x57,0x92,0x91,0x69,0x2e}};
static const GUID audio_enumerator_iid = {0xa95664d2,0x9614,0x4f35,{0xa7,0x46,0xde,0x8d,0xb6,0x36,0x17,0xe6}};
static const GUID audio_client_iid = {0x1cb9ad4c,0xdbfa,0x4c32,{0xb1,0x78,0xc2,0xf5,0x68,0xa7,0x03,0xb2}};
static const GUID audio_capture_iid = {0xc8adbd64,0xe71e,0x48a0,{0xa4,0xde,0x18,0x5c,0x39,0x5c,0xd3,0x17}};

#define AUDIO_FRAMES 480 // 10 ms at 48 kHz
#define AUDIO_BYTES_PER_FRAME 4 // S16 stereo

static bool
capture_session(const struct sc_reverse_audio_callbacks *cbs, void *userdata) {
    IMMDeviceEnumerator *enumerator = NULL;
    IMMDevice *device = NULL;
    IAudioClient *client = NULL;
    IAudioCaptureClient *capture = NULL;
    AVCodecContext *encoder = NULL;
    AVFrame *frame = NULL;
    AVPacket *packet = NULL;
    bool started = false;
    bool ok = false;
    HRESULT hr = CoCreateInstance(&audio_enumerator_class, NULL, CLSCTX_ALL,
                                  &audio_enumerator_iid, (void **) &enumerator);
    if (FAILED(hr)) goto end;
    hr = enumerator->lpVtbl->GetDefaultAudioEndpoint(enumerator, eRender, eConsole, &device);
    if (FAILED(hr)) goto end;
    hr = device->lpVtbl->Activate(device, &audio_client_iid, CLSCTX_ALL, NULL, (void **) &client);
    if (FAILED(hr)) goto end;
    WAVEFORMATEX format = {
        .wFormatTag = WAVE_FORMAT_PCM, .nChannels = 2,
        .nSamplesPerSec = 48000, .nAvgBytesPerSec = 192000,
        .nBlockAlign = AUDIO_BYTES_PER_FRAME, .wBitsPerSample = 16,
    };
    hr = client->lpVtbl->Initialize(client, AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
        | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, 1000000, 0, &format, NULL);
    if (FAILED(hr)) goto end;
    hr = client->lpVtbl->GetService(client, &audio_capture_iid, (void **) &capture);
    if (FAILED(hr)) goto end;

    const AVCodec *codec = avcodec_find_encoder_by_name("libopus");
    if (!codec) { LOGW("Desktop audio requires the FFmpeg libopus encoder"); goto end; }
    encoder = avcodec_alloc_context3(codec);
    if (!encoder) goto end;
    encoder->sample_fmt = AV_SAMPLE_FMT_S16;
    encoder->sample_rate = 48000;
    av_channel_layout_default(&encoder->ch_layout, 2);
    encoder->time_base = (AVRational) {1, 48000};
    encoder->bit_rate = 128000;
    av_opt_set(encoder->priv_data, "application", "lowdelay", 0);
    av_opt_set(encoder->priv_data, "frame_duration", "10", 0);
    if (avcodec_open2(encoder, codec, NULL) < 0 || encoder->frame_size != AUDIO_FRAMES
            || encoder->extradata_size != 19) goto end;
    frame = av_frame_alloc();
    packet = av_packet_alloc();
    if (!frame || !packet) goto end;
    frame->format = encoder->sample_fmt;
    frame->sample_rate = encoder->sample_rate;
    frame->nb_samples = AUDIO_FRAMES;
    av_channel_layout_copy(&frame->ch_layout, &encoder->ch_layout);
    if (av_frame_get_buffer(frame, 0) < 0) goto end;
    if (!cbs->send(userdata, encoder->extradata, encoder->extradata_size, 0, SC_REVERSE_AUDIO_CONFIG)) goto end;
    hr = client->lpVtbl->Start(client);
    if (FAILED(hr)) goto end;
    started = true;
    LOGI("Desktop audio: WASAPI loopback -> Opus, 48 kHz stereo, 128 kbps, 10 ms");
    int16_t pcm[AUDIO_FRAMES * 2];
    unsigned filled = 0;
    unsigned pending_count = 0;
    int64_t pending[SC_REVERSE_AUDIO_WINDOW];
    int64_t sample_pts = 0;
    bool reported_signal = false;
    while (!cbs->stopped(userdata) && cbs->enabled(userdata)) {
        UINT32 available;
        hr = capture->lpVtbl->GetNextPacketSize(capture, &available);
        if (FAILED(hr)) goto end;
        if (!available) { Sleep(2); continue; }
        BYTE *data;
        UINT32 frames;
        DWORD flags;
        hr = capture->lpVtbl->GetBuffer(capture, &data, &frames, &flags, NULL, NULL);
        if (FAILED(hr)) goto end;
        // Copy/release the WASAPI packet before doing socket IO. Capture must
        // never hold the audio engine's buffer across a network stall.
        size_t byte_count = (size_t) frames * AUDIO_BYTES_PER_FRAME;
        uint8_t *copy = byte_count <= 192000 ? av_malloc(byte_count) : NULL;
        if (copy) {
            if (flags & AUDCLNT_BUFFERFLAGS_SILENT) memset(copy, 0, byte_count);
            else memcpy(copy, data, byte_count);
        }
        capture->lpVtbl->ReleaseBuffer(capture, frames);
        if (!copy) goto end;
        if (flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY) filled = 0;
        // If the engine accumulated old audio, retain only its newest 10 ms.
        unsigned offset = frames > AUDIO_FRAMES * 2 ? frames - AUDIO_FRAMES : 0;
        if (offset) filled = 0;
        bool send_ok = true;
        while (offset < frames && cbs->enabled(userdata)) {
            unsigned count = AUDIO_FRAMES - filled;
            if (count > frames - offset) count = frames - offset;
            memcpy(pcm + filled * 2, copy + offset * AUDIO_BYTES_PER_FRAME, count * AUDIO_BYTES_PER_FRAME);
            filled += count;
            offset += count;
            if (filled != AUDIO_FRAMES) continue;
            filled = 0;
            int64_t ack = cbs->acked_pts(userdata);
            unsigned consumed = 0;
            while (consumed < pending_count && pending[consumed] <= ack) ++consumed;
            pending_count -= consumed;
            memmove(pending, pending + consumed, pending_count * sizeof(*pending));
            // Discard live samples when the phone is behind instead of building
            // seconds of audio in TCP buffers during a static desktop.
            if (pending_count == SC_REVERSE_AUDIO_WINDOW) continue;
            if (!reported_signal) {
                for (unsigned i = 0; i < AUDIO_FRAMES * 2; ++i) {
                    if (pcm[i] > 64 || pcm[i] < -64) {
                        reported_signal = true;
                        LOGI("Desktop audio captured non-silent samples");
                        break;
                    }
                }
            }
            if (av_frame_make_writable(frame) < 0) { send_ok = false; break; }
            memcpy(frame->data[0], pcm, sizeof(pcm));
            frame->pts = sample_pts;
            sample_pts += AUDIO_FRAMES;
            if (avcodec_send_frame(encoder, frame) < 0) { send_ok = false; break; }
            int result;
            while ((result = avcodec_receive_packet(encoder, packet)) >= 0) {
                int64_t pts = av_gettime_relative();
                send_ok = cbs->send(userdata, packet->data, packet->size, pts, SC_REVERSE_AUDIO_PACKET);
                av_packet_unref(packet);
                if (!send_ok) break;
                if (pending_count == SC_REVERSE_AUDIO_WINDOW) { send_ok = false; break; }
                pending[pending_count++] = pts;
            }
            if (!send_ok || (result != AVERROR(EAGAIN) && result != AVERROR_EOF)) { send_ok = false; break; }
        }
        av_free(copy);
        if (!send_ok) goto end;
    }
    ok = true;
end:
    if (!ok && !cbs->stopped(userdata)) LOGW("Desktop audio unavailable (WASAPI/Opus); video continues (0x%08lx)", (unsigned long) hr);
    if (started) client->lpVtbl->Stop(client);
    // Drain and discard the encoder tail; no stale sound after mute or stop.
    if (encoder && packet && avcodec_is_open(encoder)) {
        avcodec_send_frame(encoder, NULL);
        while (avcodec_receive_packet(encoder, packet) >= 0) av_packet_unref(packet);
    }
    av_packet_free(&packet);
    av_frame_free(&frame);
    avcodec_free_context(&encoder);
    if (capture) capture->lpVtbl->Release(capture);
    if (client) client->lpVtbl->Release(client);
    if (device) device->lpVtbl->Release(device);
    if (enumerator) enumerator->lpVtbl->Release(enumerator);
    return ok;
}

void
sc_reverse_audio_run(const struct sc_reverse_audio_callbacks *cbs, void *userdata) {
    HRESULT hr = CoInitializeEx(NULL, COINIT_MULTITHREADED);
    if (FAILED(hr)) { LOGW("Could not initialize desktop audio COM"); return; }
    while (!cbs->stopped(userdata)) {
        if (!cbs->enabled(userdata)) { Sleep(20); continue; }
        if (!capture_session(cbs, userdata)) {
            const uint8_t unavailable = 0;
            if (!cbs->send(userdata, &unavailable, 1, 0, SC_REVERSE_AUDIO_UNAVAILABLE)) break;
            for (unsigned i = 0; i < 100 && !cbs->stopped(userdata); ++i) Sleep(20);
        }
    }
    CoUninitialize();
}
#else
void sc_reverse_audio_run(const struct sc_reverse_audio_callbacks *cbs, void *userdata) {
    (void) cbs; (void) userdata;
}
#endif

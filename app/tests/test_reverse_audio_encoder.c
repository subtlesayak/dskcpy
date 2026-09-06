#include <assert.h>
#include <math.h>
#include <string.h>
#include <libavcodec/avcodec.h>
#include "reverse_audio_encoder.h"

struct fixture {
    bool enabled, stopped, fail_send;
    int config_count, packets;
    int64_t ack, last_pts;
    uint8_t config[19], packet[4096];
    size_t size;
};
static bool stopped(void *p) { return ((struct fixture *)p)->stopped; }
static bool enabled(void *p) { return ((struct fixture *)p)->enabled; }
static int64_t acked(void *p) { return ((struct fixture *)p)->ack; }
static bool send_packet(void *p, const uint8_t *data, size_t size, int64_t pts, uint32_t flags) {
    struct fixture *f = p;
    if (f->fail_send) return false;
    if (flags == SC_REVERSE_AUDIO_CONFIG) {
        assert(size == 19 && !memcmp(data, "OpusHead", 8));
        assert(data[8] == 1 && data[9] == 2 && data[18] == 0);
        memcpy(f->config, data, size); ++f->config_count;
    } else {
        assert(flags == SC_REVERSE_AUDIO_PACKET && size && size <= sizeof(f->packet));
        assert(pts > f->last_pts);
        memcpy(f->packet, data, size); f->size = size;
        f->last_pts = pts; ++f->packets;
    }
    return true;
}
static const struct sc_reverse_audio_callbacks callbacks = {
    .stopped = stopped, .enabled = enabled, .acked_pts = acked, .send = send_packet,
};

static void test_float_conversion(void) {
    float left[] = {-2, -0.5f, NAN, 0.5f, 2, INFINITY};
    float right[] = {2, 0.5f, 0, -0.5f, -2, -INFINITY};
    int16_t expected[] = {-32768, 32767, -16384, 16384, 0, 0, 16384, -16384, 32767, -32768, 0, 0};
    int16_t out[12]; float packed[12];
    sc_reverse_audio_from_float(out, left, right, 6, true);
    assert(!memcmp(out, expected, sizeof(out)));
    for (unsigned i = 0; i < 6; ++i) { packed[2*i] = left[i]; packed[2*i+1] = right[i]; }
    sc_reverse_audio_from_float(out, packed, NULL, 6, false);
    assert(!memcmp(out, expected, sizeof(out)));
}

static void test_opus_and_backpressure(void) {
    struct fixture f = {.enabled = true, .ack = -1, .last_pts = -1};
    struct sc_reverse_audio_encoder *e = sc_reverse_audio_encoder_create(&callbacks, &f);
    assert(e); // Missing libopus is a build/dependency failure, not a skipped test.
    int16_t pcm[SC_REVERSE_AUDIO_MAX_CHUNK * 2];
    for (unsigned i = 0; i < sizeof(pcm)/sizeof(*pcm); ++i) pcm[i] = (i % 64) * 300 - 9000;
    assert(sc_reverse_audio_encoder_push(e, pcm, 240, 100000, 100000));
    assert(f.packets == 0 && f.config_count == 0);
    assert(sc_reverse_audio_encoder_push(e, pcm, 240, 105000, 105000));
    assert(f.packets == 1 && f.config_count == 1);

    const AVCodec *decoder = avcodec_find_decoder(AV_CODEC_ID_OPUS);
    AVCodecContext *decode = avcodec_alloc_context3(decoder);
    assert(decode);
    decode->extradata = av_mallocz(19 + AV_INPUT_BUFFER_PADDING_SIZE);
    assert(decode->extradata);
    memcpy(decode->extradata, f.config, 19); decode->extradata_size = 19;
    assert(avcodec_open2(decode, decoder, NULL) >= 0);
    AVPacket *packet = av_packet_alloc(); AVFrame *frame = av_frame_alloc();
    assert(packet && frame && av_new_packet(packet, f.size) >= 0);
    memcpy(packet->data, f.packet, f.size);
    assert(avcodec_send_packet(decode, packet) >= 0);
    assert(avcodec_receive_frame(decode, frame) >= 0);
    assert(frame->sample_rate == 48000 && frame->ch_layout.nb_channels == 2);
    assert(frame->nb_samples > 0 && frame->nb_samples <= 480);
    av_frame_free(&frame); av_packet_free(&packet); avcodec_free_context(&decode);

    assert(sc_reverse_audio_encoder_push(e, pcm, 1920, 110000, 110000));
    assert(f.packets == SC_REVERSE_AUDIO_WINDOW);
    f.ack = INT64_MAX;
    assert(sc_reverse_audio_encoder_push(e, pcm, 480, 150000, 150000));
    assert(f.packets == 4); // Future ACK cannot bypass the window.
    f.ack = f.last_pts;
    assert(sc_reverse_audio_encoder_push(e, pcm, 480, 160000, 160000));
    assert(f.packets == 5 && f.config_count == 1);
    f.enabled = false;
    assert(sc_reverse_audio_encoder_push(e, pcm, 480, 170000, 170000));
    assert(f.packets == 5);
    sc_reverse_audio_encoder_destroy(e);
    assert(f.packets == 5); // No encoder tail on mute/destruction.
    f.enabled = true;
    e = sc_reverse_audio_encoder_create(&callbacks, &f);
    assert(e);
    assert(sc_reverse_audio_encoder_push(e, pcm, 480, 100000, 200000));
    assert(f.packets == 5); // Stale callback discarded, not replayed.
    assert(sc_reverse_audio_encoder_push(e, pcm, 240, 210000, 210000));
    sc_reverse_audio_encoder_discard_partial(e);
    assert(sc_reverse_audio_encoder_push(e, pcm, 240, 220000, 220000));
    assert(f.packets == 5);
    assert(sc_reverse_audio_encoder_push(e, pcm, 240, 225000, 225000));
    assert(f.packets == 6 && f.config_count == 2);
    f.ack = f.last_pts;
    assert(sc_reverse_audio_encoder_push(e, pcm, 4800, 230000, 230000));
    assert(f.packets == 10); // Oversized capture retains at most newest 40 ms.
    assert(!sc_reverse_audio_encoder_push(e, pcm, 4801, 230000, 230000));
    f.ack = f.last_pts; f.fail_send = true;
    assert(!sc_reverse_audio_encoder_push(e, pcm, 480, 240000, 240000));
    sc_reverse_audio_encoder_destroy(e);
    f.fail_send = false; f.stopped = true;
    e = sc_reverse_audio_encoder_create(&callbacks, &f); assert(e);
    assert(sc_reverse_audio_encoder_push(e, pcm, 480, 250000, 250000));
    assert(f.packets == 10);
    sc_reverse_audio_encoder_destroy(e);
}

int main(void) {
    test_float_conversion();
    test_opus_and_backpressure();
    return 0;
}

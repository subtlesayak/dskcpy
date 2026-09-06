#include "reverse_audio_encoder.h"

#include <libavcodec/avcodec.h>
#include <libavutil/opt.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>

struct sc_reverse_audio_encoder {
    AVCodecContext *codec;
    AVFrame *frame;
    AVPacket *packet;
    const struct sc_reverse_audio_callbacks *cbs;
    void *userdata;
    int16_t pcm[SC_REVERSE_AUDIO_FRAMES * 2];
    unsigned filled, pending_count;
    int64_t pending[SC_REVERSE_AUDIO_WINDOW];
    int64_t sample_pts, last_pts, partial_us;
    bool configured;
};

void
sc_reverse_audio_encoder_destroy(struct sc_reverse_audio_encoder *e) {
    if (!e) return;
    av_packet_free(&e->packet);
    av_frame_free(&e->frame);
    avcodec_free_context(&e->codec);
    free(e);
}

struct sc_reverse_audio_encoder *
sc_reverse_audio_encoder_create(const struct sc_reverse_audio_callbacks *cbs,
                               void *userdata) {
    const AVCodec *codec = avcodec_find_encoder_by_name("libopus");
    if (!codec) return NULL;
    struct sc_reverse_audio_encoder *e = calloc(1, sizeof(*e));
    if (!e) return NULL;
    e->cbs = cbs; e->userdata = userdata; e->last_pts = -1;
    e->codec = avcodec_alloc_context3(codec);
    e->frame = av_frame_alloc(); e->packet = av_packet_alloc();
    if (!e->codec || !e->frame || !e->packet) goto error;
    e->codec->sample_fmt = AV_SAMPLE_FMT_S16;
    e->codec->sample_rate = 48000;
    av_channel_layout_default(&e->codec->ch_layout, 2);
    e->codec->time_base = (AVRational){1, 48000};
    e->codec->bit_rate = 128000;
    if (av_opt_set(e->codec->priv_data, "application", "lowdelay", 0) < 0
            || av_opt_set(e->codec->priv_data, "frame_duration", "10", 0) < 0
            || avcodec_open2(e->codec, codec, NULL) < 0
            || e->codec->frame_size != SC_REVERSE_AUDIO_FRAMES
            || e->codec->extradata_size != 19) goto error;
    e->frame->format = e->codec->sample_fmt;
    e->frame->sample_rate = 48000;
    e->frame->nb_samples = SC_REVERSE_AUDIO_FRAMES;
    if (av_channel_layout_copy(&e->frame->ch_layout, &e->codec->ch_layout) < 0
            || av_frame_get_buffer(e->frame, 0) < 0) goto error;
    return e;
error:
    sc_reverse_audio_encoder_destroy(e);
    return NULL;
}

static bool enabled(struct sc_reverse_audio_encoder *e) {
    return !e->cbs->stopped(e->userdata) && e->cbs->enabled(e->userdata);
}

void sc_reverse_audio_encoder_discard_partial(struct sc_reverse_audio_encoder *e) {
    if (e) e->filled = 0;
}

bool
sc_reverse_audio_encoder_push(struct sc_reverse_audio_encoder *e,
                             const int16_t *stereo, size_t frames,
                             int64_t captured_us, int64_t now_us) {
    if (!e || (!stereo && frames) || frames > SC_REVERSE_AUDIO_MAX_CHUNK) return false;
    if (!enabled(e) || captured_us > now_us
            || now_us - captured_us > SC_REVERSE_AUDIO_MAX_AGE_US) {
        e->filled = 0;
        return true;
    }
    if (e->filled && now_us - e->partial_us > SC_REVERSE_AUDIO_MAX_AGE_US) e->filled = 0;
    // A delayed capture callback must not create an unbounded audio catch-up.
    const size_t keep = SC_REVERSE_AUDIO_FRAMES * SC_REVERSE_AUDIO_WINDOW;
    if (frames > keep) { stereo += (frames - keep) * 2; frames = keep; e->filled = 0; }
    while (frames && enabled(e)) {
        if (!e->filled) e->partial_us = captured_us;
        size_t count = SC_REVERSE_AUDIO_FRAMES - e->filled;
        if (count > frames) count = frames;
        memcpy(e->pcm + e->filled * 2, stereo, count * 2 * sizeof(*stereo));
        e->filled += count; stereo += count * 2; frames -= count;
        if (e->filled != SC_REVERSE_AUDIO_FRAMES) continue;
        e->filled = 0;
        int64_t ack = e->cbs->acked_pts(e->userdata);
        // Reject future ACKs even if a caller forgets the wire-level check.
        if (ack <= e->last_pts) {
            unsigned consumed = 0;
            while (consumed < e->pending_count && e->pending[consumed] <= ack) ++consumed;
            e->pending_count -= consumed;
            memmove(e->pending, e->pending + consumed, e->pending_count * sizeof(*e->pending));
        }
        if (e->pending_count == SC_REVERSE_AUDIO_WINDOW) continue;
        if (!e->configured) {
            if (!e->cbs->send(e->userdata, e->codec->extradata, 19, 0, SC_REVERSE_AUDIO_CONFIG)) return false;
            e->configured = true;
        }
        if (!enabled(e)) return true;
        if (av_frame_make_writable(e->frame) < 0) return false;
        memcpy(e->frame->data[0], e->pcm, sizeof(e->pcm));
        e->frame->pts = e->sample_pts; e->sample_pts += SC_REVERSE_AUDIO_FRAMES;
        if (avcodec_send_frame(e->codec, e->frame) < 0) return false;
        int result;
        while ((result = avcodec_receive_packet(e->codec, e->packet)) >= 0) {
            int64_t pts = now_us > e->last_pts ? now_us : e->last_pts + 1;
            bool ok = e->pending_count < SC_REVERSE_AUDIO_WINDOW
                && e->packet->size > 0 && e->packet->size <= 4096;
            if (ok && enabled(e)) {
                ok = e->cbs->send(e->userdata, e->packet->data, e->packet->size, pts, SC_REVERSE_AUDIO_PACKET);
                if (ok) { e->pending[e->pending_count++] = pts; e->last_pts = pts; }
            }
            av_packet_unref(e->packet);
            if (!ok) return false;
        }
        if (result != AVERROR(EAGAIN) && result != AVERROR_EOF) return false;
    }
    return true;
}

static int16_t sample_s16(float value) {
    if (!isfinite(value)) return 0;
    if (value >= 1) return INT16_MAX;
    if (value <= -1) return INT16_MIN;
    return (int16_t)(value * 32768.0f);
}

void
sc_reverse_audio_from_float(int16_t *out, const float *left,
                           const float *right, size_t frames, bool planar) {
    for (size_t i = 0; i < frames; ++i) {
        out[2 * i] = sample_s16(left[planar ? i : 2 * i]);
        out[2 * i + 1] = sample_s16(planar ? right[i] : left[2 * i + 1]);
    }
}

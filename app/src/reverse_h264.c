#include "reverse_h264.h"

#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <libavcodec/avcodec.h>
#include <libavutil/frame.h>

static size_t
start_code(const uint8_t *bytes, size_t size, size_t at, size_t *payload) {
    for (size_t i = at; i + 3 < size; ++i) {
        if (!bytes[i] && !bytes[i+1]) {
            if (bytes[i+2] == 1) { *payload = i + 3; return i; }
            if (!bytes[i+2] && bytes[i+3] == 1) { *payload = i + 4; return i; }
        }
    }
    *payload = size;
    return size;
}

bool
sc_reverse_h264_profile(const uint8_t *bytes, size_t size, uint8_t profile[3]) {
    if (!bytes || !profile || size > 16u * 1024u * 1024u) return false;
    size_t payload;
    start_code(bytes, size, 0, &payload);
    while (payload < size) {
        size_t next;
        size_t end = start_code(bytes, size, payload + 1, &next);
        if ((bytes[payload] & 31) == 7 && !(bytes[payload] & 128) && end - payload >= 4) {
            memcpy(profile, bytes + payload + 1, 3);
            return true;
        }
        payload = next;
    }
    return false;
}

static bool
inspect(const uint8_t *bytes, size_t size, const uint8_t profile[3],
        bool *sps, bool *pps, bool *idr) {
    if (!size) return true;
    size_t payload;
    start_code(bytes, size, 0, &payload);
    if (payload == size) return false;
    while (payload < size) {
        size_t next;
        size_t end = start_code(bytes, size, payload + 1, &next);
        if (bytes[payload] & 128) return false;
        unsigned type = bytes[payload] & 31;
        if (type == 7) {
            if (end - payload < 4 || memcmp(bytes + payload + 1, profile, 3)) return false;
            *sps = true;
        } else if (type == 8) {
            if (end - payload < 2) return false;
            *pps = true;
        } else if (type == 5) *idr = true;
        payload = next;
    }
    return true;
}

bool
sc_reverse_h264_parameters(const uint8_t *config, size_t config_size,
                           const uint8_t *picture, size_t picture_size,
                           uint8_t **parameters, size_t *parameters_size) {
    if (!parameters || !parameters_size) return false;
    *parameters = NULL; *parameters_size = 0;
    if ((config_size && !config) || (picture_size && !picture)
            || config_size > 65536 || picture_size > 16u*1024u*1024u) return false;
    const uint8_t *sets[32]; size_t sizes[32], count = 0, total = 0;
    bool sps = false, pps = false;
    for (unsigned pass = 0; pass < 2; ++pass) {
        const uint8_t *bytes = pass ? picture : config;
        size_t size = pass ? picture_size : config_size, payload;
        start_code(bytes, size, 0, &payload);
        while (payload < size) {
            size_t next, end = start_code(bytes, size, payload + 1, &next);
            unsigned type = bytes[payload] & 31;
            if (type == 7 || type == 8) {
                size_t length = end - payload;
                if (length < 2 || (bytes[payload]&128)) return false;
                bool duplicate = false;
                for (size_t i=0; i<count; ++i)
                    if (sizes[i]==length && !memcmp(sets[i],bytes+payload,length)) duplicate = true;
                if (!duplicate) {
                    if (count==32 || total>65532 || length>65536-total-4) return false;
                    sets[count]=bytes+payload; sizes[count++]=length; total+=length+4;
                }
                if (type==7) sps=true; else pps=true;
            }
            payload=next;
        }
    }
    if (!sps || !pps) return false;
    uint8_t *out = malloc(total);
    if (!out) return false;
    size_t offset = 0;
    // Parameter-set dependency ordering is independent of source packet layout.
    for (unsigned type=7; type<=8; ++type) for (size_t i=0; i<count; ++i) {
        if ((sets[i][0]&31)!=type) continue;
        memcpy(out+offset,(uint8_t[]){0,0,0,1},4);offset+=4;
        memcpy(out+offset,sets[i],sizes[i]);offset+=sizes[i];
    }
    *parameters=out;*parameters_size=total;
    return true;
}

bool
sc_reverse_h264_validate(const uint8_t *config, size_t config_size,
                         const uint8_t *picture, size_t picture_size,
                         unsigned width, unsigned height,
                         const uint8_t expected_profile[3]) {
    if (!expected_profile || !picture || !picture_size || !width || !height
            || width > 16384 || height > 16384 || config_size > 65536
            || (config_size && !config) || picture_size > 16u * 1024u * 1024u) return false;
    bool sps = false, pps = false, idr = false, config_idr = false;
    if (!inspect(config, config_size, expected_profile, &sps, &pps, &config_idr) || config_idr
            || !inspect(picture, picture_size, expected_profile, &sps, &pps, &idr)
            || !sps || !pps || !idr) return false;

    // Decode exactly one bounded candidate in memory using the public software
    // decoder. Never opens a capture device, hardware decoder or input API.
    const AVCodec *codec = avcodec_find_decoder_by_name("h264");
    if (!codec) return false;
    AVCodecContext *decoder = avcodec_alloc_context3(codec);
    AVPacket *packet = av_packet_alloc();
    AVFrame *frame = av_frame_alloc();
    bool ok = false;
    if (!decoder || !packet || !frame) goto done;
    decoder->thread_count = 1;
    decoder->thread_type = 0;
    // The coded macroblock canvas may exceed the cropped display dimensions.
    // Bound allocation to their 32-pixel alignment, then verify exact output size.
    decoder->max_pixels = (int64_t)((width+31)&~31u) * ((height+31)&~31u);
    decoder->flags |= AV_CODEC_FLAG_LOW_DELAY;
    if (avcodec_open2(decoder, codec, NULL) < 0
            || av_new_packet(packet, (int)(config_size + picture_size)) < 0) goto done;
    if (config_size) memcpy(packet->data, config, config_size);
    memcpy(packet->data + config_size, picture, picture_size);
    if (avcodec_send_packet(decoder, packet) < 0) goto done;
    int result = avcodec_receive_frame(decoder, frame);
    if (result == AVERROR(EAGAIN)) {
        if (avcodec_send_packet(decoder, NULL) < 0) goto done;
        result = avcodec_receive_frame(decoder, frame);
    }
    ok = result >= 0 && frame->width == (int)width && frame->height == (int)height
        && !frame->decode_error_flags;
done:
    av_frame_free(&frame);
    av_packet_free(&packet);
    avcodec_free_context(&decoder);
    return ok;
}

#include "common.h"

#include <assert.h>
#include <stdbool.h>
#include <errno.h>
#include <string.h>
#include <libavcodec/avcodec.h>

// Exercise the production receive boundary with a finite memory transport and
// an allocation probe. Oversized advertisements must never allocate or read.
static unsigned allocations, reads;
static int allocation_size;
static bool refuse_allocation;
static const uint8_t *body;
static size_t body_size;
static int packet_allocate(AVPacket *packet, int size);
#define av_new_packet packet_allocate
#include "../src/demuxer.c"
#undef av_new_packet

static int packet_allocate(AVPacket *packet, int size) {
    ++allocations;
    allocation_size = size;
    return refuse_allocation ? AVERROR(ENOMEM) : av_new_packet(packet, size);
}

ssize_t net_recv_all(sc_socket socket, void *buffer, size_t size) {
    (void) socket;
    ++reads;
    size_t count = size < body_size ? size : body_size;
    memcpy(buffer, body, count);
    return (ssize_t) count;
}

bool sc_thread_create(sc_thread *t, sc_thread_fn fn, const char *name, void *data) {
    (void) t; (void) fn; (void) name; (void) data;
    assert(!"Packet boundary test must not start a worker");
    return false;
}

void sc_thread_join(sc_thread *t, int *status) {
    (void) t; (void) status;
    assert(!"Packet boundary test must not join a worker");
}

static bool receive(uint32_t size, uint64_t flags, AVPacket *packet) {
    uint8_t header[12];
    sc_write64be(header, flags);
    sc_write32be(header + 8, size);
    struct sc_demuxer demuxer = {0};
    return sc_demuxer_recv_packet(&demuxer, header, packet);
}

int main(void) {
    AVPacket *packet = av_packet_alloc();
    assert(packet);
    const uint32_t limit = UINT32_C(64) * 1024 * 1024;
    const uint32_t rejected[] = {0, limit + 1, INT32_MAX, UINT32_MAX};
    refuse_allocation = true;
    for (unsigned i = 0; i < sizeof(rejected) / sizeof(*rejected); ++i) {
        allocations = reads = 0;
        assert(!receive(rejected[i], 123, packet));
        assert(!allocations && !reads && !packet->data);
    }
    // Inclusive upper boundary is accepted by the guard, without actually
    // allocating 64 MiB in this test. Allocation failure does not read a body.
    allocations = reads = 0;
    assert(!receive(limit, 123, packet));
    assert(allocations == 1 && allocation_size == (int) limit && !reads);
    refuse_allocation = false;
    const uint8_t payload[] = {0, 1, 2, 3, 0xff};
    body = payload; body_size = sizeof(payload);
    assert(receive(sizeof(payload), SC_PACKET_FLAG_KEY_FRAME | 123, packet));
    assert(packet->size == sizeof(payload));
    assert(!memcmp(packet->data, payload, sizeof(payload)));
    assert(packet->pts == 123 && packet->dts == 123);
    assert(packet->flags & AV_PKT_FLAG_KEY);
    av_packet_unref(packet);
    assert(receive(1, SC_PACKET_FLAG_CONFIG, packet));
    assert(packet->size == 1 && packet->pts == AV_NOPTS_VALUE);
    av_packet_unref(packet);
    body_size = 2;
    assert(!receive(sizeof(payload), 124, packet));
    assert(!packet->data && packet->size == 0);
    av_packet_free(&packet);
    return 0;
}

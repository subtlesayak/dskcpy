// Opt-in macOS 13+ host. Apple hardware validation is required before release.
#import <Cocoa/Cocoa.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <VideoToolbox/VideoToolbox.h>
#import <ApplicationServices/ApplicationServices.h>
#import <CoreAudio/CoreAudio.h>
#import <Carbon/Carbon.h>

#include "reverse_display.h"
#include "reverse_macos_helpers.h"
#include "reverse_watchdog.h"
#include "reverse_audio.h"
#include "reverse_audio_encoder.h"
#include "reverse_macos_audio.h"
#include "receiver.h"
#include "options.h"
#include "util/binary.h"
#include "util/env.h"
#include "util/log.h"
#include <SDL3/SDL.h>
#include <libavutil/time.h>
#include <math.h>
#include <poll.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

struct mac_contact { uint64_t id; CGPoint point; };
struct mac_state {
    sc_socket video_socket, control_socket;
    sc_mutex mutex, send_mutex;
    bool mutex_ready, send_mutex_ready;
    _Atomic bool stopped, failed, disconnected, quit, paused, force_key, audio_enabled, audio_available;
    _Atomic int64_t acked_pts, sent_pts, encoding_since, audio_acked_pts;
    struct sc_reverse_watchdog watchdog, audio_watchdog;
    CMSampleBufferRef latest_audio; // One bounded callback buffer, protected by mutex.
    int64_t audio_received_us;
    uint64_t audio_epoch, audio_sequence; // Epoch changes even for rapid mute/unmute.
    CVPixelBufferRef latest; // Exactly one newest capture, protected by mutex.
    uint64_t generation;
    VTCompressionSessionRef encoder;
    bool config_sent;
    uint16_t width, height;
    unsigned fps;
    int64_t start_us, metrics_us;
    CGRect display_bounds;
    struct mac_contact contacts[2]; // Owned exclusively by the input thread.
    unsigned contact_count;
    bool mouse_down, scrolling;
    CGPoint mouse_point, scroll_point;
};

@interface SCMacState : NSObject { @public struct mac_state state; }
@end
@implementation SCMacState
- (instancetype)init {
    if ((self = [super init])) {
        atomic_init(&state.stopped, false); atomic_init(&state.failed, false);
        atomic_init(&state.disconnected, false); atomic_init(&state.quit, false);
        atomic_init(&state.paused, false); atomic_init(&state.force_key, true);
        atomic_init(&state.audio_enabled, false); atomic_init(&state.audio_available, false);
        atomic_init(&state.audio_acked_pts, -1); atomic_init(&state.acked_pts, -1);
        atomic_init(&state.sent_pts, -1); atomic_init(&state.encoding_since, 0);
        sc_reverse_watchdog_init(&state.watchdog);
        sc_reverse_watchdog_init(&state.audio_watchdog);
        state.audio_watchdog.paused = true;
        state.mutex_ready = sc_mutex_init(&state.mutex);
        state.send_mutex_ready = sc_mutex_init(&state.send_mutex);
        if (!state.mutex_ready || !state.send_mutex_ready) return nil;
    }
    return self;
}
- (void)dealloc {
    if (state.latest) CVPixelBufferRelease(state.latest);
    if (state.latest_audio) CFRelease(state.latest_audio);
    if (state.encoder) { VTCompressionSessionInvalidate(state.encoder); CFRelease(state.encoder); }
    if (state.mutex_ready) sc_mutex_destroy(&state.mutex);
    if (state.send_mutex_ready) sc_mutex_destroy(&state.send_mutex);
}
@end

static bool mac_audio_active(struct mac_state *s) {
    return atomic_load(&s->audio_enabled) && !atomic_load(&s->paused)
        && !atomic_load(&s->stopped) && !atomic_load(&s->failed);
}

@interface SCMacOutput : NSObject <SCStreamOutput, SCStreamDelegate>
@property(atomic, strong) SCMacState *owner;
@end
@implementation SCMacOutput
- (void)stream:(SCStream *)stream didOutputSampleBuffer:(CMSampleBufferRef)sample ofType:(SCStreamOutputType)type {
    (void)stream;
    SCMacState *owner = self.owner;
    if (!owner || atomic_load(&owner->state.stopped)
            || !CMSampleBufferDataIsReady(sample)) return;
    if (type == SCStreamOutputTypeAudio) {
        struct mac_state *s = &owner->state;
        // Never encode or perform socket I/O on an Apple capture callback.
        if (CMSampleBufferGetNumSamples(sample) <= 0
                || CMSampleBufferGetNumSamples(sample) > SC_REVERSE_AUDIO_MAX_CHUNK) return;
        sc_mutex_lock(&s->mutex);
        if (mac_audio_active(s)) {
            if (s->latest_audio) CFRelease(s->latest_audio);
            s->latest_audio = (CMSampleBufferRef)CFRetain(sample);
            s->audio_received_us = av_gettime_relative();
            ++s->audio_sequence;
        }
        sc_mutex_unlock(&s->mutex);
        return;
    }
    if (type != SCStreamOutputTypeScreen) return;
    NSArray *attachments = (__bridge NSArray *)CMSampleBufferGetSampleAttachmentsArray(sample, false);
    NSNumber *status = attachments.firstObject[SCStreamFrameInfoStatus];
    if (!status || status.integerValue != SCFrameStatusComplete) return;
    CVPixelBufferRef pixels = CMSampleBufferGetImageBuffer(sample);
    if (!pixels) return;
    CVPixelBufferRetain(pixels);
    sc_mutex_lock(&owner->state.mutex);
    CVPixelBufferRef old = owner->state.latest;
    owner->state.latest = pixels;
    ++owner->state.generation;
    sc_mutex_unlock(&owner->state.mutex);
    if (old) CVPixelBufferRelease(old);
}
- (void)stream:(SCStream *)stream didStopWithError:(NSError *)error {
    (void)stream;
    SCMacState *owner = self.owner;
    if (owner && !atomic_load(&owner->state.stopped)) {
        LOGE("Mac capture stopped (ScreenCaptureKit code %ld). Check Screen Recording permission and reconnect.", (long)error.code);
        atomic_store(&owner->state.failed, true);
    }
}
@end

// Completion objects survive a timeout; late Apple callbacks never reference
// stack locals or a destroyed session state.
@interface SCMacCompletion : NSObject
@property(atomic, strong) id value;
@property(atomic, strong) NSError *error;
@property(atomic) BOOL done;
@end
@implementation SCMacCompletion
@end

static bool mac_wait(SCMacCompletion *completion, double seconds) {
    int64_t end = av_gettime_relative() + (int64_t)(seconds * 1000000);
    while (!completion.done && av_gettime_relative() < end) {
        CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.01, false);
    }
    return completion.done && !completion.error;
}

static bool mac_send(struct mac_state *s, const void *data, size_t size, int64_t pts, uint32_t flags) {
    if (atomic_load(&s->stopped)) return false;
    if (!size || size > SC_REVERSE_MACOS_MAX_PACKET) {
        LOGE("VideoToolbox produced an invalid or oversized packet");
        atomic_store(&s->failed, true);
        return false;
    }
    uint8_t header[16];
    sc_write32be(header, (uint32_t)size); sc_write64be(header + 4, (uint64_t)pts); sc_write32be(header + 12, flags);
    sc_mutex_lock(&s->send_mutex);
    sc_mutex_lock(&s->mutex);
    bool audio = flags & (SC_REVERSE_AUDIO_CONFIG | SC_REVERSE_AUDIO_PACKET | SC_REVERSE_AUDIO_UNAVAILABLE);
    struct sc_reverse_watchdog *watchdog = audio ? &s->audio_watchdog : &s->watchdog;
    sc_reverse_watchdog_begin(watchdog, av_gettime_relative());
    if (audio ? flags == SC_REVERSE_AUDIO_PACKET : !(flags & 1u)) sc_reverse_watchdog_submit(watchdog, pts);
    sc_mutex_unlock(&s->mutex);
    bool ok = net_send_all(s->video_socket, header, sizeof(header)) == sizeof(header)
           && net_send_all(s->video_socket, data, size) == (ssize_t)size;
    sc_mutex_lock(&s->mutex); sc_reverse_watchdog_end(watchdog); sc_mutex_unlock(&s->mutex);
    sc_mutex_unlock(&s->send_mutex);
    if (!ok && !atomic_load(&s->stopped)) atomic_store(&s->failed, true);
    return ok;
}

static void mac_encoded(void *context, void *frame_context, OSStatus status,
                         VTEncodeInfoFlags info, CMSampleBufferRef sample) {
    (void)frame_context;
    @autoreleasepool {
        SCMacState *owner = (__bridge SCMacState *)context;
        struct mac_state *s = &owner->state;
        if (atomic_load(&s->stopped)) return;
        if (status != noErr) { LOGE("VideoToolbox encode failed (%d)", (int)status); atomic_store(&s->failed, true); return; }
        if ((info & kVTEncodeInfo_FrameDropped) || !sample) return;
        CMFormatDescriptionRef format = CMSampleBufferGetFormatDescription(sample);
        const uint8_t *parameter; size_t parameter_size, parameter_count; int length_size;
        if (CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, 0, &parameter, &parameter_size,
                &parameter_count, &length_size) != noErr || parameter_count < 2 || parameter_count > 16) {
            atomic_store(&s->failed, true); return;
        }
        NSMutableData *config = [NSMutableData data];
        const uint8_t prefix[] = {0, 0, 0, 1};
        for (size_t i = 0; i < parameter_count; ++i) {
            if (CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, i, &parameter, &parameter_size,
                    NULL, NULL) != noErr || !parameter_size || parameter_size > 65536) {
                atomic_store(&s->failed, true); return;
            }
            [config appendBytes:prefix length:4]; [config appendBytes:parameter length:parameter_size];
        }
        if (!s->config_sent) {
            if (!mac_send(s, config.bytes, config.length, 0, 1)) return;
            s->config_sent = true;
        }
        CMBlockBufferRef block = CMSampleBufferGetDataBuffer(sample);
        size_t length = block ? CMBlockBufferGetDataLength(block) : 0;
        if (!length || length > SC_REVERSE_MACOS_MAX_PACKET) { atomic_store(&s->failed, true); return; }
        uint8_t *avcc = malloc(length), *annexb = NULL; size_t annexb_size = 0;
        bool valid = avcc && CMBlockBufferCopyDataBytes(block, 0, length, avcc) == noErr
            && sc_reverse_macos_annexb(avcc, length, (unsigned)length_size, &annexb, &annexb_size);
        free(avcc);
        if (!valid) { atomic_store(&s->failed, true); return; }
        NSArray *attachments = (__bridge NSArray *)CMSampleBufferGetSampleAttachmentsArray(sample, false);
        BOOL not_sync = [attachments.firstObject[(__bridge NSString *)kCMSampleAttachmentKey_NotSync] boolValue];
        NSMutableData *packet = [NSMutableData data];
        // Refresh SPS/PPS in-band on every IDR, without resetting the Android decoder.
        if (!not_sync) [packet appendData:config];
        [packet appendBytes:annexb length:annexb_size]; free(annexb);
        int64_t pts = CMTimeConvertScale(CMSampleBufferGetPresentationTimeStamp(sample), 1000000,
                                         kCMTimeRoundingMethod_Default).value;
        if (mac_send(s, packet.bytes, packet.length, pts, not_sync ? 0 : 2)) atomic_store(&s->sent_pts, pts);
    }
}

static bool mac_encoder(SCMacState *owner, const struct scrcpy_options *options) {
    struct mac_state *s = &owner->state;
    if (options->video_encoder && strcmp(options->video_encoder, "h264_videotoolbox")) {
        LOGE("The experimental Mac host supports auto or h264_videotoolbox, not the selected Windows/software encoder");
        return false;
    }
    NSDictionary *spec = @{(__bridge NSString *)kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder: @YES,
        (__bridge NSString *)kVTVideoEncoderSpecification_EnableLowLatencyRateControl: @YES};
    OSStatus result = VTCompressionSessionCreate(NULL, s->width, s->height, kCMVideoCodecType_H264,
        (__bridge CFDictionaryRef)spec, NULL, NULL, mac_encoded, (__bridge void *)owner, &s->encoder);
    if (result != noErr) { LOGE("Could not create the hardware VideoToolbox encoder (%d)", (int)result); return false; }
    NSDictionary *properties = @{
        (__bridge NSString *)kVTCompressionPropertyKey_RealTime: @YES,
        (__bridge NSString *)kVTCompressionPropertyKey_AllowFrameReordering: @NO,
        // Apple's low-latency rate control requires High profile and an
        // infinite GOP. Request recovery IDRs explicitly in the worker.
        (__bridge NSString *)kVTCompressionPropertyKey_ProfileLevel: (__bridge NSString *)kVTProfileLevel_H264_High_AutoLevel,
        (__bridge NSString *)kVTCompressionPropertyKey_ExpectedFrameRate: @(s->fps),
        (__bridge NSString *)kVTCompressionPropertyKey_AverageBitRate: @(options->video_bit_rate),
    };
    result = VTSessionSetProperties(s->encoder, (__bridge CFDictionaryRef)properties);
    if (result == noErr) result = VTCompressionSessionPrepareToEncodeFrames(s->encoder);
    if (result != noErr) { LOGE("Could not configure low-latency VideoToolbox (%d)", (int)result); return false; }
    LOGI("Reverse display encoder: h264_videotoolbox");
    return true;
}

static int mac_video_thread(void *context) {
    @autoreleasepool {
        SCMacState *owner = (__bridge SCMacState *)context;
        struct mac_state *s = &owner->state;
        int64_t pending[2]; unsigned pending_count = 0;
        uint64_t generation = 0; int64_t last_encode = 0, last_key = 0;
        while (!atomic_load(&s->stopped) && !atomic_load(&s->failed)) {
            @autoreleasepool {
                if (atomic_load(&s->paused)) { SDL_Delay(10); continue; }
                int64_t acked = atomic_load(&s->acked_pts);
                while (pending_count && pending[0] <= acked) {
                    if (--pending_count) pending[0] = pending[1];
                }
                int64_t now = av_gettime_relative();
                if (pending_count == 2 || now - last_encode < 1000000 / s->fps) { SDL_Delay(2); continue; }
                bool refresh = atomic_load(&s->force_key);
                sc_mutex_lock(&s->mutex);
                CVPixelBufferRef pixels = s->latest;
                uint64_t current = s->generation;
                if (pixels && (current != generation || refresh || now - last_encode >= 1000000)) CVPixelBufferRetain(pixels);
                else pixels = NULL;
                sc_mutex_unlock(&s->mutex);
                if (!pixels) { SDL_Delay(2); continue; }
                refresh = atomic_exchange(&s->force_key, false) || now - last_key >= 2000000;
                NSDictionary *properties = refresh ? @{(__bridge NSString *)kVTEncodeFrameOptionKey_ForceKeyFrame: @YES} : nil;
                int64_t pts = now - s->start_us;
                atomic_store(&s->encoding_since, now);
                OSStatus result = VTCompressionSessionEncodeFrame(s->encoder, pixels, CMTimeMake(pts, 1000000),
                    CMTimeMake(1, s->fps), (__bridge CFDictionaryRef)properties, NULL, NULL);
                CVPixelBufferRelease(pixels);
                // One local encoding operation at a time; the wire window permits
                // at most two unacknowledged frames, with newest capture retained.
                if (result == noErr) result = VTCompressionSessionCompleteFrames(s->encoder, kCMTimeInvalid);
                atomic_store(&s->encoding_since, 0);
                if (result != noErr) { LOGE("VideoToolbox submission failed (%d)", (int)result); atomic_store(&s->failed, true); break; }
                if (atomic_load(&s->sent_pts) == pts) pending[pending_count++] = pts;
                if (refresh) last_key = now;
                generation = current; last_encode = now;
            }
        }
    }
    return 0;
}

struct mac_audio_context { struct mac_state *state; uint64_t epoch; };
static bool mac_audio_stopped(void *context) {
    struct mac_state *s = ((struct mac_audio_context *)context)->state;
    return atomic_load(&s->stopped) || atomic_load(&s->failed);
}
static bool mac_audio_enabled(void *context) {
    struct mac_audio_context *audio = context;
    sc_mutex_lock(&audio->state->mutex);
    bool enabled = mac_audio_active(audio->state) && audio->epoch == audio->state->audio_epoch;
    sc_mutex_unlock(&audio->state->mutex);
    return enabled;
}
static int64_t mac_audio_acked(void *context) {
    return atomic_load(&((struct mac_audio_context *)context)->state->audio_acked_pts);
}
static bool mac_audio_send(void *context, const uint8_t *data, size_t size, int64_t pts, uint32_t flags) {
    struct mac_audio_context *audio = context;
    // Phone also discards in-flight data on mute. Avoid sending an old epoch's tail.
    if (!mac_audio_enabled(context)) return true;
    return mac_send(audio->state, data, size, pts, flags);
}


static int mac_audio_thread(void *context) {
    @autoreleasepool {
        SCMacState *owner = (__bridge SCMacState *)context;
        struct mac_state *s = &owner->state;
        struct mac_audio_context audio = {.state = s, .epoch = UINT64_MAX};
        static const struct sc_reverse_audio_callbacks cbs = {.stopped = mac_audio_stopped,
            .enabled = mac_audio_enabled, .acked_pts = mac_audio_acked, .send = mac_audio_send};
        struct sc_reverse_audio_encoder *encoder = NULL;
        uint64_t sequence = 0;
        bool unavailable = false;
        while (!mac_audio_stopped(&audio)) {
            sc_mutex_lock(&s->mutex);
            uint64_t epoch = s->audio_epoch, current = s->audio_sequence;
            bool active = mac_audio_active(s);
            CMSampleBufferRef sample = s->latest_audio; s->latest_audio = NULL;
            int64_t received = s->audio_received_us;
            sc_mutex_unlock(&s->mutex);
            if (audio.epoch != epoch || !active) {
                sc_reverse_audio_encoder_destroy(encoder); encoder = NULL;
                audio.epoch = epoch; sequence = current; unavailable = false;
            }
            if (active && !unavailable && (!atomic_load(&s->audio_available) || sample)) {
                if (!encoder && atomic_load(&s->audio_available)) {
                    encoder = sc_reverse_audio_encoder_create(&cbs, &audio);
                    if (encoder) LOGI("Desktop audio: ScreenCaptureKit -> Opus, 48 kHz stereo, 128 kbps, 10 ms (experimental)");
                }
                int16_t pcm[SC_REVERSE_AUDIO_MAX_CHUNK * 2]; size_t frames = 0;
                bool ok = encoder && sample && sc_reverse_macos_audio_pcm(sample, pcm, &frames);
                if (ok) {
                    if (current != sequence + 1) sc_reverse_audio_encoder_discard_partial(encoder);
                    ok = sc_reverse_audio_encoder_push(encoder, pcm, frames, received, av_gettime_relative());
                }
                if (!ok && !mac_audio_stopped(&audio)) {
                    const uint8_t notice = 0;
                    mac_audio_send(&audio, &notice, 1, 0, SC_REVERSE_AUDIO_UNAVAILABLE);
                    LOGW("Mac desktop audio unavailable (capture format or libopus); video continues. Toggle phone audio to retry.");
                    sc_reverse_audio_encoder_destroy(encoder); encoder = NULL;
                    unavailable = true;
                }
                sequence = current;
            }
            if (sample) CFRelease(sample);
            SDL_Delay(2);
        }
        sc_reverse_audio_encoder_destroy(encoder);
    }
    return 0;
}

// Called with mutex held by the control thread. Clear both buffered samples and
// partial encoder data (via epoch) even if pause/resume coalesce between polls.
static void mac_audio_transition(struct mac_state *s) {
    ++s->audio_epoch;
    if (s->latest_audio) { CFRelease(s->latest_audio); s->latest_audio = NULL; }
    sc_reverse_watchdog_set_paused(&s->audio_watchdog, !mac_audio_active(s), av_gettime_relative());
}

static void mac_mouse(struct mac_state *s, CGEventType type, CGPoint point) {
    CGEventRef event = CGEventCreateMouseEvent(NULL, type, point, kCGMouseButtonLeft);
    if (event) { CGEventPost(kCGHIDEventTap, event); CFRelease(event); }
    s->mouse_point = point;
}
static void mac_cancel_input(struct mac_state *s) {
    if (s->mouse_down) mac_mouse(s, kCGEventLeftMouseUp, s->mouse_point);
    s->mouse_down = false; s->scrolling = false; s->contact_count = 0;
}
static CGPoint mac_centroid(struct mac_state *s) {
    return CGPointMake((s->contacts[0].point.x + s->contacts[1].point.x) / 2,
                       (s->contacts[0].point.y + s->contacts[1].point.y) / 2);
}
static void mac_touch(struct sc_receiver *receiver, const struct sc_device_msg *msg, void *context) {
    (void)receiver;
    SCMacState *owner = (__bridge SCMacState *)context;
    struct mac_state *s = &owner->state;
    if (atomic_load(&s->stopped) || atomic_load(&s->paused) || !AXIsProcessTrusted()) { mac_cancel_input(s); return; }
    unsigned action = msg->reverse_touch.action & AMOTION_EVENT_ACTION_MASK;
    if (action == AMOTION_EVENT_ACTION_CANCEL) { mac_cancel_input(s); return; }
    double x, y;
    if (!sc_reverse_macos_point(&msg->reverse_touch.position, s->display_bounds.origin.x, s->display_bounds.origin.y,
            s->display_bounds.size.width, s->display_bounds.size.height, &x, &y)) return;
    CGPoint point = CGPointMake(x, y);
    uint64_t id = msg->reverse_touch.pointer_id;
    unsigned index = 0;
    while (index < s->contact_count && s->contacts[index].id != id) ++index;
    if (action == AMOTION_EVENT_ACTION_DOWN) {
        mac_cancel_input(s); s->contacts[0] = (struct mac_contact){id, point}; s->contact_count = 1;
        mac_mouse(s, kCGEventLeftMouseDown, point); s->mouse_down = true;
    } else if (action == AMOTION_EVENT_ACTION_POINTER_DOWN && index == s->contact_count && s->contact_count < 2) {
        s->contacts[s->contact_count++] = (struct mac_contact){id, point};
        if (s->contact_count == 2) {
            if (s->mouse_down) mac_mouse(s, kCGEventLeftMouseUp, s->mouse_point);
            s->mouse_down = false; s->scrolling = true; s->scroll_point = mac_centroid(s);
        }
    } else if (index < s->contact_count && action == AMOTION_EVENT_ACTION_MOVE) {
        s->contacts[index].point = point;
        if (s->scrolling && s->contact_count == 2) {
            CGPoint center = mac_centroid(s);
            int32_t dy = (int32_t)lrint(fmax(-120, fmin(120, center.y - s->scroll_point.y)));
            int32_t dx = (int32_t)lrint(fmax(-120, fmin(120, center.x - s->scroll_point.x)));
            CGEventRef event = CGEventCreateScrollWheelEvent(NULL, kCGScrollEventUnitPixel, 2, dy, dx);
            if (event) { CGEventPost(kCGHIDEventTap, event); CFRelease(event); }
            s->scroll_point = center;
        } else if (s->mouse_down && index == 0) mac_mouse(s, kCGEventLeftMouseDragged, point);
    } else if (index < s->contact_count && (action == AMOTION_EVENT_ACTION_UP || action == AMOTION_EVENT_ACTION_POINTER_UP)) {
        if (s->mouse_down) { mac_mouse(s, kCGEventLeftMouseUp, point); s->mouse_down = false; }
        if (--s->contact_count > index) s->contacts[index] = s->contacts[s->contact_count];
        if (!s->contact_count) s->scrolling = false;
    }
}

static void mac_scroll(struct sc_receiver *receiver, const struct sc_device_msg *msg, void *context) {
    (void)receiver;
    SCMacState *owner = (__bridge SCMacState *)context;
    struct mac_state *s = &owner->state;
    if (atomic_load(&s->stopped) || atomic_load(&s->paused) || !AXIsProcessTrusted()) return;
    double x, y;
    if (!sc_reverse_macos_point(&msg->reverse_scroll.position, s->display_bounds.origin.x, s->display_bounds.origin.y,
            s->display_bounds.size.width, s->display_bounds.size.height, &x, &y)) return;
    mac_cancel_input(s);
    mac_mouse(s, kCGEventMouseMoved, CGPointMake(x, y));
    CGEventRef event = CGEventCreateScrollWheelEvent(NULL, kCGScrollEventUnitPixel, 2,
        -msg->reverse_scroll.dy, -msg->reverse_scroll.dx);
    if (event) { CGEventPost(kCGHIDEventTap, event); CFRelease(event); }
}

static void mac_shortcut(CGKeyCode key, CGEventFlags flags) {
    for (unsigned down = 1; ; --down) {
        CGEventRef event = CGEventCreateKeyboardEvent(NULL, key, down != 0);
        if (event) { CGEventSetFlags(event, flags); CGEventPost(kCGHIDEventTap, event); CFRelease(event); }
        if (!down) break;
    }
}
static void mac_volume(enum sc_reverse_system_action action) {
    AudioDeviceID device; UInt32 size = sizeof(device);
    AudioObjectPropertyAddress address = {kAudioHardwarePropertyDefaultOutputDevice, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
    if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, 0, NULL, &size, &device) != noErr) return;
    address.mSelector = action == SC_REVERSE_SYSTEM_ACTION_VOLUME_MUTE ? kAudioDevicePropertyMute : kAudioDevicePropertyVolumeScalar;
    address.mScope = kAudioDevicePropertyScopeOutput;
    bool changed = false;
    // Built-in output may expose a master control or per-channel controls.
    for (UInt32 element = 0; element <= 2; ++element) {
        address.mElement = element; Boolean writable = false;
        if (!AudioObjectHasProperty(device, &address) || AudioObjectIsPropertySettable(device, &address, &writable) != noErr || !writable) continue;
        OSStatus result;
        if (action == SC_REVERSE_SYSTEM_ACTION_VOLUME_MUTE) {
            UInt32 mute = 0; size = sizeof(mute);
            result = AudioObjectGetPropertyData(device, &address, 0, NULL, &size, &mute);
            if (result == noErr) { mute = !mute; result = AudioObjectSetPropertyData(device, &address, 0, NULL, size, &mute); }
        } else {
            Float32 volume = 0; size = sizeof(volume);
            result = AudioObjectGetPropertyData(device, &address, 0, NULL, &size, &volume);
            if (result == noErr) {
                volume = fmaxf(0, fminf(1, volume + (action == SC_REVERSE_SYSTEM_ACTION_VOLUME_UP ? .05f : -.05f)));
                result = AudioObjectSetPropertyData(device, &address, 0, NULL, size, &volume);
            }
        }
        changed |= result == noErr;
        if (element == 0 && changed) break;
    }
    if (!changed) LOGW("The selected Mac audio output does not expose a writable volume/mute control");
}
static void mac_window_zoom(void) {
    NSRunningApplication *application = NSWorkspace.sharedWorkspace.frontmostApplication;
    if (!application) return;
    AXUIElementRef app = AXUIElementCreateApplication(application.processIdentifier);
    if (!app) return;
    CFTypeRef window = NULL, button = NULL;
    AXError result = AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute, &window);
    if (result == kAXErrorSuccess && window && CFGetTypeID(window) == AXUIElementGetTypeID())
        result = AXUIElementCopyAttributeValue((AXUIElementRef)window, kAXZoomButtonAttribute, &button);
    else result = kAXErrorNoValue;
    if (result == kAXErrorSuccess && button && CFGetTypeID(button) == AXUIElementGetTypeID())
        result = AXUIElementPerformAction((AXUIElementRef)button, kAXPressAction);
    else result = kAXErrorNoValue;
    if (result != kAXErrorSuccess) LOGW("The active Mac window does not expose a zoom/restore action");
    if (button) CFRelease(button); if (window) CFRelease(window); CFRelease(app);
}
static void mac_action(struct sc_receiver *receiver, const struct sc_device_msg *msg, void *context) {
    (void)receiver;
    SCMacState *owner = (__bridge SCMacState *)context;
    struct mac_state *s = &owner->state;
    if (atomic_load(&s->stopped)) return;
    enum sc_reverse_system_action action = msg->reverse_system_action.action;
    if (action == SC_REVERSE_SYSTEM_ACTION_STOP_SESSION) { mac_cancel_input(s); atomic_store(&s->quit, true); return; }
    if (action == SC_REVERSE_SYSTEM_ACTION_PAUSE_VIDEO || action == SC_REVERSE_SYSTEM_ACTION_RESUME_VIDEO) {
        bool paused = action == SC_REVERSE_SYSTEM_ACTION_PAUSE_VIDEO;
        mac_cancel_input(s);
        atomic_store(&s->paused, paused);
        sc_mutex_lock(&s->mutex);
        sc_reverse_watchdog_set_paused(&s->watchdog, paused, av_gettime_relative());
        mac_audio_transition(s);
        sc_mutex_unlock(&s->mutex);
        if (!paused) atomic_store(&s->force_key, true);
        LOGI("Reverse display %s (Android %s)", paused ? "paused" : "resumed", paused ? "background" : "foreground");
        return;
    }
    if (action == SC_REVERSE_SYSTEM_ACTION_AUDIO_ENABLE || action == SC_REVERSE_SYSTEM_ACTION_AUDIO_DISABLE) {
        sc_mutex_lock(&s->mutex);
        bool enabled = action == SC_REVERSE_SYSTEM_ACTION_AUDIO_ENABLE;
        if (atomic_exchange(&s->audio_enabled, enabled) != enabled) mac_audio_transition(s);
        sc_mutex_unlock(&s->mutex);
        return;
    }
    if (atomic_load(&s->paused)) return;
    dispatch_async(dispatch_get_main_queue(), ^{
        if (atomic_load(&owner->state.stopped) || atomic_load(&owner->state.paused)) return;
        if (action <= SC_REVERSE_SYSTEM_ACTION_VOLUME_MUTE) { mac_volume(action); return; }
        if (!AXIsProcessTrusted()) { LOGW("Enable Accessibility permission for Mac desktop input"); return; }
        switch (action) {
            case SC_REVERSE_SYSTEM_ACTION_MINIMIZE: mac_shortcut(kVK_ANSI_M, kCGEventFlagMaskCommand); break;
            case SC_REVERSE_SYSTEM_ACTION_MAXIMIZE_RESTORE: mac_window_zoom(); break;
            case SC_REVERSE_SYSTEM_ACTION_CLOSE: mac_shortcut(kVK_ANSI_W, kCGEventFlagMaskCommand); break;
            case SC_REVERSE_SYSTEM_ACTION_LOCK: mac_shortcut(kVK_ANSI_Q, kCGEventFlagMaskCommand | kCGEventFlagMaskControl); break;
            default: break;
        }
    });
}
static void mac_ack(struct sc_receiver *receiver, const struct sc_device_msg *msg, void *context) {
    (void)receiver;
    SCMacState *owner = (__bridge SCMacState *)context;
    struct mac_state *s = &owner->state;
    int64_t now = av_gettime_relative(), pts = msg->reverse_frame_ack.pts;
    sc_mutex_lock(&s->mutex); bool accepted = sc_reverse_watchdog_ack(&s->watchdog, pts, now); sc_mutex_unlock(&s->mutex);
    if (!accepted) return;
    atomic_store(&s->acked_pts, pts);
    if (now - s->metrics_us >= 1000000) {
        int64_t age = now - s->start_us - pts;
        if (age >= 0) LOGD("Reverse display capture-to-decode round-trip: %.1f ms", age / 1000.0);
        s->metrics_us = now;
    }
}
static void mac_audio_ack(struct sc_receiver *receiver, const struct sc_device_msg *msg, void *context) {
    (void)receiver;
    SCMacState *owner = (__bridge SCMacState *)context;
    struct mac_state *s = &owner->state;
    int64_t pts = msg->reverse_frame_ack.pts;
    sc_mutex_lock(&s->mutex);
    bool accepted = sc_reverse_watchdog_ack(&s->audio_watchdog, pts, av_gettime_relative());
    sc_mutex_unlock(&s->mutex);
    if (accepted) atomic_store(&s->audio_acked_pts, pts);
}
static void mac_ended(struct sc_receiver *receiver, bool error, void *context) {
    (void)receiver;
    SCMacState *owner = (__bridge SCMacState *)context;
    mac_cancel_input(&owner->state);
    if (!atomic_load(&owner->state.stopped)) atomic_store(error ? &owner->state.failed : &owner->state.disconnected, true);
}
static bool mac_gui_pipe(void) {
    char *value = sc_get_env("SCRCPY_GUI_CONTROL");
    bool enabled = value && !strcmp(value, "stdin-v1") && !isatty(STDIN_FILENO);
    free(value); return enabled;
}
static bool mac_gui_quit(bool enabled) {
    if (!enabled) return false;
    struct pollfd fd = {.fd = STDIN_FILENO, .events = POLLIN};
    if (poll(&fd, 1, 0) <= 0) return false;
    if (fd.revents & (POLLERR | POLLNVAL)) return true;
    if (!(fd.revents & (POLLIN | POLLHUP))) return false;
    char c; ssize_t count = read(STDIN_FILENO, &c, 1);
    return count <= 0 || c == 'q';
}

enum scrcpy_exit_code
sc_reverse_display_macos_run(sc_socket video_socket, sc_socket control_socket, const struct scrcpy_options *options) {
    @autoreleasepool {
        if (@available(macOS 13.0, *)) {
            [NSApplication sharedApplication];
            LOGW("Experimental macOS host: video, input and desktop audio require Apple-hardware verification");
            if (!CGPreflightScreenCaptureAccess() && !CGRequestScreenCaptureAccess()) {
                LOGE("Allow Screen Recording for the launching Terminal/dskcpy in System Settings > Privacy & Security, then restart it");
                return SCRCPY_EXIT_FAILURE;
            }
            if (!AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)@{(__bridge NSString *)kAXTrustedCheckOptionPrompt: @YES}))
                LOGW("View-only until Accessibility permission is granted to the launching Terminal/dskcpy");
            SCMacCompletion *discovery = [SCMacCompletion new];
            [SCShareableContent getShareableContentExcludingDesktopWindows:NO onScreenWindowsOnly:YES
                completionHandler:^(SCShareableContent *content, NSError *error) { discovery.value = content; discovery.error = error; discovery.done = YES; }];
            if (!mac_wait(discovery, 15)) { LOGE("Could not enumerate Mac displays; check Screen Recording permission"); return SCRCPY_EXIT_FAILURE; }
            SCShareableContent *content = discovery.value;
            NSArray<SCDisplay *> *displays = [content.displays sortedArrayUsingComparator:^NSComparisonResult(SCDisplay *a, SCDisplay *b) {
                if (a.displayID == b.displayID) return NSOrderedSame;
                if (a.displayID == CGMainDisplayID()) return NSOrderedAscending;
                if (b.displayID == CGMainDisplayID()) return NSOrderedDescending;
                return a.displayID < b.displayID ? NSOrderedAscending : NSOrderedDescending;
            }];
            if (options->reverse_display_index >= displays.count) { LOGE("Mac monitor index is out of range (%lu displays)", (unsigned long)displays.count); return SCRCPY_EXIT_FAILURE; }
            SCDisplay *display = displays[options->reverse_display_index];
            SCMacState *owner = [SCMacState new];
            if (!owner) return SCRCPY_EXIT_FAILURE;
            struct mac_state *s = &owner->state;
            s->video_socket = video_socket; s->control_socket = control_socket;
            s->display_bounds = CGDisplayBounds(display.displayID);
            if (!sc_reverse_macos_dimensions((uint32_t)CGDisplayPixelsWide(display.displayID), (uint32_t)CGDisplayPixelsHigh(display.displayID),
                    options->max_size, &s->width, &s->height)) { LOGE("Invalid Mac capture dimensions"); return SCRCPY_EXIT_FAILURE; }
            double fps = options->max_fps ? strtod(options->max_fps, NULL) : 60;
            s->fps = (unsigned)lrint(isfinite(fps) && fps > 0 ? fmax(1, fmin(240, fps)) : 60);
            if (!mac_encoder(owner, options)) return SCRCPY_EXIT_FAILURE;
            // macOS has no MSG_NOSIGNAL. A disconnected receiver must become a
            // normal send failure, not a SIGPIPE process termination.
            int no_sigpipe = 1;
            if (setsockopt(video_socket->socket, SOL_SOCKET, SO_NOSIGPIPE, &no_sigpipe, sizeof(no_sigpipe))) {
                LOGE("Could not configure the Mac streaming socket");
                return SCRCPY_EXIT_FAILURE;
            }
            net_set_tcp_nodelay(video_socket, true); net_set_socket_send_buffer(video_socket, 64 * 1024);
            uint8_t header[16]; sc_write32be(header, 0x53524431); sc_write32be(header + 4, 1);
            sc_write32be(header + 8, s->width); sc_write32be(header + 12, s->height);
            if (net_send_all(video_socket, header, sizeof(header)) != sizeof(header)) return SCRCPY_EXIT_FAILURE;
            s->start_us = av_gettime_relative();
            static const struct sc_receiver_callbacks callbacks = {.on_ended = mac_ended, .on_reverse_touch = mac_touch, .on_reverse_scroll = mac_scroll,
                .on_reverse_frame_ack = mac_ack, .on_reverse_system_action = mac_action, .on_reverse_audio_ack = mac_audio_ack};
            struct sc_receiver receiver;
            if (!sc_receiver_init(&receiver, control_socket, &callbacks, (__bridge void *)owner)) return SCRCPY_EXIT_FAILURE;
            bool input_started = sc_receiver_start(&receiver);
            SCMacOutput *output = [SCMacOutput new]; output.owner = owner;
            dispatch_queue_t queue = dispatch_queue_create("dskcpy.mac.capture", DISPATCH_QUEUE_SERIAL);
            dispatch_queue_t audio_queue = dispatch_queue_create("dskcpy.mac.audio", DISPATCH_QUEUE_SERIAL);
            SCStreamConfiguration *configuration = [SCStreamConfiguration new];
            configuration.width = s->width; configuration.height = s->height;
            configuration.pixelFormat = kCVPixelFormatType_32BGRA;
            configuration.minimumFrameInterval = CMTimeMake(1, s->fps);
            configuration.queueDepth = 3; configuration.showsCursor = YES;
            configuration.capturesAudio = options->reverse_audio;
            configuration.sampleRate = 48000; configuration.channelCount = 2;
            configuration.excludesCurrentProcessAudio = YES;
            // No microphone output is requested. --no-audio disables capture too.
            SCContentFilter *filter = [[SCContentFilter alloc] initWithDisplay:display excludingWindows:@[]];
            SCStream *stream = [[SCStream alloc] initWithFilter:filter configuration:configuration delegate:output];
            NSError *error = nil;
            bool output_added = input_started && [stream addStreamOutput:output type:SCStreamOutputTypeScreen sampleHandlerQueue:queue error:&error];
            bool audio_added = output_added && options->reverse_audio
                && [stream addStreamOutput:output type:SCStreamOutputTypeAudio sampleHandlerQueue:audio_queue error:&error];
            if (!audio_added) configuration.capturesAudio = NO;
            SCMacCompletion *started = [SCMacCompletion new];
            // SCStream copies configuration at construction. Apply video-only
            // fallback if its audio output could not be registered.
            if (output_added && options->reverse_audio && !audio_added) {
                SCMacCompletion *updated = [SCMacCompletion new];
                [stream updateConfiguration:configuration completionHandler:^(NSError *failure) { updated.error = failure; updated.done = YES; }];
                output_added = mac_wait(updated, 5);
            }
            if (output_added) [stream startCaptureWithCompletionHandler:^(NSError *failure) { started.error = failure; started.done = YES; }];
            bool capture_started = output_added && mac_wait(started, 15);
            if (!capture_started && output_added && audio_added && started.done && started.error) {
                LOGW("Mac capture with audio failed; retrying video only");
                [stream removeStreamOutput:output type:SCStreamOutputTypeAudio error:NULL];
                audio_added = false; configuration.capturesAudio = NO;
                SCMacCompletion *updated = [SCMacCompletion new];
                [stream updateConfiguration:configuration completionHandler:^(NSError *failure) { updated.error = failure; updated.done = YES; }];
                if (mac_wait(updated, 5)) {
                    SCMacCompletion *retry = [SCMacCompletion new];
                    [stream startCaptureWithCompletionHandler:^(NSError *failure) { retry.error = failure; retry.done = YES; }];
                    capture_started = mac_wait(retry, 15);
                }
            }
            atomic_store(&s->audio_available, capture_started && audio_added);
            // Permission/capture startup is not a stream stall. The PTS clock
            // stays fixed; only the first-frame deadline starts after setup.
            int64_t capture_ready_us = av_gettime_relative();
            sc_thread worker;
            // sc_thread_create permits at most 15 bytes, even on macOS.
            bool worker_started = capture_started && sc_thread_create(&worker, mac_video_thread, "rev-mac-video", (__bridge void *)owner);
            sc_thread audio_worker;
            bool audio_started = worker_started && sc_thread_create(&audio_worker, mac_audio_thread, "rev-mac-audio", (__bridge void *)owner);
            if (worker_started && !audio_started) LOGW("Mac audio worker unavailable; video continues");
            enum scrcpy_exit_code result = SCRCPY_EXIT_FAILURE;
            if (worker_started) {
                LOGI("Mac desktop: %ux%u at %u fps; touch maps to mouse, two fingers scroll", s->width, s->height, s->fps);
                bool gui_pipe = mac_gui_pipe();
                for (;;) {
                    if (mac_gui_quit(gui_pipe) || atomic_load(&s->quit)) { result = SCRCPY_EXIT_SUCCESS; break; }
                    if (atomic_load(&s->failed)) break;
                    if (atomic_load(&s->disconnected)) { result = SCRCPY_EXIT_DISCONNECTED; break; }
                    int64_t now = av_gettime_relative(), encoding = atomic_load(&s->encoding_since);
                    sc_mutex_lock(&s->mutex);
                    bool expired = sc_reverse_watchdog_expired(&s->watchdog, now)
                        || sc_reverse_watchdog_expired(&s->audio_watchdog, now);
                    bool missing = !s->latest && now - capture_ready_us > 10000000;
                    sc_mutex_unlock(&s->mutex);
                    if (expired || missing || (encoding && now - encoding > 10000000)) {
                        LOGE("Reverse display stalled for 10 seconds. Check the phone, Mac permissions and reconnect."); break;
                    }
                    SDL_Event event;
                    while (SDL_PollEvent(&event)) if (event.type == SDL_EVENT_QUIT) atomic_store(&s->quit, true);
                    CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.01, false);
                }
            } else LOGE("Could not start Mac capture; check Screen Recording permission and the hardware encoder");
            atomic_store(&s->stopped, true);
            net_interrupt(video_socket); net_interrupt(control_socket);
            if (input_started) sc_receiver_join(&receiver);
            if (worker_started) sc_thread_join(&worker, NULL);
            if (audio_started) sc_thread_join(&audio_worker, NULL);
            sc_receiver_destroy(&receiver);
            SCMacCompletion *ended = [SCMacCompletion new];
            [stream stopCaptureWithCompletionHandler:^(NSError *failure) { ended.error = failure; ended.done = YES; }];
            (void)mac_wait(ended, 5);
            if (output_added) [stream removeStreamOutput:output type:SCStreamOutputTypeScreen error:NULL];
            if (audio_added) [stream removeStreamOutput:output type:SCStreamOutputTypeAudio error:NULL];
            output.owner = nil;
            dispatch_sync(queue, ^{}); // Drain output callbacks before releasing capture state.
            dispatch_sync(audio_queue, ^{});
            return result;
        }
        LOGE("The experimental Mac host requires macOS 13 or newer");
        return SCRCPY_EXIT_FAILURE;
    }
}

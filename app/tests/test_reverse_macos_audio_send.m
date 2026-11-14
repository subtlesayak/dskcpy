// The production mac_action implementation is compiled in this TU. Only fixed
// audio/pause actions are invoked. No capture, permission query or OS input.
#import <Cocoa/Cocoa.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <VideoToolbox/VideoToolbox.h>
#import <ApplicationServices/ApplicationServices.h>
#import <CoreAudio/CoreAudio.h>
#import <Carbon/Carbon.h>
#include <assert.h>
#include <pthread.h>
#include <stdatomic.h>
#include "util/thread.h"
#include "util/net.h"
static sc_mutex *blocked_send_mutex;
static _Atomic bool reached_send_mutex;
static unsigned fake_socket_writes;
static void fake_lock(sc_mutex *mutex) {
    if (mutex == blocked_send_mutex) atomic_store(&reached_send_mutex,true);
    sc_mutex_lock(mutex);
}
static ssize_t fake_send_all(sc_socket socket,const void *data,size_t length) {
    (void)socket;(void)data;++fake_socket_writes;return (ssize_t)length;
}
static unsigned permission_checks, posted_events;
static bool fake_accessibility(void) { ++permission_checks; return true; }
static void fake_post(CGEventTapLocation location, CGEventRef event) {
    (void)location; (void)event; ++posted_events;
}
#define AXIsProcessTrusted fake_accessibility
#define CGEventPost fake_post
#define sc_mutex_lock fake_lock
#define net_send_all fake_send_all
#include "../src/reverse_display_macos.m"
#undef AXIsProcessTrusted
#undef CGEventPost
#undef sc_mutex_lock
#undef net_send_all

static void action(SCMacState *owner, enum sc_reverse_system_action value) {
    struct sc_device_msg message = {.reverse_system_action = {.action = value}};
    mac_action(NULL, &message, (__bridge void *)owner);
}
static void *pending_audio_send(void *context) {
    const uint8_t payload[2]={1,2};
    assert(mac_audio_send(context,payload,sizeof(payload),100,SC_REVERSE_AUDIO_PACKET));
    return NULL;
}
static CMSampleBufferRef synthetic_sample(void) {
    AudioStreamBasicDescription asbd = {.mSampleRate=48000,.mFormatID=kAudioFormatLinearPCM,
        .mFormatFlags=kAudioFormatFlagIsSignedInteger|kAudioFormatFlagIsPacked,
        .mBytesPerPacket=4,.mFramesPerPacket=1,.mBytesPerFrame=4,.mChannelsPerFrame=2,.mBitsPerChannel=16};
    CMAudioFormatDescriptionRef format=NULL;
    assert(CMAudioFormatDescriptionCreate(kCFAllocatorDefault,&asbd,0,NULL,0,NULL,NULL,&format)==noErr);
    CMBlockBufferRef block=NULL;
    assert(CMBlockBufferCreateWithMemoryBlock(kCFAllocatorDefault,NULL,480*4,kCFAllocatorDefault,NULL,0,480*4,0,&block)==noErr);
    assert(CMBlockBufferFillDataBytes(0,block,0,480*4)==noErr);
    CMSampleTimingInfo timing={.duration=CMTimeMake(1,48000),.presentationTimeStamp=kCMTimeZero,.decodeTimeStamp=kCMTimeInvalid};
    CMSampleBufferRef sample=NULL;size_t size=4;
    assert(CMSampleBufferCreateReady(kCFAllocatorDefault,block,format,480,1,&timing,1,&size,&sample)==noErr);
    CFRelease(format);CFRelease(block);return sample;
}
int main(void) {
 @autoreleasepool {
    SCMacState *owner=[SCMacState new];assert(owner);
    struct mac_state *s=&owner->state;
    CMSampleBufferRef sample=synthetic_sample();
    assert(!atomic_load(&s->audio_enabled)&&s->audio_epoch==0);
    action(owner,SC_REVERSE_SYSTEM_ACTION_AUDIO_ENABLE);
    assert(atomic_load(&s->audio_enabled)&&s->audio_epoch==1);
    sc_reverse_macos_audio_queue_push(&s->audio_queue,sample,1);assert(s->audio_queue.count==1);
    action(owner,SC_REVERSE_SYSTEM_ACTION_AUDIO_ENABLE);
    action(owner,SC_REVERSE_SYSTEM_ACTION_RESUME_VIDEO);
    assert(s->audio_queue.count==1&&s->audio_epoch==1); // Duplicate enable/Resume never discard working audio.
    action(owner,SC_REVERSE_SYSTEM_ACTION_AUDIO_DISABLE);
    assert(!atomic_load(&s->audio_enabled)&&s->audio_queue.count==0&&s->audio_epoch==2);
    action(owner,SC_REVERSE_SYSTEM_ACTION_AUDIO_DISABLE);assert(s->audio_epoch==2);
    action(owner,SC_REVERSE_SYSTEM_ACTION_AUDIO_ENABLE);
    sc_reverse_macos_audio_queue_push(&s->audio_queue,sample,2);
    action(owner,SC_REVERSE_SYSTEM_ACTION_PAUSE_VIDEO);
    assert(atomic_load(&s->paused)&&s->audio_queue.count==0&&s->audio_epoch==4);
    action(owner,SC_REVERSE_SYSTEM_ACTION_PAUSE_VIDEO);assert(s->audio_epoch==4);
    action(owner,SC_REVERSE_SYSTEM_ACTION_RESUME_VIDEO);assert(!atomic_load(&s->paused)&&s->audio_epoch==5);
    action(owner,SC_REVERSE_SYSTEM_ACTION_AUDIO_DISABLE);assert(!atomic_load(&s->audio_enabled));
    atomic_store(&s->disconnected,true);unsigned epoch=s->audio_epoch;
    action(owner,SC_REVERSE_SYSTEM_ACTION_AUDIO_ENABLE);assert(!atomic_load(&s->audio_enabled)&&s->audio_epoch==epoch);
    atomic_store(&s->disconnected,false);
    action(owner,SC_REVERSE_SYSTEM_ACTION_AUDIO_ENABLE);
    struct mac_audio_context old_audio={.state=s,.epoch=s->audio_epoch};
    // Hold the real production send lock after the optimistic enabled check.
    // A genuine mute/re-enable must invalidate the blocked old encoder output.
    sc_mutex_lock(&s->send_mutex);blocked_send_mutex=&s->send_mutex;
    pthread_t pending;assert(!pthread_create(&pending,NULL,pending_audio_send,&old_audio));
    for(unsigned n=0;n<1000&&!atomic_load(&reached_send_mutex);++n)SDL_Delay(1);
    assert(atomic_load(&reached_send_mutex));
    action(owner,SC_REVERSE_SYSTEM_ACTION_AUDIO_DISABLE);
    action(owner,SC_REVERSE_SYSTEM_ACTION_AUDIO_ENABLE);
    blocked_send_mutex=NULL;sc_mutex_unlock(&s->send_mutex);assert(!pthread_join(pending,NULL));
    printf("Old epoch=%llu current=%llu fake socket writes=%u\n",(unsigned long long)old_audio.epoch,(unsigned long long)s->audio_epoch,fake_socket_writes);
    fflush(stdout);assert(fake_socket_writes==0);
    assert(!atomic_load(&s->failed)&&!s->audio_watchdog.busy&&s->audio_watchdog.submitted_pts<100);
    struct mac_audio_context fresh_audio={.state=s,.epoch=s->audio_epoch};
    const uint8_t fresh[2]={3,4};assert(mac_audio_send(&fresh_audio,fresh,sizeof(fresh),100,SC_REVERSE_AUDIO_PACKET));
    assert(fake_socket_writes==2&&s->audio_watchdog.submitted_pts==100);
    assert(posted_events==0); // Query calls, if any, were intercepted, never sent to the actual OS.
    CFRelease(sample);
    printf("Actual native audio actions: consent, epochs, queue cleanup, duplicate Resume and ended-session gates pass; permission queries intercepted=%u; OS events=0\n",permission_checks);
 }
 return 0;
}

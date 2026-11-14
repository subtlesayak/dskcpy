#include <assert.h>
#include <stdbool.h>
#include "reverse_pause.h"
#include "reverse_watchdog.h"
struct sink { bool paused,key_held,mouse_held,audio_enabled; unsigned transitions,keyframes; struct sc_reverse_watchdog video,audio; };
static void transition(void *context,bool paused){
 struct sink *s=context;s->paused=paused;s->key_held=s->mouse_held=false;s->transitions++;
 sc_reverse_watchdog_set_paused(&s->video,paused,1000);
 sc_reverse_watchdog_set_paused(&s->audio,paused||!s->audio_enabled,1000);
}
static void keyframe(void *context){((struct sink*)context)->keyframes++;}
int main(void){
 const struct sc_reverse_pause_callbacks callbacks={transition,keyframe};
 struct sink s={.key_held=true,.mouse_held=true,.audio_enabled=true};
 sc_reverse_watchdog_init(&s.video);sc_reverse_watchdog_init(&s.audio);
 sc_reverse_watchdog_begin(&s.video,100);sc_reverse_watchdog_submit(&s.video,10);sc_reverse_watchdog_end(&s.video);
 sc_reverse_watchdog_begin(&s.audio,100);sc_reverse_watchdog_submit(&s.audio,20);sc_reverse_watchdog_end(&s.audio);
 int64_t vd=s.video.deadline,ad=s.audio.deadline;
 for(unsigned i=0;i<10000;i++)sc_reverse_pause(s.paused,false,&callbacks,&s);
 assert(s.key_held&&s.mouse_held&&s.keyframes==10000&&!s.transitions);
 assert(s.video.deadline==vd&&s.audio.deadline==ad);
 sc_reverse_pause(s.paused,true,&callbacks,&s);sc_reverse_pause(s.paused,true,&callbacks,&s);
 assert(s.paused&&!s.key_held&&!s.mouse_held&&s.transitions==1&&s.video.paused&&s.audio.paused);
 sc_reverse_pause(s.paused,false,&callbacks,&s);assert(!s.paused&&s.transitions==2&&s.keyframes==10001&&!s.video.paused&&!s.audio.paused);
 s.audio_enabled=false;sc_reverse_pause(s.paused,true,&callbacks,&s);sc_reverse_pause(s.paused,false,&callbacks,&s);assert(s.audio.paused);
 return 0;
}

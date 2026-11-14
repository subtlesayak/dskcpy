import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
const run=promisify(execFile);

// Compile the actual production Windows callback bodies against fake effects.
// This checks the admission/transition decisions without calling Windows input,
// capture, audio, permissions or starting the real host.
test('actual Windows resume dispatch preserves held input and active watchdogs on repeated IDR requests',async t=>{
 const compiler=process.env.DSKCPY_PAUSE_TEST_CC || process.env.CC || 'cc';
 try{await run(compiler,['--version'],{timeout:5000,windowsHide:true})}catch{
  if(process.env.DSKCPY_REQUIRE_PAUSE_FIXTURE==='1')throw Error('The native job requires its standalone callback-fixture compiler.');
  t.skip('Requires a standalone C compiler; native Meson pause tests run separately');return;
 }
 const source=await readFile(new URL('../../app/src/reverse_display.c',import.meta.url),'utf8');
 const device=await readFile(new URL('../../app/src/device_msg.h',import.meta.url),'utf8');
 const enumeration=device.match(/enum sc_reverse_system_action \{[\s\S]*?\n\};/)[0];
 function body(name){
  const start=source.indexOf(`static void\n${name}(`);assert.ok(start>=0,`Missing production callback ${name}`);
  const open=source.indexOf('{',start);let depth=1,end=open+1;
  while(depth&&end<source.length){if(source[end]==='{')depth++;if(source[end]==='}')depth--;end++}
  assert.equal(depth,0);return source.slice(start,end);
 }
 const code=`#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdatomic.h>
#include <stdio.h>
#include "reverse_watchdog.h"
#include "reverse_pause.h"
${enumeration}
struct sc_receiver { int unused; };
struct sc_device_msg { struct { enum sc_reverse_system_action action; } reverse_system_action; };
struct reverse_display_state { atomic_bool stopped,video_paused,force_refresh,audio_enabled; struct sc_reverse_watchdog watchdog,audio_watchdog;int watchdog_mutex;bool key_held,mouse_held,fail_cleanup,check_paused_cleanup;unsigned key_cancels,touch_cancels,other; };
static void sc_mutex_lock(int *m){(void)m;} static void sc_mutex_unlock(int *m){(void)m;}
static int64_t av_gettime_relative(void){return 1000;}
#define LOGI(...) ((void)0)
static void reverse_cancel_keyboard(struct reverse_display_state *s){if(s->check_paused_cleanup)assert(atomic_load(&s->video_paused));if(!s->fail_cleanup)s->key_held=false;s->key_cancels++;}
static void reverse_cancel_touches(struct reverse_display_state *s){if(s->check_paused_cleanup)assert(atomic_load(&s->video_paused));if(!s->fail_cleanup)s->mouse_held=false;s->touch_cancels++;}
static void reverse_apply_system_action(struct reverse_display_state *s,enum sc_reverse_system_action a){s->other++;if(a==SC_REVERSE_SYSTEM_ACTION_PAUSE_VIDEO)atomic_store(&s->video_paused,true);if(a==SC_REVERSE_SYSTEM_ACTION_RESUME_VIDEO)atomic_store(&s->video_paused,false);if(a==SC_REVERSE_SYSTEM_ACTION_STOP_SESSION){atomic_store(&s->stopped,true);reverse_cancel_touches(s);}}
${body('reverse_video_pause_transition')}
${body('reverse_video_request_keyframe')}
${body('reverse_receiver_on_system_action')}
static void action(struct reverse_display_state *s,enum sc_reverse_system_action a){struct sc_device_msg m={.reverse_system_action={a}};reverse_receiver_on_system_action(NULL,&m,s);}
int main(void){
 struct reverse_display_state s={0};atomic_init(&s.stopped,false);atomic_init(&s.video_paused,false);atomic_init(&s.force_refresh,false);atomic_init(&s.audio_enabled,true);
 sc_reverse_watchdog_init(&s.watchdog);sc_reverse_watchdog_init(&s.audio_watchdog);
 sc_reverse_watchdog_begin(&s.watchdog,100);sc_reverse_watchdog_submit(&s.watchdog,10);sc_reverse_watchdog_end(&s.watchdog);
 sc_reverse_watchdog_begin(&s.audio_watchdog,100);sc_reverse_watchdog_submit(&s.audio_watchdog,20);sc_reverse_watchdog_end(&s.audio_watchdog);
 int64_t vd=s.watchdog.deadline,ad=s.audio_watchdog.deadline;s.key_held=s.mouse_held=true;
 for(unsigned i=0;i<10000;i++){atomic_store(&s.force_refresh,false);action(&s,SC_REVERSE_SYSTEM_ACTION_RESUME_VIDEO);assert(s.key_held&&s.mouse_held);assert(atomic_load(&s.force_refresh));assert(s.watchdog.deadline==vd&&s.audio_watchdog.deadline==ad);}
 assert(!s.key_cancels&&!s.touch_cancels&&!s.other);
 for(unsigned i=12;i<=14;i++)action(&s,(enum sc_reverse_system_action)i);assert(s.key_held&&s.mouse_held&&!s.key_cancels&&!s.other);
 s.check_paused_cleanup=true;s.fail_cleanup=true;action(&s,SC_REVERSE_SYSTEM_ACTION_PAUSE_VIDEO);assert(s.key_held&&s.mouse_held&&atomic_load(&s.video_paused));assert(s.key_cancels==1&&s.touch_cancels==1&&s.watchdog.paused&&s.audio_watchdog.paused);
 s.fail_cleanup=false;action(&s,SC_REVERSE_SYSTEM_ACTION_PAUSE_VIDEO);assert(!s.key_held&&!s.mouse_held&&s.key_cancels==2&&s.touch_cancels==2);assert(s.watchdog.deadline==vd&&s.audio_watchdog.deadline==ad);
 action(&s,SC_REVERSE_SYSTEM_ACTION_RESUME_VIDEO);assert(!atomic_load(&s.video_paused)&&!s.watchdog.paused&&!s.audio_watchdog.paused);assert(s.key_cancels==3&&s.touch_cancels==3);assert(atomic_load(&s.audio_enabled));
 atomic_store(&s.audio_enabled,false);action(&s,SC_REVERSE_SYSTEM_ACTION_PAUSE_VIDEO);action(&s,SC_REVERSE_SYSTEM_ACTION_RESUME_VIDEO);assert(s.audio_watchdog.paused);
 s.check_paused_cleanup=false;s.key_held=s.mouse_held=true;action(&s,SC_REVERSE_SYSTEM_ACTION_STOP_SESSION);assert(!s.key_held&&!s.mouse_held&&atomic_load(&s.stopped));unsigned before=s.key_cancels;atomic_store(&s.force_refresh,false);action(&s,SC_REVERSE_SYSTEM_ACTION_RESUME_VIDEO);assert(s.key_cancels==before&&!atomic_load(&s.force_refresh));
 puts("productionCallbacks: 10000 duplicate Resume calls; fake effects only");return 0;
}
`;
 const directory=await mkdtemp(path.join(os.tmpdir(),'dskcpy-windows-pause-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const c=path.join(directory,'fixture.c'),exe=path.join(directory,process.platform==='win32'?'fixture.exe':'fixture');await writeFile(c,code);
 await run(compiler,['-std=c11','-Wall','-Wextra','-I',fileURLToPath(new URL('../../app/src/',import.meta.url)),c,'-o',exe],{timeout:15000,windowsHide:true});
 const result=await run(exe,[],{timeout:5000,windowsHide:true});assert.match(result.stdout,/productionCallbacks: 10000.*fake effects only/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
const run = promisify(execFile);

// Compile the production Windows admission, coordinate and SendInput adapter
// against fake effects. No Windows APIs or real input are called by this test.
test('production Windows secondary-click callbacks gate input and retain only release after partial delivery', async t => {
  const compiler=process.env.DSKCPY_POINTER_TEST_CC || process.env.CC || 'cc';
  try { await run(compiler,['--version'],{timeout:5000,windowsHide:true}); } catch {
    if(process.env.DSKCPY_REQUIRE_POINTER_FIXTURE==='1') throw Error('Required secondary-click fixture compiler unavailable');
    t.skip('Requires standalone C compiler; native pointer tests are separate'); return;
  }
  const source=(await readFile(new URL('../../app/src/reverse_display.c',import.meta.url),'utf8')).replace(/\r\n/g,'\n');
  const extract=(name,type)=>{
    const start=source.indexOf(`static ${type}\n${name}(`); assert.ok(start>=0,`Missing production callback ${name}`);
    const open=source.indexOf('{',start); let depth=1,end=open+1;
    while(depth && end<source.length) { if(source[end]==='{')depth++; if(source[end]==='}')depth--; end++; }
    assert.equal(depth,0); return source.slice(start,end);
  };
  const callbacks=[extract('reverse_make_mouse_event','bool'),extract('reverse_pointer_inject','size_t'),extract('reverse_receiver_on_pointer','void')];
  const code=`#include <assert.h>
#include <stdint.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>
#include <stdatomic.h>
#include "reverse_pointer.h"
#include "reverse_touch.h"
#include "coords.h"
typedef int32_t LONG; typedef uint32_t DWORD; typedef unsigned UINT;
typedef struct { unsigned type; struct { LONG dx,dy; DWORD dwFlags; } mi; } INPUT;
enum {SM_XVIRTUALSCREEN,SM_YVIRTUALSCREEN,SM_CXVIRTUALSCREEN,SM_CYVIRTUALSCREEN};
enum {INPUT_MOUSE=0,MOUSEEVENTF_MOVE=1,MOUSEEVENTF_RIGHTDOWN=8,MOUSEEVENTF_RIGHTUP=16,MOUSEEVENTF_ABSOLUTE=32768,MOUSEEVENTF_VIRTUALDESK=16384,VK_RBUTTON=2};
static int bounds[]={-1920,-100,3840,2160}; static bool physical_down,denied_touch;
static unsigned calls, accepted[16], sizes[16]; static INPUT sent[16][2]; static bool mutex;
static int GetSystemMetrics(int id){return bounds[id];}
static int GetAsyncKeyState(int key){assert(key==VK_RBUTTON);return physical_down?-32768:0;}
static unsigned SendInput(UINT count,INPUT *inputs,int size){assert(mutex && size==sizeof(INPUT) && calls<16 && count<=2); sizes[calls]=count;memcpy(sent[calls],inputs,count*sizeof(INPUT));return accepted[calls++];}
#define LOGW(...) ((void)0)
struct sc_receiver {int unused;};
struct options {bool reverse_pointer_buttons,reverse_keyboard;unsigned reverse_socket;};
struct sc_device_msg {struct {struct sc_position position;} reverse_pointer;};
struct reverse_display_state {struct sc_reverse_pointer pointer;struct options *options;struct sc_reverse_touch touch;int touch_mutex;atomic_bool stopped,fatal_error,video_paused,stream_ready;};
static void sc_mutex_lock(int *p){(void)p;assert(!mutex);mutex=true;}
static void sc_mutex_unlock(int *p){(void)p;assert(mutex);mutex=false;}
static void reverse_check_touch_geometry(struct reverse_display_state *s){(void)s;assert(mutex);}
static bool reverse_map_position(struct reverse_display_state *s,const struct sc_position *p,LONG *x,LONG *y){(void)s;assert(mutex);if(p->screen_size.width!=640||p->screen_size.height!=480)return false;*x=-1920+p->point.x;*y=-100+p->point.y;return true;}
bool sc_reverse_touch_cancel(struct sc_reverse_touch *touch){(void)touch;assert(mutex);return !denied_touch;}
${callbacks.join('\n')}
static void reset(struct reverse_display_state *s){calls=0;memset(accepted,0,sizeof(accepted));memset(sent,0,sizeof(sent));sc_reverse_pointer_init(&s->pointer,reverse_pointer_inject,s);}
int main(void){
 struct options options={true,true,1234}; struct reverse_display_state s={.options=&options};atomic_init(&s.stream_ready,true);
 struct sc_device_msg msg={.reverse_pointer={.position={.point={10,20},.screen_size={640,480}}}};
 reset(&s);accepted[0]=2;reverse_receiver_on_pointer(NULL,&msg,&s);assert(calls==1&&sizes[0]==2&&!s.pointer.pending_up);
 assert(sent[0][0].mi.dwFlags==(MOUSEEVENTF_MOVE|MOUSEEVENTF_ABSOLUTE|MOUSEEVENTF_VIRTUALDESK|MOUSEEVENTF_RIGHTDOWN));
 assert(sent[0][0].mi.dx==10*65535/3839 && sent[0][0].mi.dy==20*65535/2159);
 assert(sent[0][1].mi.dwFlags==MOUSEEVENTF_RIGHTUP && sent[0][1].mi.dx==0 && sent[0][1].mi.dy==0);
 for(unsigned gate=0;gate<9;gate++){
  reset(&s);options.reverse_pointer_buttons=gate!=0;options.reverse_keyboard=gate!=1;options.reverse_socket=gate==2?0:1234;
  atomic_store(&s.stopped,gate==3);atomic_store(&s.fatal_error,gate==4);atomic_store(&s.video_paused,gate==5);atomic_store(&s.stream_ready,gate!=6);physical_down=gate==7;denied_touch=gate==8;
  reverse_receiver_on_pointer(NULL,&msg,&s);assert(!calls);
 }
 options=(struct options){true,true,1234};physical_down=denied_touch=false;atomic_store(&s.stopped,false);atomic_store(&s.fatal_error,false);atomic_store(&s.video_paused,false);atomic_store(&s.stream_ready,true);
 reset(&s);msg.reverse_pointer.position.screen_size.width=800;reverse_receiver_on_pointer(NULL,&msg,&s);assert(!calls);msg.reverse_pointer.position.screen_size.width=640;
 reset(&s);accepted[0]=1;reverse_receiver_on_pointer(NULL,&msg,&s);assert(calls==2&&s.pointer.pending_up&&sizes[1]==1&&sent[1][0].mi.dwFlags==MOUSEEVENTF_RIGHTUP);
 msg.reverse_pointer.position.point.x=500;reverse_receiver_on_pointer(NULL,&msg,&s);assert(calls==3&&s.pointer.pending_up&&sizes[2]==1&&sent[2][0].mi.dwFlags==MOUSEEVENTF_RIGHTUP);
 bounds[2]=0;accepted[3]=1;reverse_receiver_on_pointer(NULL,&msg,&s);assert(calls==4&&!s.pointer.pending_up&&sizes[3]==1&&sent[3][0].mi.dwFlags==MOUSEEVENTF_RIGHTUP);
 assert(!mutex);puts("productionPointer: admission, geometry and release-only partial-failure cleanup; fake effects only");return 0;
}
`;
  const directory=await mkdtemp(path.join(os.tmpdir(),'dskcpy-pointer-callback-')); t.after(()=>rm(directory,{recursive:true,force:true}));
  const c=path.join(directory,'fixture.c'), exe=path.join(directory,process.platform==='win32'?'fixture.exe':'fixture'); await writeFile(c,code);
  await run(compiler,['-std=c11','-Wall','-Wextra','-I',fileURLToPath(new URL('../../app/src/',import.meta.url)),c,fileURLToPath(new URL('../../app/src/reverse_pointer.c',import.meta.url)),'-o',exe],{timeout:15000,windowsHide:true});
  const result=await run(exe,[],{timeout:5000,windowsHide:true}); assert.match(result.stdout,/productionPointer:.*fake effects only/);
});

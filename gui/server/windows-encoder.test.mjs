import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
const run=promisify(execFile);

test('production Windows encoder candidate validates before publication and retains working state on preparation failure', async t => {
  const cc=process.env.DSKCPY_ENCODER_TEST_CC || process.env.CC || 'cc';
  let flags;
  try {
    await run(cc,['--version'],{timeout:5000,windowsHide:true});
    flags=(await run('pkg-config',['--cflags','--libs','libavcodec','libavutil'],{timeout:5000,windowsHide:true})).stdout;
  } catch {
    if(process.env.DSKCPY_REQUIRE_ENCODER_FIXTURE==='1')throw Error('Native CI requires the encoder compiler and FFmpeg development libraries.');
    t.skip('Requires a standalone C compiler and FFmpeg development libraries');return;
  }
  const raw=await readFile(new URL('../../app/src/reverse_display.c',import.meta.url),'utf8');
  const source=raw.replace(/\r\n/g,'\n');
  const body=(name, text=source)=>{
    text=text.replace(/\r\n/g,'\n');
    const match=new RegExp(`^static [^\\n]+\\n${name}\\(`,'m').exec(text);
    assert.ok(match,`Missing production function ${name}`);
    const start=match.index,open=text.indexOf('{',start);let depth=1,end=open+1;
    while(depth&&end<text.length){if(text[end]==='{')depth++;if(text[end]==='}')depth--;end++;}
    assert.equal(depth,0);return text.slice(start,end);
  };
  const names=['reverse_get_bit_rate','reverse_open_encoder','reverse_has_annexb_start_code',
    'reverse_avcc_length_size','reverse_normalize_h264','reverse_normalize_h264_config','reverse_try_video_quality'];
  const functions=names.map(name=>{assert.equal(body(name),body(name,source.replace(/\n/g,'\r\n')));return body(name);});
  const declaration=name=>source.match(new RegExp(`${name} \\{[\\s\\S]*?\\};`))[0];
  const code=`#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <stdatomic.h>
#include <libavcodec/avcodec.h>
#include <libavutil/opt.h>
#include "reverse_h264.h"
#include "reverse_quality.h"
#define ARRAY_LEN(a) (sizeof(a)/sizeof((a)[0]))
#define LOGE(...) ((void)0)
#define LOGW(...) ((void)0)
#define LOGI(...) fixture_info()
#define LOG_OOM() ((void)0)
${source.match(/^#define REVERSE_DISPLAY_(MAX_FRAME_SIZE|FRAME_FLAG_CONFIG|FRAME_FLAG_KEY) .+$/gm).join('\n')}
${declaration('struct reverse_buffer')}
${declaration('struct reverse_encoder_spec')}
${declaration('enum reverse_quality_result')}
struct scrcpy_options { uint32_t video_bit_rate; const char *video_encoder; };
struct reverse_display_state { const struct scrcpy_options *options; uint8_t video_profile[3]; atomic_bool stopped,video_paused;atomic_uint quality_level; };
static struct reverse_display_state *change_on_open;static unsigned change_kind;
static void fixture_info(void){if(change_on_open){if(change_kind==1)atomic_store(&change_on_open->quality_level,2);else if(change_kind==2)atomic_store(&change_on_open->video_paused,true);else atomic_store(&change_on_open->stopped,true);change_on_open=NULL;}}
static uint16_t sc_read16be(const uint8_t *p){return (uint16_t)((p[0]<<8)|p[1]);}
static unsigned writes,fail_at,keyframes;static uint8_t *saved;static size_t saved_size;static int64_t observed_pts;
static void clear_sink(void){writes=fail_at=keyframes=0;free(saved);saved=NULL;saved_size=0;}
static bool reverse_send_frame_packet(struct reverse_display_state *s,const uint8_t *data,size_t size,int64_t pts,uint32_t flags){
 if(++writes==fail_at)return false;
 if(flags==REVERSE_DISPLAY_FRAME_FLAG_CONFIG){free(saved);saved=malloc(size);assert(saved);memcpy(saved,data,size);saved_size=size;}
 else {assert(flags==REVERSE_DISPLAY_FRAME_FLAG_KEY);assert(sc_reverse_h264_validate(saved,saved_size,data,size,16,16,s->video_profile));keyframes++;observed_pts=pts;}
 return true;
}
${functions.join('\n')}
int main(void){
 struct scrcpy_options options={8000000,"libx264"};struct reverse_encoder_spec spec;
 AVCodecContext *encoder=reverse_open_encoder(&options,16,16,60,NULL,&spec);assert(encoder);
 AVFrame *frame=av_frame_alloc();assert(frame);frame->format=AV_PIX_FMT_YUV420P;frame->width=frame->height=16;
 assert(av_frame_get_buffer(frame,32)>=0);memset(frame->data[0],16,frame->linesize[0]*16);
 memset(frame->data[1],128,frame->linesize[1]*8);memset(frame->data[2],128,frame->linesize[2]*8);
 frame->pts=100;frame->pict_type=AV_PICTURE_TYPE_I;assert(avcodec_send_frame(encoder,frame)>=0);
 AVPacket *first=av_packet_alloc();assert(first&&avcodec_receive_packet(encoder,first)>=0);
 struct reverse_display_state s={.options=&options};assert(sc_reverse_h264_profile(first->data,first->size,s.video_profile));av_packet_free(&first);
 atomic_init(&s.stopped,false);atomic_init(&s.video_paused,false);atomic_init(&s.quality_level,1);
 AVCodecContext *original=encoder;struct sc_reverse_quality target={30,7200000};int64_t pts=-1;frame->pts=200;
 atomic_store(&s.video_paused,true);assert(reverse_try_video_quality(&s,&encoder,&spec,frame,target,1,&pts)==REVERSE_QUALITY_DEFERRED);assert(encoder==original&&!writes);
 atomic_store(&s.video_paused,false);atomic_store(&s.quality_level,2);assert(reverse_try_video_quality(&s,&encoder,&spec,frame,target,1,&pts)==REVERSE_QUALITY_DEFERRED);assert(encoder==original&&!writes);atomic_store(&s.quality_level,1);
 s.video_profile[1]^=1;assert(reverse_try_video_quality(&s,&encoder,&spec,frame,target,1,&pts)==REVERSE_QUALITY_RETAINED);assert(encoder==original&&!writes);s.video_profile[1]^=1;
 const char *name=spec.name;spec.name="dskcpy-no-such-encoder";assert(reverse_try_video_quality(&s,&encoder,&spec,frame,target,1,&pts)==REVERSE_QUALITY_RETAINED);assert(encoder==original&&!writes);spec.name=name;
 for(unsigned cause=1;cause<=3;cause++){
  change_on_open=&s;change_kind=cause;assert(reverse_try_video_quality(&s,&encoder,&spec,frame,target,1,&pts)==REVERSE_QUALITY_DEFERRED);assert(encoder==original&&!writes);
  atomic_store(&s.quality_level,1);atomic_store(&s.video_paused,false);atomic_store(&s.stopped,false);
 }
 AVPacket *rescue=av_packet_alloc();assert(rescue&&avcodec_send_frame(encoder,frame)>=0&&avcodec_receive_packet(encoder,rescue)>=0);
 assert(sc_reverse_h264_validate(NULL,0,rescue->data,rescue->size,16,16,s.video_profile));av_packet_free(&rescue);frame->pts=300;
 assert(reverse_try_video_quality(&s,&encoder,&spec,frame,target,1,&pts)==REVERSE_QUALITY_APPLIED);
 assert(encoder!=original&&writes==2&&keyframes==1&&pts==300&&observed_pts==300);
 assert(encoder->bit_rate==7200000&&encoder->framerate.num==30);assert(frame->width==16&&frame->height==16);
 original=encoder;frame->pts=400;target=(struct sc_reverse_quality){15,3600000};atomic_store(&s.quality_level,2);
 for(unsigned failure=1;failure<=2;failure++){
  clear_sink();fail_at=failure;assert(reverse_try_video_quality(&s,&encoder,&spec,frame,target,2,&pts)==REVERSE_QUALITY_FATAL);
  assert(encoder==original&&writes==failure&&!keyframes);
 }
 clear_sink();atomic_store(&s.stopped,true);assert(reverse_try_video_quality(&s,&encoder,&spec,frame,target,2,&pts)==REVERSE_QUALITY_DEFERRED);assert(encoder==original&&!writes);
 avcodec_free_context(&encoder);av_frame_free(&frame);clear_sink();
 puts("production encoder: validated IDR, retained context, cancellation and publication failures; generated pixels only");return 0;
}
`;
  const directory=await mkdtemp(path.join(os.tmpdir(),'dskcpy-encoder-fixture-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const c=path.join(directory,'fixture.c'),exe=path.join(directory,process.platform==='win32'?'fixture.exe':'fixture');await writeFile(c,code);
  // pkg-config is trusted build metadata; split quoting without invoking a shell.
  const words=(flags.match(/(?:[^\s"'\\]|\\.|"[^"]*"|'[^']*')+/g)||[]).map(w=>w.replace(/\\(.)|["']/g,(_m,escaped)=>escaped??''));
  await run(cc,['-std=c11','-Wall','-Wextra','-I',fileURLToPath(new URL('../../app/src/',import.meta.url)),c,
    fileURLToPath(new URL('../../app/src/reverse_h264.c',import.meta.url)),...words,'-o',exe],{timeout:30000,maxBuffer:1024*1024,windowsHide:true});
  const result=await run(exe,[],{timeout:15000,maxBuffer:1024*1024,windowsHide:true});assert.match(result.stdout,/production encoder: validated IDR/);
});

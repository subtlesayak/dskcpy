import test from 'node:test';
import assert from 'node:assert/strict';
import { createVideoFeedback } from '../receiver/video-feedback.mjs';
const counters=(frames=0,extra={})=>({epoch:1,frames,dropped:0,totalDecodeMs:frames*3,queue:0,packets:frames*10,lost:0,rttMs:30,...extra});
test('feedback uses bounded counter deltas and clears history while away',async()=>{
 let time=0,allowed=true,value=counters();const sent=[];
 const f=createVideoFeedback({now:()=>time,active:()=>allowed,read:async()=>value,send:s=>sent.push(s),setTimer:()=>0,clearTimer:()=>{}});
 await f.poll();time+=2000;value=counters(60,{packets:1000,lost:10});await f.poll();
 assert.equal(sent.length,1);assert.equal(sent[0].frames,60);assert.equal(sent[0].decodeMs,3);assert.equal(sent[0].rttMs,30);assert.ok(sent[0].lossPct>0);
 allowed=false;await f.poll();time+=30000;allowed=true;value=counters(100);await f.poll();assert.equal(sent.length,1);
 time+=2000;value=counters(160);await f.poll();assert.equal(sent.length,2);
 time+=2000;value=counters(5,{epoch:2});await f.poll();assert.equal(sent.length,2);
 time+=2000;value=counters(NaN,{epoch:2});await f.poll();assert.equal(sent.length,2);f.close();
});
test('retired async samples and concurrent timer ticks never send feedback',async()=>{
 let finish,reads=0;const sent=[];const f=createVideoFeedback({active:()=>true,read:()=>{reads++;return new Promise(r=>finish=r)},send:s=>sent.push(s),setTimer:()=>0,clearTimer:()=>{}});
 const pending=f.poll();await f.poll();assert.equal(reads,1);f.close();finish(counters());await pending;assert.deepEqual(sent,[]);
});

test('pause and immediate return invalidate a pending sample even when active again',async()=>{
 let time=0,value=counters(),finish;const sent=[];
 let read=async()=>value;
 const f=createVideoFeedback({now:()=>time,active:()=>true,read:()=>read(),send:s=>sent.push(s),setTimer:()=>0,clearTimer:()=>{}});
 await f.poll();time=2000;read=()=>new Promise(r=>finish=r);const pending=f.poll();
 f.reset?.();finish(counters(60));await pending;assert.equal(sent.length,0);
 read=async()=>counters(80);time=4000;await f.poll();assert.equal(sent.length,0);f.close();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdaptiveVideo, validVideoFeedback } from './adaptive-video.mjs';
const measurement = (sequence, extra = {}) => ({type:'video-feedback',sequence,durationMs:2000,frames:100,dropped:0,decodeMs:5,queue:0,lossPct:0,rttMs:30,...extra});
test('measured congestion lowers a bounded level and sustained recovery raises slowly', () => {
 let time=0;const p=createAdaptiveVideo({now:()=>time});
 const feed=(i,e)=>{time+=2000;return p.sample(measurement(i,e))};
 assert.equal(feed(1,{lossPct:8}),null);assert.equal(feed(2,{lossPct:8}),1);
 assert.equal(feed(3,{queue:3}),null);assert.equal(feed(4,{queue:3}),null);assert.equal(feed(5,{queue:3}),2);
 for(let i=6;i<16;i++) assert.equal(feed(i,{}),i===15?1:null);
 for(let i=16;i<26;i++) assert.equal(feed(i,{}),i===25?0:null);
 assert.equal(p.level,0);
});
test('idle, reordered, too-fast and invalid samples cannot raise quality or bypass limits',()=>{
 let time=0;const p=createAdaptiveVideo({now:()=>time,level:2});
 for(let i=1;i<50;i++){time+=2000;assert.equal(p.sample(measurement(i,{frames:0,decodeMs:null,lossPct:null,rttMs:null})),null)}
 assert.equal(p.level,2);assert.equal(p.sample(measurement(48)),null);
 assert.equal(p.sample(measurement(51,{queue:100})),null);
 for(const extra of [{durationMs:0},{sequence:Infinity},{rttMs:NaN},{frames:-1},{lossPct:101},{evil:1}]) assert.equal(validVideoFeedback(measurement(52,extra)),false);
 assert.equal(p.manual(),0);assert.equal(p.level,0);
});
test('constant long-distance network delay is not congestion; a growing RTT can reduce video',()=>{
 let time=0;const p=createAdaptiveVideo({now:()=>time});
 for(let i=1;i<=12;i++){time+=2000;assert.equal(p.sample(measurement(i,{rttMs:700})),null)}
 time+=2000;assert.equal(p.sample(measurement(13,{rttMs:1500})),null);
 time+=2000;assert.equal(p.sample(measurement(14,{rttMs:1500})),1);
});

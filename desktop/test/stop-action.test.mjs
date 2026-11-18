import test from 'node:test';
import assert from 'node:assert/strict';
import { createStopAction } from '../stop-action.mjs';

function fixture(phase='sharing') {
  let state={phase,canStop:true},questions=0,stops=0,answer;
  const action=createStopAction({snapshot:()=>state,stop:async()=>{stops++;state={phase:'ready',canStop:false};return state;},
    confirm:()=>{questions++;return new Promise(resolve=>{answer=resolve;});}});
  return {action,answer:value=>answer(value),counts:()=>({questions,stops}),end:()=>{state={phase:'ready',canStop:false};}};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('Cancel and repeated explicit Stop preserve sharing without duplicate prompts',async()=>{
  const f=fixture(),one=f.action(),two=f.action();assert.equal(one,two);await tick();assert.deepEqual(f.counts(),{questions:1,stops:0});
  f.answer(false);assert.equal((await one).phase,'sharing');assert.deepEqual(f.counts(),{questions:1,stops:0});
});
test('confirmed explicit Stop ends the owned session once',async()=>{
  const f=fixture(),one=f.action(),two=f.action();await tick();f.answer(true);
  assert.equal((await one).canStop,false);await two;assert.deepEqual(f.counts(),{questions:1,stops:1});
});
test('session ending while the prompt is open does not issue a stale Stop',async()=>{
  const f=fixture(),one=f.action();await tick();f.end();f.answer(true);await one;
  assert.deepEqual(f.counts(),{questions:1,stops:0});await f.action();assert.deepEqual(f.counts(),{questions:1,stops:0});
});
test('Cancel invitation remains immediate and does not request active-session confirmation',async()=>{
  const f=fixture('preparing');await f.action();assert.deepEqual(f.counts(),{questions:0,stops:1});
});
test('a failed confirmation never stops sharing and can be retried explicitly',async()=>{
  let calls=0,stops=0;const action=createStopAction({snapshot:()=>({phase:'sharing',canStop:true}),stop:async()=>{stops++;},
    confirm:async()=>{if(++calls===1)throw Error('owned prompt failure');return false;}});
  await assert.rejects(action(),/owned prompt failure/);await action();assert.equal(calls,2);assert.equal(stops,0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createVideoPreference } from '../receiver/video-preference.mjs';

test('only an explicit automatic/manual choice persists; malformed and future records keep the host default', () => {
  const data = new Map(), storage = () => ({ getItem: k => data.get(k), setItem: (k,v) => data.set(k,v) });
  const p = createVideoPreference({storage}); assert.equal(p.automatic, null); assert.equal(data.size, 0);
  assert.equal(p.choose(false), true);
  assert.equal(data.get('dskcpy.video.v1'), '{"version":1,"automatic":false}');
  assert.equal(createVideoPreference({storage}).automatic, false);
  assert.equal(p.choose(true), true); assert.equal(createVideoPreference({storage}).automatic, true);
  for (const raw of ['null','[]','bad','x'.repeat(65),'{"version":2,"automatic":false}',
    '{"version":1,"automatic":"false"}','{"version":1,"automatic":false,"level":2}']) {
    data.set('dskcpy.video.v1',raw); assert.equal(createVideoPreference({storage}).automatic,null);
  }
  assert.equal(p.choose('false'), false); assert.equal(p.automatic, true);
});
test('blocked or full browser storage keeps the explicit choice in memory without throwing', () => {
  for (const storage of [() => null, () => {throw Error('Denied')}, () => ({getItem:()=>null,setItem:()=>{throw Error('Full')}})]) {
    const p = createVideoPreference({storage}); assert.equal(p.automatic,null);
    assert.equal(p.choose(false),false); assert.equal(p.automatic,false);
    assert.equal(p.choose(true),false); assert.equal(p.automatic,true);
  }
});

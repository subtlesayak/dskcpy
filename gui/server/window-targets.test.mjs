import test from 'node:test';
import assert from 'node:assert/strict';
import {createWindowTargets,publicWindowState} from './window-targets.mjs';
const raw=[{id:11,ownerPid:41,label:'Editor'},{id:12,ownerPid:42,label:'Notes'}];
const initial={windowId:11,windowOwnerPid:41};
test('window grants keep native identities private and use fresh ephemeral receiver keys',()=>{
 const a=createWindowTargets(raw,initial),b=createWindowTargets(raw,initial);
 assert.notEqual(a.grant,b.grant);assert.notEqual(a.initial.key,b.initial.key);
 const view=publicWindowState(a,a.initial,false);
 assert.deepEqual(Object.keys(view.windows[0]),['key','label']);
 assert.equal(view.current,a.initial.key);assert.equal(view.windows.length,2);
 assert.ok(Object.isFrozen(a.targets));assert.ok(Object.isFrozen(a.initial));
 assert.equal(createWindowTargets(undefined,initial),null);
});
test('window grants reject desktop, stale initial identity, duplicates and unbounded or malformed targets',()=>{
 for(const invalid of [null,{},[],[raw[0]],Array(9).fill(raw[0]),[raw[0],raw[0]],
  [raw[0],{...raw[1],id:0}],[raw[0],{...raw[1],ownerPid:0}],
  [raw[0],{...raw[1],label:''}],[raw[0],{...raw[1],label:'x'.repeat(81)}],
  [raw[0],{...raw[1],id:1.5}],[raw[0],{...raw[1],desktop:true}],
  [raw[0],{...raw[1],ownerPid:2**31}],[raw[0],{...raw[1],id:2**32}]])
  assert.throws(()=>createWindowTargets(invalid,initial));
 for(const stale of [{}, {...initial,windowOwnerPid:99},{...initial,windowId:13}])
  assert.throws(()=>createWindowTargets(raw,stale));
 const safe=createWindowTargets([{...raw[0],label:'Editor\u202e\n'},raw[1]],initial);
 assert.equal(safe.initial.label,'Editor');
});

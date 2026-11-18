import test from 'node:test';
import assert from 'node:assert/strict';
import { browserSummary, presentationSummary } from '../presentation-state.mjs';
import { HostController } from '../host-controller.mjs';

const role = overrides => ({ presentation:true, presentationEnded:false, presentationAvailable:true,
  controllerConnected:true, controllerActive:true, controllerAuthorized:true, ...overrides });
test('host IPC preserves legacy status and forwards only fixed presentation booleans', () => {
  assert.deepEqual(browserSummary({waiting:false,connected:true,url:'PRIVATE',key:'PRIVATE'}),{waiting:false,connected:true});
  const value=browserSummary({waiting:false,connected:true,...role(),key:'PRIVATE',logs:['PRIVATE']});
  assert.deepEqual(value,{waiting:false,connected:true,presentation:{ended:false,available:true,controllerConnected:true,controllerActive:true,controllerAuthorized:true}});
  assert.equal(JSON.stringify(value).includes('PRIVATE'),false);
});
test('ended or absent presentation cannot advertise active phone input', () => {
  const ended=browserSummary({connected:true,...role({presentationEnded:true})}).presentation;
  assert.equal(ended.ended,true);assert.equal(ended.available,false);assert.equal(ended.controllerActive,false);
  const away=browserSummary({connected:true,...role({controllerConnected:false})}).presentation;
  assert.equal(away.controllerActive,false);assert.equal(away.controllerAuthorized,true);
  const unavailable=browserSummary({connected:true,...role({presentationAvailable:false})}).presentation;
  assert.equal(unavailable.controllerActive,false);
});
test('malformed explicit role data fails IPC without leaking diagnostics or guessing active sharing', () => {
  for(const field of ['presentationEnded','presentationAvailable','controllerConnected','controllerActive','controllerAuthorized'])
    assert.throws(()=>browserSummary({connected:true,...role({[field]:'PRIVATE'})}),/^Error: Presentation status is unavailable$/);
  assert.equal(presentationSummary(null),null);assert.equal(presentationSummary([]),null);
  assert.equal(presentationSummary({ended:true}),null);
});
test('host snapshot keeps ended presentation stoppable through later setup failure and clears stale roles', async () => {
  let status={running:true,browser:browserSummary({connected:true,...role({presentationEnded:true})})},stops=0;
  const host=new HostController({backend:{status:async()=>status,stop:async()=>{stops++;status={running:false,browser:browserSummary({})};}},
    checkSetup:async()=>({permissions:{screen:false,control:false},runtimeReady:false,route:{connected:false,ready:false}})});
  await host.refresh({setup:true});let snapshot=host.snapshot();
  assert.equal(snapshot.phase,'sharing');assert.equal(snapshot.canStop,true);assert.equal(snapshot.presentation.ended,true);
  snapshot.presentation.ended=false;assert.equal(host.snapshot().presentation.ended,true,'renderer cannot mutate source state');
  await host.stop();assert.equal(stops,1);assert.equal(host.snapshot().presentation,null);assert.equal(host.snapshot().canStop,false);
});

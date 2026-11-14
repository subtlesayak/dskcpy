import test from 'node:test';
import assert from 'node:assert/strict';
import { createClipboardBroker } from './browser-clipboard.mjs';
import { clipboardRequest, readClipboardRequest, readClipboardReply, clipboardText } from '../receiver/clipboard.mjs';
import { validBrowserInput, SrdParser } from './browser-protocol.mjs';
function reply(op, id, status = 0, text = '') {
  const bytes = Buffer.from(text); const out = Buffer.alloc(8 + bytes.length); out[0] = op; out[1] = status; out.writeUInt32BE(id, 2); out.writeUInt16BE(bytes.length, 6); bytes.copy(out, 8); return out;
}
function fixture(capable = true, timeoutMs = 1000) {
  let allowed = true; const native = [], responses = [];
  const broker = createClipboardBroker({ capable, allowed: () => allowed, sendNative: p => { native.push(Buffer.from(p)); return true; }, respond: (peer, value) => responses.push({peer,value}), timeoutMs });
  return { broker, native, responses, block: () => { allowed = false; } };
}
test('clipboard wire is bounded strict UTF-8 with explicit read/write/paste and no empty writes', () => {
  const content = 'café 世界 🙂\nsecond line';
  for (const op of [0,1,2]) { const p = clipboardRequest(op, 1, op ? content : ''); assert.deepEqual(readClipboardRequest(p), {op,id:1,text:op?content:''}); assert.equal(validBrowserInput(Buffer.from(p), 640, 480, {keyboard:true,clipboard:true}), true); }
  for (const text of ['x'.repeat(4097), '\u0000', '\u001b', '\ud800']) assert.throws(() => clipboardText(text));
  for (const [op,id,text] of [[0,0,''],[3,1,''],[1,1,''],[0,1,'secret']]) assert.throws(() => clipboardRequest(op,id,text));
  const bytes = clipboardRequest(1,7,'text'); assert.equal(validBrowserInput(Buffer.from(bytes),640,480,{keyboard:true}),false);
  assert.equal(validBrowserInput(Buffer.from(bytes),640,480,{clipboard:true}),false);
  bytes[7]++; assert.throws(() => readClipboardRequest(bytes));
  assert.deepEqual(readClipboardReply(reply(0,7,0,content)), {op:0,id:7,status:0,text:content});
  assert.throws(() => readClipboardReply(reply(1,7,0,'secret')));
  assert.throws(() => readClipboardReply(reply(0,7,4,'secret')));
});
test('clipboard requires both host capability and this viewer opt-in; disable cannot trigger OS requests', () => {
  const peer = {}, denied = fixture(false); assert.equal(denied.broker.enable(peer),false); assert.equal(denied.broker.request(peer,clipboardRequest(0,1)),false); assert.equal(denied.native.length,0);
  const f=fixture(); assert.equal(f.broker.request(peer,clipboardRequest(0,1)),false); assert.equal(f.native.length,0);
  assert.equal(f.broker.enable(peer),true); assert.equal(f.broker.request(peer,clipboardRequest(0,7)),true);
  assert.equal(readClipboardRequest(f.native[0]).id,1); f.broker.reply(reply(0,1,0,'fixture-only'));
  assert.deepEqual(f.responses[0],{peer,value:{type:'clipboard-result',op:0,id:7,status:0,text:'fixture-only'}});
  f.broker.disable(); assert.equal(f.broker.request(peer,clipboardRequest(0,8)),false);
});
test('a cancelled old-page clipboard reply cannot be delivered to a new page reusing the same client ID', () => {
  const f=fixture(), first={},second={};f.broker.enable(first);f.broker.request(first,clipboardRequest(0,1));
  f.broker.disable(); assert.deepEqual([...f.native.at(-1)],[10,3,0,0,0,0,0,0]);
  f.broker.enable(second);f.broker.request(second,clipboardRequest(0,1)); assert.equal(readClipboardRequest(f.native.at(-1)).id,2);
  f.broker.reply(reply(0,1,0,'stale secret')); assert.equal(f.responses.length,0);
  f.broker.reply(reply(0,2,0,'new fixture'));assert.equal(f.responses.length,1);assert.equal(f.responses[0].peer,second);assert.equal(f.responses[0].value.text,'new fixture');f.broker.disable();
});
test('clipboard timeout cancels pending work and suppresses a late response, without replay', async () => {
  const f=fixture(true,10), peer={};f.broker.enable(peer);f.broker.request(peer,clipboardRequest(2,1,'fixture text'));
  await new Promise(resolve=>setTimeout(resolve,25)); assert.equal(f.responses[0].value.status,6);assert.equal(f.native.length,2);
  f.broker.reply(reply(2,1));assert.equal(f.responses.length,1);f.broker.disable();
});
test('clipboard serializes operations, rejects duplicate IDs and drops data after input is blocked', () => {
  const f=fixture(),peer={};f.broker.enable(peer);f.broker.request(peer,clipboardRequest(0,3));
  assert.equal(f.broker.request(peer,clipboardRequest(0,3)),false);f.broker.request(peer,clipboardRequest(1,4,'fixture'));
  assert.equal(f.responses[0].value.status,5);assert.equal(f.native.length,1);
  f.block();f.broker.reply(reply(0,1,0,'not delivered'));assert.equal(f.responses.length,1);f.broker.disable();
});
test('metadata packets have their own small bound and do not change existing media framing', () => {
  const header=Buffer.from('535244310000000100000280000001e0','hex'), body=reply(0,1,0,'fixture');
  const p=Buffer.alloc(16+body.length);p.writeUInt32BE(body.length);p.writeUInt32BE(32,12);body.copy(p,16);
  const found=[];const parser=new SrdParser((p,h)=>found.push({p,h})); for(const b of Buffer.concat([header,p]))parser.push(Buffer.from([b]));
  assert.equal(found.length,2);assert.deepEqual(found[1].p,p);
  const invalid=Buffer.alloc(16);invalid.writeUInt32BE(4105);invalid.writeUInt32BE(32,12);
  const bad=new SrdParser(()=>{});bad.push(header);assert.throws(()=>bad.push(invalid));
});

test('clipboard requests are rate bounded independently of media and never enter remembered grants', async t => {
  const f=fixture(),peer={};f.broker.enable(peer);
  for(let id=1;id<=4;id++){assert.equal(f.broker.request(peer,clipboardRequest(0,id)),true);f.broker.reply(reply(0,id));}
  const before=f.native.length;f.broker.request(peer,clipboardRequest(0,5));assert.equal(f.native.length,before);assert.equal(f.responses.at(-1).value.status,5);f.broker.disable();
  const {createTrustedDevices,deviceDigest}=await import('./trusted-devices.mjs');
  const {mkdtemp,rm}=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path');
  const dir=await mkdtemp(path.join(os.tmpdir(),'dskcpy-no-clipboard-trust-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const store=createTrustedDevices({filename:path.join(dir,'synthetic.json')});await store.ready;
  await assert.rejects(store.approve({id:'a'.repeat(32),digest:deviceDigest('x'.repeat(43)),name:'Fixture',origin:'https://fixture.invalid',profile:{maxSize:1600,maxFps:30,bitRateMbps:8,browserClipboard:true}}),/Invalid device enrollment/);
  assert.deepEqual(store.snapshot().devices,[]);
});

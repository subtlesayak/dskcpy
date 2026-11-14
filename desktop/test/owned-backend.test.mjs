import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { OwnedBackend } from '../owned-backend.mjs';

function fixture({ failFirstReady = false } = {}) {
  const children = []; let exits = 0;
  const backend = new OwnedBackend({ modulePath: 'owned-entry.cjs', environment: {}, onExit: () => exits++,
    fork(module, args, options) {
      const child = new EventEmitter(); child.calls = []; child.killed = false; child.status = { running: false, browser: {} };
      child.postMessage = message => { child.calls.push(message.action);
        const ok = !(failFirstReady && children[0]?.child === child && message.action === 'ready');
        queueMicrotask(() => child.emit('message', { id: message.id, ok, value: message.action === 'status' ? child.status : true })); };
      child.kill = () => { child.killed = true; child.emit('exit', 0); };
      children.push({ child, module, args, options }); return child;
    } });
  return { backend, children, exits: () => exits };
}
const route = { origin: 'https://host.test.ts.net:8443', bind: '100.64.0.1' };

test('only the fixed receiver conflict category crosses owned IPC errors', async () => {
  const f=fixture();await f.backend.ensure(route);const child=f.children[0].child;
  child.postMessage=message=>queueMicrotask(()=>child.emit('message',{id:message.id,ok:false,code:'receiver-port-in-use',error:'private diagnostic'}));
  await assert.rejects(f.backend.prepareReceiver(),error=>error.code==='receiver-port-in-use'&&!error.message.includes('private diagnostic'));
  child.postMessage=message=>queueMicrotask(()=>child.emit('message',{id:message.id,ok:false,code:'private diagnostic'}));
  await assert.rejects(f.backend.prepareReceiver(),error=>error.code===undefined&&!error.message.includes('private diagnostic'));
  child.postMessage=message=>queueMicrotask(()=>child.emit('message',{id:message.id,ok:true}));await f.backend.shutdown();
});
test('desktop service is a created child, never an existing controller discovered by port', async () => {
  const f = fixture(); await f.backend.ensure(route); await f.backend.ensure(route);
  assert.equal(f.children.length, 1); assert.deepEqual(f.children[0].child.calls, ['ready']);
  assert.equal(f.children[0].options.env.DSKCPY_VIEWER_ORIGIN, route.origin);
  await f.backend.shutdown(); assert.equal(f.children[0].child.killed, true); assert.equal(f.exits(), 0);
});
test('a connection change refuses to retire an owned active stream', async () => {
  const f = fixture(); await f.backend.ensure(route); f.children[0].child.status.running = true;
  await assert.rejects(f.backend.ensure({ ...route, bind: '100.64.0.2' }), /Stop this app/);
  assert.equal(f.children.length, 1); assert.equal(f.children[0].child.killed, false);
  await f.backend.shutdown();
});
test('an idle reconfiguration retires exactly the previous owned handle', async () => {
  const f = fixture(); await f.backend.ensure(route); await f.backend.ensure({ ...route, bind: '100.64.0.2' });
  assert.equal(f.children.length, 2); assert.equal(f.children[0].child.killed, true);
  assert.equal(f.children[1].child.killed, false); assert.equal(f.exits(), 0); await f.backend.shutdown();
});
test('failed startup retires its child and a retry can create a fresh service', async () => {
  const f = fixture({ failFirstReady: true }); await assert.rejects(f.backend.ensure(route));
  assert.equal(f.children[0].child.killed, true); assert.equal(f.exits(), 0);
  await f.backend.ensure(route); assert.equal(f.children.length, 2);
  assert.equal(f.children[1].child.killed, false); await f.backend.shutdown();
});

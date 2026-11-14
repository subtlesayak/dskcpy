import { clipboardRequest, readClipboardRequest, readClipboardReply, cancelClipboardPacket } from '../receiver/clipboard.mjs';

// Contents are transient transport bytes, never status/log/remembered-profile
// fields. Host IDs are distinct across viewer replacements, even if a new page
// restarts its own counter at one. At most one operation is outstanding.
export function createClipboardBroker({ capable, allowed, sendNative, respond, timeoutMs = 8000 }) {
  let enabledPeer = null, pending = null, sequence = 0, lastClient = 0, rateAt = 0, count = 0;
  function cancel() {
    if (pending) { clearTimeout(pending.timer); pending = null; if (capable) sendNative(cancelClipboardPacket()); }
  }
  function disable() { cancel(); enabledPeer = null; lastClient = 0; }
  function enable(peer) {
    if (!capable || !allowed()) return false;
    disable(); enabledPeer = peer; return true;
  }
  function request(peer, packet) {
    if (!capable || enabledPeer !== peer || !allowed()) return false;
    const request = readClipboardRequest(packet);
    if (request.id <= lastClient) return false;
    lastClient = request.id;
    const now = Date.now(); if (now - rateAt >= 1000) { rateAt = now; count = 0; }
    if (pending || ++count > 4) { respond(peer, { type: 'clipboard-result', id: request.id, op: request.op, status: 5 }); return true; }
    if (++sequence > 0xffffffff) return false;
    const record = { nativeId: sequence, clientId: request.id, op: request.op, peer };
    record.timer = setTimeout(() => {
      if (pending !== record) return;
      pending = null; sendNative(cancelClipboardPacket());
      if (enabledPeer === peer && allowed()) respond(peer, { type: 'clipboard-result', id: record.clientId, op: record.op, status: 6 });
    }, timeoutMs);
    record.timer.unref?.(); pending = record;
    const outbound = clipboardRequest(request.op, record.nativeId, request.text);
    if (sendNative(outbound) === false) { cancel(); return false; }
    return true;
  }
  function reply(payload) {
    // Unsolicited, cancelled, old-page and old-operation results are dropped.
    if (!pending || payload.length < 8) return;
    const id = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(2);
    if (id !== pending.nativeId) return;
    const result = readClipboardReply(payload), record = pending;
    if (result.op !== record.op) throw Error('Invalid clipboard operation reply.');
    clearTimeout(record.timer); pending = null;
    if (enabledPeer === record.peer && allowed()) respond(record.peer, { ...result, id: record.clientId, type: 'clipboard-result' });
  }
  return { enable, disable, request, reply };
}

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const enabled = process.env.SCRCPY_NATIVE_INTERNET_TEST === '1' && process.platform === 'win32';
for (const scenario of ['disconnect', 'stop', 'owner-exit', 'stall']) {
test(`native Internet loopback: ${scenario}`, { skip: !enabled, timeout: 25000 }, async (t) => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  let peer;
  let packets = 0;
  let header;
  let bytes = Buffer.alloc(0);
  let child;
  let requestedStop = false;
  const server = net.createServer((socket) => {
    peer = socket;
    socket.on('error', () => {});
    socket.on('data', (data) => {
      if (requestedStop) return;
      bytes = Buffer.concat([bytes, data]);
      if (!header && bytes.length >= 16) {
        header = { magic: bytes.readUInt32BE(0), codec: bytes.readUInt32BE(4), width: bytes.readUInt32BE(8), height: bytes.readUInt32BE(12) };
        bytes = bytes.subarray(16);
      }
      while (header && bytes.length >= 16) {
        const size = bytes.readUInt32BE(0);
        assert.ok(size > 0 && size <= 16 * 1024 * 1024);
        if (bytes.length < 16 + size) return;
        const pts = bytes.readBigUInt64BE(4);
        const flags = bytes.readUInt32BE(12);
        bytes = bytes.subarray(16 + size); // Never write captured pixels to disk.
        if (!(flags & 1)) {
          packets++;
          const ack = Buffer.alloc(9);
          ack[0] = 4;
          ack.writeBigUInt64BE(pts, 1);
          if (scenario !== 'stall') socket.write(ack);
          // Desktop Duplication emits no new video when the desktop is static.
          // A receiver resume requests a fresh IDR from the retained frame;
          // exercise that path without moving the user's mouse or windows.
          if (packets < 3) socket.write(Buffer.from([5, 8]));
        }
        if (packets >= 3 && scenario !== 'stall') {
          requestedStop = true;
          if (scenario === 'disconnect') socket.end();
          else child.stdin.end(scenario === 'stop' ? 'q' : undefined);
          server.close();
          return;
        }
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { peer?.destroy(); server.close(); child?.kill(); });
  const env = { ...process.env, ADB: path.join(root, 'nonexistent-adb-for-test.exe'), SCRCPY_GUI_CONTROL: 'stdin-v1' };
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  env[pathKey] = `C:\\msys64\\mingw64\\bin;${env[pathKey]}`;
  child = spawn(process.env.SCRCPY_TEST_BINARY || path.join(root, 'x-reverse/app/scrcpy.exe'), ['--reverse-display', `--reverse-socket=${server.address().port}`,
    '--max-size=640', '--max-fps=30', '--video-bit-rate=2M', '--verbosity=debug'], { cwd: root, env, windowsHide: true, shell: false });
  child.stdin.on('error', () => {});
  // stdout/stderr chunks may interleave in the middle of a native log line.
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (data) => { stdout += data; });
  child.stderr.on('data', (data) => { stderr += data; });
  const [code] = await once(child, 'exit');
  const log = stdout + '\n' + stderr;
  assert.equal(code, scenario === 'disconnect' ? 2 : scenario === 'stall' ? 1 : 0, log);
  assert.equal(header?.magic, 0x53524431);
  assert.equal(header?.codec, 1);
  assert.ok(header.width > 0 && header.height > 0);
  assert.ok(packets >= (scenario === 'stall' ? 2 : 3), log);
  assert.match(log, /Reverse display encoder:/);
  if (scenario === 'stall') assert.match(log, /stalled for 10 seconds.*reconnect/);
  else assert.match(log, /capture-to-decode round-trip:/);
  assert.doesNotMatch(log, /Using adb:|adb.*install|Server connection failed/);
});
}

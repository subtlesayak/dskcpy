// Test-only encoded media, generated from lavfi. No camera, microphone, screen,
// real application window, OS input or user-owned recording is accessed.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const execute = promisify(execFile);
const prefix = Buffer.from([0, 0, 0, 1]);
function annexB(bytes) {
  const starts = [];
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (bytes[i] || bytes[i + 1]) continue;
    const size = bytes[i + 2] === 1 ? 3 : bytes[i + 2] === 0 && bytes[i + 3] === 1 ? 4 : 0;
    if (size) { starts.push({ start: i, data: i + size }); i += size - 1; }
  }
  return starts.map((s, i) => bytes.subarray(s.data, starts[i + 1]?.start ?? bytes.length)).filter(b => b.length);
}
function opusPackets(bytes) {
  let at = 0, pieces = []; const packets = [];
  while (at < bytes.length) {
    if (at + 27 > bytes.length || bytes.toString('ascii', at, at + 4) !== 'OggS') throw Error('Invalid generated Ogg page');
    const count = bytes[at + 26], table = at + 27;
    if (table + count > bytes.length) throw Error('Incomplete generated Ogg lacing');
    let body = table + count;
    for (const size of bytes.subarray(table, table + count)) {
      if (body + size > bytes.length) throw Error('Incomplete generated Opus packet');
      pieces.push(bytes.subarray(body, body + size)); body += size;
      if (size < 255) { packets.push(Buffer.concat(pieces)); pieces = []; }
    }
    at = body;
  }
  if (pieces.length || packets[0]?.toString('ascii', 0, 8) !== 'OpusHead'
      || packets[1]?.toString('ascii', 0, 8) !== 'OpusTags') throw Error('Generated Opus headers missing');
  return { configuration: packets[0], frames: packets.slice(2) };
}
export function mediaPacket(payload, pts, flags) {
  const packet = Buffer.alloc(16 + payload.length);
  packet.writeUInt32BE(payload.length); packet.writeBigUInt64BE(BigInt(pts), 4); packet.writeUInt32BE(flags, 12); payload.copy(packet, 16); return packet;
}
export async function generateMediaFixture({ replacement = false, outOfBandParameters = false, retainSps = false, width = 640, height = 360, level = '3.0' } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dskcpy-synthetic-media-'));
  try {
    const video = path.join(directory, 'pattern.h264'), audio = path.join(directory, 'tone.ogg');
    const options = { timeout: 30000, maxBuffer: 1024 * 1024 };
    await execute('ffmpeg', ['-hide_banner', '-v', 'error', '-nostdin', '-f', 'lavfi', '-i', replacement ? `color=c=blue:size=${width}x${height}:rate=10` : `testsrc2=size=${width}x${height}:rate=10`,
      '-an', '-frames:v', '20', '-c:v', 'libx264', '-profile:v', 'baseline', '-level:v', level, '-preset', 'ultrafast', '-tune', 'zerolatency',
      '-pix_fmt', 'yuv420p', '-x264-params', `aud=1:repeat-headers=1:keyint=10:min-keyint=10:scenecut=0:sps-id=${replacement ? 1 : 0}`, '-f', 'h264', video], options);
    await execute('ffmpeg', ['-hide_banner', '-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-ac', '2', '-t', '2', '-c:a', 'libopus', '-frame_duration', '10', '-application', 'lowdelay', '-f', 'opus', audio], options);
    const h264 = await readFile(video), ogg = await readFile(audio);
    if (h264.length > 2 * 1024 * 1024 || ogg.length > 1024 * 1024) throw Error('Generated fixture too large');
    const nals = annexB(h264), units = []; let current = [];
    for (const nal of nals) {
      if ((nal[0] & 31) === 9 && current.length) { units.push(current); current = []; }
      current.push(nal);
    }
    if (current.length) units.push(current);
    const frames = units.map(ns => ({ key: ns.some(n => (n[0] & 31) === 5), payload: Buffer.concat(ns.filter(n=>!outOfBandParameters
      || ![7,8].includes(n[0]&31) || retainSps && (n[0]&31)===7).flatMap(n => [prefix, n])) }));
    const parameters = units[0].filter(n => [7, 8].includes(n[0] & 31));
    const sound = opusPackets(ogg);
    if (frames.length !== 20 || !frames[0].key || parameters.length !== 2 || sound.frames.length < 200) throw Error('Generated codec fixture incomplete');
    let parameterSetIds = null;
    if (outOfBandParameters) {
      const { stderr } = await execute('ffmpeg', ['-hide_banner','-v','info','-i',video,'-map','0:v:0','-c:v','copy',
        '-bsf:v','trace_headers','-f','null','-'], options);
      const ids = field => [...stderr.matchAll(new RegExp(`\\b${field}\\s+[01]+\\s+=\\s*(\\d+)`, 'g'))].map(m=>Number(m[1]));
      parameterSetIds = { sps: [...new Set(ids('seq_parameter_set_id'))], pps: [...new Set(ids('pic_parameter_set_id'))] };
      if (parameterSetIds.sps.length!==1 || parameterSetIds.pps.length!==1) throw Error('Generated parameter-set identifiers were not verified');
    }
    const { stdout } = await execute('ffmpeg', ['-version'], options);
    return { frames, configuration: Buffer.concat(parameters.flatMap(n => [prefix, n])), sound, parameterSetIds,
      width, height, encoder: stdout.split(/\r?\n/)[0] };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

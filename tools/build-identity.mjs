import { createHash } from 'node:crypto';
import { readFile, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repository = fileURLToPath(new URL('../', import.meta.url));

export function parseIdentity(text) {
  const fields = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue;
    const match = /^([A-Z_]+)=([0-9A-Za-z.+-]+)$/.exec(line);
    if (!match || fields[match[1]] !== undefined) throw new Error('Invalid or duplicate build identity field');
    fields[match[1]] = match[2];
  }
  const versionCode = Number(fields.DSKCPY_ANDROID_VERSION_CODE);
  if (!fields.DSKCPY_VERSION || !/^\d+(\.\d+)+$/.test(fields.SCRCPY_PROTOCOL_VERSION || '')
      || !Number.isSafeInteger(versionCode) || versionCode <= 50001 || versionCode > 2100000000
      || fields.REVERSE_PROTOCOL_VERSION !== '1' || Object.keys(fields).length !== 4) {
    throw new Error('Invalid build identity or Android version code (must exceed 50001)');
  }
  return { version: fields.DSKCPY_VERSION, androidVersionCode: versionCode,
    scrcpyProtocol: fields.SCRCPY_PROTOCOL_VERSION, reverseProtocol: 1 };
}

export async function readIdentity(root = repository) {
  return parseIdentity(await readFile(path.join(root, 'dskcpy.properties'), 'utf8'));
}

export async function hashFile(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

// A self-contained tree inventory: no absolute paths, links, timestamps or
// environment/account data. Refuse links rather than following them outside it.
export async function inventory(root, prefix = '') {
  const entries = [];
  for (const name of (await readdir(path.join(root, prefix))).sort()) {
    const relative = prefix ? `${prefix}/${name}` : name;
    const file = path.join(root, relative);
    const info = await lstat(file);
    if (info.isSymbolicLink()) throw new Error('Artifact tree contains a symbolic link');
    if (info.isDirectory()) entries.push(...await inventory(root, relative));
    else if (info.isFile()) entries.push({ path: relative, bytes: info.size, sha256: await hashFile(file) });
    else throw new Error('Artifact tree contains a special file');
  }
  return entries;
}

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const guiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const viteEntry = path.join(guiDir, 'node_modules', 'vite', 'bin', 'vite.js');

const children = [
  spawn(process.execPath, ['--watch', 'server/index.mjs'], {
    cwd: guiDir,
    stdio: 'inherit',
  }),
  spawn(process.execPath, [viteEntry, '--host', '127.0.0.1'], {
    cwd: guiDir,
    stdio: 'inherit',
  }),
];

let stopping = false;
function stop(exitCode = 0) {
  if (stopping) {
    return;
  }
  stopping = true;
  for (const child of children) {
    child.kill();
  }
  process.exitCode = exitCode;
}

for (const child of children) {
  child.on('exit', (code) => {
    if (!stopping && code !== 0) {
      stop(code ?? 1);
    }
  });
}

process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());

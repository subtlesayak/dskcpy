import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { inspectReadiness, resolveRuntime } from '../server/runtime.mjs';

// Shared executable resolution rejects directories and non-executable files,
// honors PATH names, and never substitutes another host for a broken override.
// --help loads dependencies and advertises capabilities without starting capture.
export async function verifyMacBrowserRuntime(repoDir, environment = process.env,
  runCommand = promisify(execFile)) {
  if (environment.SCRCPY_GUI_BINARY !== undefined && !environment.SCRCPY_GUI_BINARY.trim()) {
    throw new Error('Choose an executable Mac reverse-display host.');
  }
  const runtime = resolveRuntime(repoDir, { ...environment,
    SCRCPY_GUI_BINARY: environment.SCRCPY_GUI_BINARY ?? path.join(repoDir, 'build-macos/app/scrcpy'),
  }, 'darwin');
  if (!runtime.executable) throw new Error('Build or configure an executable Mac reverse-display host.');
  const readiness = await inspectReadiness(runtime, (exe, args, options) => runCommand(exe, args, {
    ...options, windowsHide: true, timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
  }));
  if (!readiness.transports.browser.ready) throw new Error(readiness.transports.browser.message);
  return runtime;
}

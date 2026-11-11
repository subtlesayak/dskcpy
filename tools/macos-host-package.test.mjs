import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectMachO } from '../release/package_macos_host.mjs';

const commands = 'Load command 0\n cmd LC_BUILD_VERSION\n platform 1\n minos 13.0\n sdk 15.0\n';
const libraries = 'binary:\n\t/System/Library/Frameworks/CoreMedia.framework/Versions/A/CoreMedia (compatibility version 1.0.0, current version 1.0.0)\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1.0.0)\n';
test('portable Mac host accepts arm64 system dependencies and declared deployment target', () => {
  assert.equal(inspectMachO(commands, libraries, 'x86_64 arm64').architecture, 'arm64');
  assert.throws(() => inspectMachO(commands, libraries, 'x86_64'), /lacks arm64/);
  assert.throws(() => inspectMachO(commands.replace('minos 13.0', 'minos 14.0'), libraries, 'arm64'), /deployment target/);
  assert.throws(() => inspectMachO(commands.replace('minos 13.0', 'minos 13.1'), libraries, 'arm64'), /deployment target/);
  assert.throws(() => inspectMachO('', libraries, 'arm64'), /deployment target/);
  for (const unsafe of ['/opt/homebrew/lib/libopus.dylib', '@rpath/libopus.dylib', '/tmp/libopus.dylib']) {
    assert.throws(() => inspectMachO(commands, libraries + `\t${unsafe} (compatibility version 1.0.0)\n`, 'arm64'), /Non-system/);
  }
});

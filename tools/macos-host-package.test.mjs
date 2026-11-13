import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectMachO, macHostArchitecture } from '../release/package_macos_host.mjs';

const commands = 'Load command 0\n cmd LC_BUILD_VERSION\n platform 1\n minos 13.0\n sdk 15.0\n';
const libraries = 'binary:\n\t/System/Library/Frameworks/CoreMedia.framework/Versions/A/CoreMedia (compatibility version 1.0.0, current version 1.0.0)\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1.0.0)\n';
test('portable Mac host accepts arm64 system dependencies and declared deployment target', () => {
  assert.equal(inspectMachO(commands, libraries, 'x86_64 arm64').architecture, 'arm64');
  assert.throws(() => inspectMachO(commands, libraries, 'x86_64'), /lacks arm64/);
  assert.throws(() => inspectMachO(commands.replace('minos 13.0', 'minos 14.0'), libraries, 'arm64'), /deployment target/);
  assert.throws(() => inspectMachO(commands.replace('minos 13.0', 'minos 13.1'), libraries, 'arm64'), /deployment target/);
  assert.throws(() => inspectMachO('', libraries, 'arm64'), /deployment target/);
  for (const unsafe of ['/opt/homebrew/lib/libopus.dylib', '@rpath/libopus.dylib', '/tmp/libopus.dylib', '/usr/lib/../../opt/private.dylib', '/System/Library/../../../tmp/private.dylib']) {
    assert.throws(() => inspectMachO(commands, libraries + `\t${unsafe} (compatibility version 1.0.0)\n`, 'arm64'), /Non-system/);
  }
});


test('Intel inspection is explicit, preserves minimum/linkage gates and rejects the opposite slice', () => {
  assert.equal(macHostArchitecture('x64'), 'x86_64'); assert.equal(macHostArchitecture('arm64'), 'arm64');
  for (const arch of ['ia32', 'x86_64', 'arm', 'ppc', '']) assert.throws(() => macHostArchitecture(arch));
  assert.equal(inspectMachO(commands, libraries, 'x86_64', 13, 'x86_64').architecture, 'x86_64');
  assert.equal(inspectMachO(commands, libraries, 'x86_64 arm64', 13, 'x86_64').architecture, 'x86_64');
  assert.throws(() => inspectMachO(commands, libraries, 'arm64', 13, 'x86_64'), /lacks x86_64/);
  assert.throws(() => inspectMachO(commands, libraries, 'x86_64', 13, 'x64'), /Unsupported/);
  assert.throws(() => inspectMachO(commands.replace('minos 13.0', 'minos 14.0'), libraries, 'x86_64', 13, 'x86_64'), /deployment target/);
  assert.throws(() => inspectMachO(commands, libraries + '\t@rpath/libbad.dylib (compatibility version 1.0.0)\n', 'x86_64', 13, 'x86_64'), /Non-system/);
});


test('Mac deployment guard includes patch versions and rejects non-macOS build platforms', () => {
  for (const arch of ['arm64', 'x86_64']) {
    for (const version of ['13.0.1', '13.1', '14.0']) assert.throws(() => inspectMachO(commands.replace('minos 13.0', `minos ${version}`), libraries, arch, 13, arch), /deployment target/);
    for (const version of ['10.13', '12.6.1', '13.0.0']) assert.equal(inspectMachO(commands.replace('minos 13.0', `minos ${version}`), libraries, arch, 13, arch).architecture, arch);
    for (const platform of [2, 6, 7, 10]) assert.throws(() => inspectMachO(commands.replace('platform 1', `platform ${platform}`), libraries, arch, 13, arch), /macOS build platform/);
    assert.throws(() => inspectMachO(commands.replace(' platform 1\n', ''), libraries, arch, 13, arch), /macOS build platform/);
  }
});

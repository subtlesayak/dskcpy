import test from 'node:test';
import assert from 'node:assert/strict';
import { macDesktopTarget } from '../package-mac.mjs';
test('Mac packaging selects the matching Electron architecture only after host and ADB metadata agree', () => {
  for (const [arch, macho, output] of [['arm64', 'arm64', 'mac-arm64'], ['x64', 'x86_64', 'mac']]) {
    const manifest = { platform: 'darwin', architecture: arch, linkage: { architecture: macho }, usbRuntime: { linkage: { architecture: macho } } };
    assert.deepEqual(macDesktopTarget(arch, manifest), { architecture: arch, macho, flag: `--${arch}`, output });
    for (const changed of [{ platform: 'win32' }, { architecture: 'wrong' }, { linkage: { architecture: 'wrong' } }, { usbRuntime: { linkage: { architecture: 'wrong' } } }])
      assert.throws(() => macDesktopTarget(arch, { ...manifest, ...changed }), /matching/);
    assert.throws(() => macDesktopTarget(arch, null), /matching/);
  }
  for (const arch of ['ia32', 'riscv64', 'ppc64']) assert.throws(() => macDesktopTarget(arch, {}), /Unsupported/);
});

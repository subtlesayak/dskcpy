import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { macBundleVersions, verifyMacBundleVersions } = require('../bundle-version.cjs');

test('prerelease names never enter numeric Apple version fields', () => {
  for (const version of ['0.1.0-preview.20261121', '0.1.0-rc.1', '0.1.0', '0.1.0+rebuild.2']) {
    assert.deepEqual(macBundleVersions(version, 50004), { bundleShortVersion: '0.1.0', bundleVersion: '5.0.4' });
  }
  assert.deepEqual(macBundleVersions('2.4.1-rc.2', 59999), { bundleShortVersion: '2.4.1', bundleVersion: '5.99.99' });
  assert.deepEqual(macBundleVersions('2.4.1', 60000), { bundleShortVersion: '2.4.1', bundleVersion: '6.0.0' });
  for (const version of ['01.2.3', '1.2', '1.2.3/../file', '1.2.3\n', '1.2.3-'])
    assert.throws(() => macBundleVersions(version, 50004));
  assert.throws(() => macBundleVersions('1.2.3' + String.fromCharCode(10), 50004));
  for (const code of [50001, 50004.5, Infinity, '50004', 100000000])
    assert.throws(() => macBundleVersions('0.1.0', code));
});

test('actual packaged metadata must match both source-derived Mac versions', () => {
  const expected = macBundleVersions('0.1.0-rc.1', 50004);
  assert.deepEqual(verifyMacBundleVersions({ CFBundleShortVersionString: '0.1.0', CFBundleVersion: '5.0.4' }, expected), expected);
  for (const info of [
    { CFBundleShortVersionString: '0.1.0-preview.20261121', CFBundleVersion: '0.1.0-preview.20261121' },
    { CFBundleShortVersionString: '0.1.0', CFBundleVersion: '5.0.3' },
    { CFBundleShortVersionString: '0.1.1', CFBundleVersion: '5.0.4' },
  ]) assert.throws(() => verifyMacBundleVersions(info, expected), /do not match/);
});

const path = require('node:path');
const { readFileSync } = require('node:fs');
const { macBundleVersions } = require('./bundle-version.cjs');
const identity = readFileSync(path.join(__dirname, '../dskcpy.properties'), 'utf8');
const codes = [...identity.matchAll(/^DSKCPY_ANDROID_VERSION_CODE=(\d+)$/gm)];
if (codes.length !== 1) throw Error('Expected one Android artifact version code');
const macVersion = macBundleVersions(require('./package.json').version, Number(codes[0][1]));
module.exports = {
  appId: 'com.dskcpy.host', productName: 'dskcpy Host',
  directories: { app: path.join(__dirname, 'stage/app'), output: path.join(__dirname, 'out') },
  asar: false, npmRebuild: false, nodeGypRebuild: false,
  files: ['**/*'],
  extraResources: [{ from: path.join(__dirname, 'stage/host'), to: 'host' }],
  // Development artifacts only. Release signing/notarization is a separate gate.
  mac: { target: [{ target: 'dir', arch: [process.arch] }], identity: null, ...macVersion,
    category: 'public.app-category.utilities', minimumSystemVersion: '13.0',
    extendInfo: { NSHighResolutionCapable: true,
      NSScreenCaptureUsageDescription: 'Share this computer’s screen with a device you invite.',
      NSAudioCaptureUsageDescription: 'Send desktop audio to your connected device.',
    } },
  win: { target: [{ target: 'dir', arch: ['x64'] }], signAndEditExecutable: false },
};

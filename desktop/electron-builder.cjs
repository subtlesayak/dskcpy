const path = require('node:path');
module.exports = {
  appId: 'com.dskcpy.host', productName: 'dskcpy Host',
  directories: { app: path.join(__dirname, 'stage/app'), output: path.join(__dirname, 'out') },
  asar: false, npmRebuild: false, nodeGypRebuild: false,
  files: ['**/*'],
  extraResources: [{ from: path.join(__dirname, 'stage/host'), to: 'host' }],
  // Development artifacts only. Release signing/notarization is a separate gate.
  mac: { target: [{ target: 'dir', arch: ['arm64'] }], identity: null,
    category: 'public.app-category.utilities', minimumSystemVersion: '13.0',
    extendInfo: { NSHighResolutionCapable: true,
      NSScreenCaptureUsageDescription: 'Share this computer’s screen with a device you invite.',
      NSAudioCaptureUsageDescription: 'Send desktop audio to your connected device.',
    } },
  win: { target: [{ target: 'dir', arch: ['x64'] }], signAndEditExecutable: false },
};

// Apple bundle versions are numeric even when the distributable is a prerelease.
// Keep the user-facing artifact identity in package.json and the build manifest.
function macBundleVersions(version, androidVersionCode) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version || '');
  if (!match || match[0] !== version || !Number.isSafeInteger(androidVersionCode) || androidVersionCode < 50002 || androidVersionCode > 99999999)
    throw Error('Invalid artifact identity for numeric Mac bundle versions');
  const build = [Math.floor(androidVersionCode / 10000), Math.floor(androidVersionCode / 100) % 100, androidVersionCode % 100];
  return { bundleShortVersion: match.slice(1, 4).join('.'), bundleVersion: build.join('.') };
}

function verifyMacBundleVersions(info, expected) {
  if (info?.CFBundleShortVersionString !== expected.bundleShortVersion || info?.CFBundleVersion !== expected.bundleVersion)
    throw Error('Packaged Mac bundle versions do not match the artifact identity');
  return expected;
}

module.exports = { macBundleVersions, verifyMacBundleVersions };

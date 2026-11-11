# Build identity and compatible upgrades

`dskcpy.properties` is the fork's artifact identity. Android builds now use
version code **50002**, above the received companion's recorded **50001**.
Future distributed Android versions must increase this code. Keep the package
`com.genymobile.scrcpy` and the existing signing lineage to preserve installed
settings and app data.

Artifact version `0.1.0-dev` is separate from the inherited scrcpy wire version
`4.1` and reverse protocol `1`. Both Gradle and standalone-server builds accept
the existing native client's `4.1` argument. This change does not renegotiate
reverse framing or message IDs.

## Check an Android artifact

Use Node.js 22.12+ and the Android SDK build-tools/JDK described in the platform
setup guide. Before permitting the host to update an installed companion, run:

```sh
node tools/check-android-upgrade.mjs \
  --apk companion/reverse-display.apk \
  --sdk-tools "$ANDROID_HOME/build-tools/36.0.0" --device
```

The check verifies the candidate and installed APK signatures with `apksigner`,
reads their package/version/certificate identities, and rejects a lower version
or different signer. ADB must select exactly one authorized device; set
`ANDROID_SERIAL` locally if needed. The installed base APK is pulled into a
private temporary directory and removed even when verification fails. No app is
installed, uninstalled or modified. For offline comparison, use
`--installed-apk OLD_APK` instead of `--device`.

Use `--require-current` to ensure a candidate matches the source's artifact
version/code. `--output NEW_FILE` writes a hash/identity receipt without
overwriting an existing one. The output contains no device serial or path.
Keep installed-app receipts private; only share project artifact hashes and
redacted technical outcomes.

This is a separate explicit preflight command, not a new prerequisite added to
the existing native/GUI installation flow. The existing installer still uses
`adb install -r`, with Android's own signature/downgrade checks. Do not bypass a
failure with uninstall, `-d`, a new application ID, or a replacement signing key.
A source version bump alone cannot make a differently signed APK compatible.
CI's ephemeral debug key is not a stable upgrade lineage; obtain the matching
privately maintained key's artifact through the agreed private handoff. Key
rotation/lineage support requires separate review; the preflight conservatively
requires the exact signer set.

Automated fixtures cover identity comparison and temporary-file cleanup. CI
also inspects an actual generated APK. Neither is a physical, data-preserving
upgrade test; perform that only with an authorized fixture device and matching
key. No device upgrade was performed for this source change.

## Separate Mac hosting candidate

The inherited `release/build_macos.sh` remains the Android-to-computer client
target. A separate Apple-silicon **macOS 13.0 deployment target** builds the
experimental host, GUI and browser receiver:

```sh
brew install cmake meson ninja pkgconf wget nasm node
bash release/build_macos_host.sh release/work/host-arm64
release/work/host-arm64/Start-dskcpy-host.command --check
```

Choose a new output directory for every candidate. The build uses an isolated
`macos-host13-native-static` dependency cache and enables `reverse_macos`,
libopus encoding and VideoToolbox. It builds pinned SDL, dav1d, Opus and FFmpeg
sources with the deployment target rather than bundling local Homebrew runtime
libraries. Opus's pinned checksum is from its [official release](https://opus-codec.org/downloads/).
ADB is included from the existing pinned platform-tools archive. The installable
Android companion and standalone server remain separate matching artifacts.

Packaging checks arm64, deployment targets and system-only dynamic linkage for
both native host and ADB. It includes icons, GUI production dependencies,
browser assets, licenses and a manifest of relative paths/sizes/SHA-256 hashes,
source commit/modification status, build/wire identity and qualification limits.
Node.js 22.12+ remains an external prerequisite. The launcher can reuse an
existing dashboard without interrupting it; `--check` tests the candidate's
readiness without capture or receiver connection.

CI builds/tests this separate candidate and retains a short-lived intermediate
artifact. No developer signing, notarization, installation or release
publication is performed. A successful link/deployment scan is **not** proof of
clean-machine macOS 13 compatibility. Test each declared OS, permissions and
physical media/input before describing it as a supported portable release.

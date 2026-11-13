# Native Mac host architectures

The hosting build and unsigned desktop packaging now have explicit Apple-silicon
and Intel paths. They are separate native builds. The browser receiver, native
capture/input code and Android wire are unchanged. This is not a universal
executable, cross-build or a claim that all Mac models/OS versions are qualified.

| Build machine and Node | Mach-O slice | Isolated dependency cache | Desktop output |
| --- | --- | --- | --- |
| Apple silicon / arm64 | arm64 | macos-host13-arm64-native-static | desktop/out/mac-arm64 |
| Intel / x64 | x86_64 | macos-host13-x86_64-native-static | desktop/out/mac |

Use native Node and tools for the build machine. The release script refuses a
requested foreign/unknown target and mismatched Node before building. It does
not install or start Rosetta. Choose a fresh output directory for each run:

```sh
# On an Apple-silicon Mac:
bash release/build_macos_host.sh release/work/host-arm64
# On an Intel Mac:
bash release/build_macos_host.sh release/work/host-x64
```

The inherited Android-to-Mac build and legacy hosting dependency cache stay
separate and untouched. Pinned source archives may be shared, but their checksums
remain required before extraction; architecture-specific builds/installs are
never shared. Source versions, checksums and macOS13.0 deployment target remain
unchanged. SDL uses the explicit native architecture. Compiler/linker flags and
Meson arrays preserve the target and paths containing spaces.

Mach-O inspection selects the exact expected slice before executing native
help. It rejects missing/opposite slices, unsupported architectures, deployment
targets above13.0 and non-system dynamic links. Both native host and Google's
pinned universal ADB must provide the expected slice. Inspection of arm64 does
not qualify x86_64, or the reverse. Minimum-target scans are not clean minimum-OS
or physical media/permission proof.

After staging, `npm run package:mac --prefix desktop` validates that the staged
native/ADB metadata matches the current Node architecture and verifies payload
hashes before invoking the pinned Electron builder with its matching architecture.
Signing discovery stays disabled and publication stays off. Bundle verification
refuses a foreign platform/architecture before native/ADB probes. Existing
Apple-silicon output paths remain compatible; Intel uses Electron's x64 output.

CI retains the original `native-macos` arm64 check and adds `native-macos-intel`
on the standard `macos-15-intel` runner, with fail-fast disabled. Each architecture
runs native tests, sanitizers, fresh pinned portable build, launcher checks,
unsigned app verification and hidden fake-host IPC. Artifacts and qualification
records remain separate; an Intel pass never replaces an unavailable arm64 job.
The repository is public and no larger/paid runner or account is provisioned.
See [GitHub's standard runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

Actual Intel/Apple-silicon build results must be tied to exact source and artifact
hashes. Native help/tests and hidden fake-host IPC do not prove display capture,
audio, input permissions, real install/upgrade/startup, clean macOS13, signing,
notarization or a universal device/browser matrix. Those release and physical
gates remain required. No existing app is installed, activated or interrupted by
these build commands; runtime use is a separate controlled test.

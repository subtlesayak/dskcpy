# Download and run dskcpy

The [21 November 2026 preview](https://github.com/subtlesayak/dskcpy/releases/tag/v0.1.0-preview.20261121)
contains Android, Mac and Windows packages built from the reviewed published
implementation. It is a prerelease. Mac and Windows desktop apps are unsigned;
Mac is not notarized. Hardware and clean-machine qualification remain open.
The later local Gaming, password-access, receiver web-app and Android launch
prototypes are not included. See [project status](project-status.md).

## Choose a package

| Device | File |
| --- | --- |
| Android 5.0+ | `dskcpy-android-50003.apk` |
| Mac with Apple silicon, macOS 13+ | `dskcpy-macos-arm64.zip` |
| Mac with Intel processor, macOS 13+ | `dskcpy-macos-x64.zip` |
| Windows x64, Windows 10+ | `dskcpy-windows-x64.zip` |

These are declared build targets, not proof of testing on every minimum OS.
The desktop archives include Electron, the native host, its runtime libraries,
ADB, receiver assets, and the matching signed Android companion and server.
You do not need Node.js, a compiler or Android Studio to run the desktop app.
The Mac ZIP contains an app bundle; Windows is a portable app directory.
Neither is an automated installer or an automatic update to an existing app.

## Verify the download

Use the release's `SHA256SUMS.txt` to compare your downloaded file before opening
it. Check that both the filename and the complete hash match.

On Mac:

```sh
shasum -a 256 dskcpy-macos-arm64.zip
```

On Windows PowerShell:

```powershell
Get-FileHash .\dskcpy-windows-x64.zip -Algorithm SHA256
```

A checksum verifies file integrity against the published list. It does not make
an unsigned desktop publisher verified or establish physical-device support.
`BUILDINFO.json` records source identity, component hashes and actual checks.
Third-party notices remain in the packages and accompanying release records.

## Mac

1. In **About This Mac**, check whether the computer uses Apple silicon or Intel.
   Download the matching ZIP and extract it.
2. Keep the previous app as a separate, recoverable copy. When an existing
   stream can be stopped deliberately, quit that host before replacing its app.
3. Open `dskcpy Host.app` and use the guided connection setup. macOS may block
   this unsigned, unnotarized preview; do not disable system security protections
   to run it. Managed Macs may require an approved signed build instead.
4. Allow Screen Recording for the host that actually runs capture. Desktop
   input additionally needs Accessibility. Verify the app copy and permissions
   again after any replacement; this preview does not guarantee permission
   retention across upgrades.

For a browser receiver, create a link in the host and open that receiver link on
the receiving device. Android USB browser mode needs an authorized data cable
and debugging; no Android companion APK is needed for that mode. For the native
Android app, use the matching companion from this release.
See [Mac permissions and transports](macos-host.md) and
[browser connection choices](browser-receiver.md#choose-a-connection).

## Windows

1. Extract the entire ZIP into a new folder. Keep all files in `win-unpacked`
   together, including `resources` and its runtime libraries.
2. Preserve a working older copy. Stop its stream deliberately and quit it
   before starting another host copy.
3. Open `win-unpacked/dskcpy Host.exe` and follow the guided setup. The app is
   unsigned, so Windows or organizational policy may block or warn about it.
4. Use the generated receiver invitation on the receiving device. The dashboard
   address is for the host computer; it is not the phone's receiving address.

Do not copy unrelated MSYS or other `scrcpy` DLLs into the extracted folder.
The included native runtime was checked with only its packaged and Windows
system directories available. See [Windows setup](windows-host.md).

## Android

The companion APK is for native desktop receiving. It is different from using
a phone browser, and different from upstream Android-to-computer mirroring.

1. Download `dskcpy-android-50003.apk` from this release and install it using
   Android's normal package installer. It uses the existing development signer.
2. If Android rejects an update because its signer differs, keep the installed
   app and its data. Do not uninstall it or force a downgrade to bypass that
   check. [Upgrade identity guidance](artifact-upgrades.md) explains the boundary.
3. Follow [Android USB/LAN receiving](reverse-display.md) or
   [private-network native receiving](internet-mode.md). Authorize only the
   intended debugging host and keep its debugging endpoint private.

Version code 50003 is higher than the verified archived 50001/50002 candidates;
its signer matches those verified development builds. Other locally signed
copies may use another key. An offline signature/version comparison is not an
installation or retained-data test on your phone.

## What is verified

Release records distinguish automated native/browser tests, unsigned package
checks, generated media, and physical-device results. The companion's original
payload and signature were checked; desktop archives retain their first-party,
native and notice files and include the matching Android assets. No installer,
permission or physical stream was exercised merely by preparing these files.

Long sessions, audible route changes, minimum-OS installation, Safari/iOS,
display changes, suspend/resume and the historical Android startup stall remain
qualification work. This preview is not evidence that every open issue is fixed.
Report the package/source, platform, transport and sanitized reproduction in
[dskcpy issues](https://github.com/subtlesayak/dskcpy/issues). Keep codes, addresses,
credentials, device identifiers and private desktop content out of reports.

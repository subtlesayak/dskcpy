# Windows host setup

Build this fork to send a Windows desktop to the Android app or a browser.
Use Windows 10+ in your logged-in desktop session. These are development/source
builds, not a signed desktop installer. For the original Android-to-computer
mode, see the [native build reference](build.md).

[Requirements](#requirements) · [Build](#build-the-native-host) ·
[Launch](#build-and-start-the-dashboard) · [First stream](#start-your-first-stream) ·
[Troubleshooting](../FAQ.md)

## Requirements

Install these tools before building:

- [Git](https://git-scm.com/downloads/win).
- [MSYS2](https://www.msys2.org/) with its **UCRT64** terminal.
- Node.js 22.12+ and npm, available from PowerShell.
- For the Android app receiver: [JDK 17](https://adoptium.net/temurin/releases/?version=17), Android SDK platform 36, build-tools
  36.0.0 and platform-tools. Set `JAVA_HOME` and `ANDROID_HOME` to your existing
  installations. Android Studio's [SDK Manager](https://developer.android.com/studio/intro/update#sdk-manager)
  can install the SDK components and shows the SDK location to use for `ANDROID_HOME`.
- An H.264 encoder supported by the installed FFmpeg build. Hardware encoders
  are tried where available; software fallback depends on build capabilities.

The browser receiver does not install a companion APK. Android USB browser
mode still needs ADB. Native Android app receiving needs the matching APK.

## Get the source

In PowerShell:

```powershell
git clone https://github.com/subtlesayak/dskcpy.git
cd dskcpy
```

If you already have a working checkout, preserve local changes and finish any
active stream before updating or replacing build artifacts. Use a separate
checkout/build directory to evaluate a candidate.

## Build the native host

Open **MSYS2 UCRT64**, change to this checkout, and update MSYS2 following its
[update instructions](https://www.msys2.org/docs/updating/). Reopen UCRT64 if
requested. Install the same native package family used by CI:

```sh
pacman -S --needed mingw-w64-ucrt-x86_64-gcc \
  mingw-w64-ucrt-x86_64-meson mingw-w64-ucrt-x86_64-ninja \
  mingw-w64-ucrt-x86_64-pkgconf mingw-w64-ucrt-x86_64-ffmpeg \
  mingw-w64-ucrt-x86_64-sdl3 mingw-w64-ucrt-x86_64-libusb

meson setup x-reverse --buildtype=debug -Dcompile_server=false
meson compile -C x-reverse
meson test -C x-reverse --print-errorlogs
```

Output: `x-reverse/app/scrcpy.exe`. This command builds the native host only;
it does not build an Android APK. Keep UCRT64 libraries with this build. Do not
reuse a build directory configured with MINGW64 or mix its DLLs with UCRT64.
MSYS2 [documents the runtime distinction](https://www.msys2.org/docs/environments/).

## Build the Android companion

Skip this section for browser-only receiving. In **PowerShell**, from the
checkout root, with JDK 17+ and the Android SDK configured:

```powershell
.\gradlew.bat :server:assembleDebug
New-Item -ItemType Directory -Force x-reverse\server | Out-Null
Copy-Item server\build\outputs\apk\debug\server-debug.apk x-reverse\server\reverse-display.apk
Copy-Item server\build\outputs\apk\debug\server-debug.apk x-reverse\server\scrcpy-server
```

These copies match the debug artifact layout produced by the Meson/Gradle
wrapper. The APK is debug-signed for development. Upgrade an existing Android
installation with the same signing key; resolve a mismatch without blindly
uninstalling the app and losing its settings. The host installs the companion
for ADB connections. Native Internet mode requires installing it on the phone
before starting that session.

For a combined native/server Meson build, JDK and SDK paths must also be visible
to UCRT64; use a fresh directory without `-Dcompile_server=false`. The separate
steps above make native and Android setup failures easier to identify.

## Build and start the dashboard

In **PowerShell**, from the checkout root:

```powershell
npm.cmd ci --prefix gui
npm.cmd run build --prefix gui

node gui/scripts/launch.mjs
```

The resolver reads the native binary's PE imports to choose UCRT64 or legacy
MINGW64. It discovers matching MSYS2 roots already on PATH and the default
`C:\msys64` installation. A fresh PowerShell/Explorer launch with a normal
UCRT64 install needs no runtime variable. Unknown images prefer UCRT64, then an
available legacy install; the actual `--help` probe still has to load.

For a custom installation or an unrecognized/mixed-runtime image, set
`$env:SCRCPY_RUNTIME_DIR = 'D:\your-msys2\ucrt64\bin'` in the launching terminal.
An explicit runtime directory, then `MINGW_PREFIX/bin`, remains authoritative;
invalid overrides do not silently select another installation. The child PATH
contains one selected MSYS2 runtime family. Global PATH is unchanged.

The launcher finds `x-reverse/app/scrcpy.exe` and its sibling `server` artifacts.
It opens the dashboard at <http://127.0.0.1:27183> on **this computer**. Keep the
terminal open. For later launches from the same configured terminal, you can
run `.\start-dskcpy.cmd`; Explorer double-click is suitable only when its
runtime is discoverable or its inherited environment has the custom override.

For custom locations, set `SCRCPY_GUI_BINARY`, `SCRCPY_RUNTIME_DIR`, and any
asset overrides described in the [dashboard guide](../gui/README.md).
For readiness checks without capture or service startup:

```powershell
node gui/scripts/launch.mjs --check
```

Readiness checks component loading; they do not prove a phone connection or
working desktop capture. Repeated launcher starts reuse an existing dashboard;
changed environment variables take effect only after you deliberately end its
stream and restart that service.

## Start your first stream

Choose one receiver:

- **Android app:** connect an authorized USB debugging device, choose **USB**
  in the dashboard, then **Start streaming**. Check video and a harmless tap/drag.
  Try [wireless pairing](../gui/README.md#cable-free-android-setup) after USB works.
- **Browser:** open **Browser receiver**, choose **This computer** for preview
  or **USB cable** for an authorized Android browser, then create an invitation.
  Follow the [browser guide](browser-receiver.md) for secure remote access.

Use the receiver's Stop/Disconnect or the dashboard Stop control to end sharing.
Do not run the host as a Windows service or in a noninteractive desktop session.

## If setup fails

- **Program will not load:** check `SCRCPY_RUNTIME_DIR` points to this build's
  UCRT64 `bin` directory; do not copy unrelated DLLs beside the executable.
- **ADB missing:** set `ADB` explicitly, or configure `ANDROID_HOME` with its
  `platform-tools` directory installed. `ANDROID_SDK_ROOT` is the fallback when
  `ANDROID_HOME` is unset.
- **Companion missing:** complete the Android build/copy step for app receiving.
  Browser-only mode does not require it.
- **Capture/encoder fails:** use your interactive desktop and check the first
  Activity error; try a supported encoder or a lower size/frame rate.

See the [FAQ](../FAQ.md) before reporting sanitized diagnostics to this fork.

# Native build reference

For **desktop hosting**, use [Windows host setup](windows-host.md) or
[Mac host setup](macos-host.md). Those guides build this fork and its dashboard;
Android app receiving also needs its matching installable companion.

This reference covers the inherited **Android-to-computer** client/server and
lower-level build options. It does not turn an upstream scrcpy release or
package-manager installation into a dskcpy desktop host. Linux desktop hosting
is not implemented.

## Branches

Use this fork's `master` as the current integration branch. It is source, not a
published desktop release. Base proposed changes on current master and preserve
local work. Upstream scrcpy's `dev` and release branches belong to its separate
project; do not assume this fork has the same branches or latest upstream base.

## Requirements

You need [adb]. It is available in the [Android SDK platform
tools][platform-tools], or packaged in your distribution (`adb`).

On Windows, download the [platform-tools][platform-tools-windows] and extract
the following files to a directory accessible from your `PATH`:
 - `adb.exe`
 - `AdbWinApi.dll`
 - `AdbWinUsbApi.dll`

It is also available in scrcpy releases.

The client requires [FFmpeg] and [SDL]. Just follow the instructions.

[adb]: https://developer.android.com/studio/command-line/adb.html
[platform-tools]: https://developer.android.com/studio/releases/platform-tools.html
[platform-tools-windows]: https://dl.google.com/android/repository/platform-tools-latest-windows.zip
[ffmpeg]: https://ffmpeg.org/
[SDL]: https://www.libsdl.org/



## System-specific steps

### Linux

Install the required packages from your package manager.

#### Debian/Ubuntu

```bash
# runtime dependencies
sudo apt install ffmpeg libsdl3-0 adb libusb-1.0-0

# client build dependencies
sudo apt install gcc git pkg-config meson ninja-build libsdl3-dev \
                 libavcodec-dev libavdevice-dev libavformat-dev libavutil-dev \
                 libswresample-dev libusb-1.0-0-dev libv4l-dev

# server build dependencies
sudo apt install openjdk-17-jdk
```

On old versions (like Ubuntu 16.04), `meson` is too old. In that case, install
it from `pip3`:

```bash
sudo apt install python3-pip
pip3 install meson
```


#### Fedora

```bash
# enable RPM fusion free
sudo dnf install https://download1.rpmfusion.org/free/fedora/rpmfusion-free-release-$(rpm -E %fedora).noarch.rpm

# client build dependencies
sudo dnf install SDL3-devel ffms2-devel libusb1-devel libavdevice-free-devel meson gcc make

# server build dependencies
sudo dnf install java-devel
```



### Windows

#### Cross-compile from Linux

These are inherited cross-compilation instructions for developer/release work.
They are not the recommended first setup for a Windows desktop host.

From _Debian_, install _mingw_:

```bash
sudo apt install mingw-w64 mingw-w64-tools libz-mingw-w64-dev
```

You also need the JDK to build the server:

```bash
sudo apt install openjdk-17-jdk
```

The release tooling can generate archives (separate release qualification is required):

```bash
./release/release.sh
```

The aggregate script writes archives under `release/output/`. Individual Windows
builds stage files under `release/work/build-win32/dist` or `build-win64/dist`.
Do not treat these developer outputs as qualified/signed desktop releases.


#### In MSYS2

Use **UCRT64** and one consistent runtime family. Follow the package installation,
native build and launch/runtime configuration in [Windows host setup](windows-host.md).
That guide matches the current native CI environment. Deprecated MINGW64 package
commands and 32-bit substitutions are not a supported dskcpy host setup.

For a combined native/server build, make JDK 17+ and the Android SDK available to
the terminal before running Meson. The separate native/companion steps in the
host guide avoid mixing shell-specific SDK setup with native compilation.

### macOS

Install the packages with [Homebrew]:

[Homebrew]: https://brew.sh/

```bash
# runtime dependencies
brew install sdl3 ffmpeg libusb

# client build dependencies
brew install pkgconf meson ninja
```

For the Android build, install/configure JDK 17 and the Android SDK components
listed below. For Homebrew OpenJDK, select its JDK directly:

```bash
brew install openjdk@17
export JAVA_HOME="$(brew --prefix openjdk@17)/libexec/openjdk.jdk/Contents/Home"
export PATH="$JAVA_HOME/bin:$PATH"
```

### Docker

See [pierlon/scrcpy-docker](https://github.com/pierlon/scrcpy-docker).


## Common steps

**As a non-root user**, clone the project:

```bash
git clone https://github.com/subtlesayak/dskcpy.git
cd dskcpy
```


### Build

For native-only work, `-Dcompile_server=false` skips Android output generation.
For inherited Android-to-computer use, a version-matched [prebuilt server] can
avoid a local Android build. It does **not** provide the installable dskcpy
companion or its reverse-mode UI. Prefer building all related artifacts from
this fork's matching source.

[prebuilt server]: #option-2-use-prebuilt-server


#### Option 1: Build everything from sources

Install JDK 17+ and the [Android SDK] with platform 36 and build-tools 36.0.0.
Set `ANDROID_HOME` to the SDK directory (`ANDROID_SDK_ROOT` is a fallback when
`ANDROID_HOME` is unset). Examples:

[Android SDK]: https://developer.android.com/studio/index.html

```sh
# Linux
export ANDROID_HOME=~/Android/Sdk
# Mac
export ANDROID_HOME=~/Library/Android/sdk
```

```powershell
# Windows PowerShell
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
```

Then, build:

```bash
meson setup x --buildtype=release --strip -Db_lto=true
ninja -Cx  # DO NOT RUN AS ROOT
```

_Note: `ninja` [must][ninja-user] be run as a non-root user (only `ninja
install` must be run as root)._

[ninja-user]: https://github.com/Genymobile/scrcpy/commit/4c49b27e9f6be02b8e63b508b60535426bd0291a


#### Option 2: Use prebuilt server

 - [`scrcpy-server-v4.1`][direct-scrcpy-server]  
   <sub>SHA-256: `deacb991ed2509715160ffdc7907e47b4160eb30d1566217e9047fd5b8850cae`</sub>

[direct-scrcpy-server]: https://github.com/Genymobile/scrcpy/releases/download/v4.1/scrcpy-server-v4.1

Download the prebuilt server somewhere, and specify its path during the Meson
configuration:

```bash
meson setup x --buildtype=release --strip -Db_lto=true \
    -Dprebuilt_server=/path/to/scrcpy-server
ninja -Cx  # DO NOT RUN AS ROOT
```

The pinned upstream 4.1 server is for a compatible inherited Android-to-computer
client only. It is not the dskcpy companion, and version identity alone does not
qualify custom protocol changes. Build the fork's server when using fork-specific
behavior; never replace an installed companion with an unrelated APK.


### Run without installing:

```bash
./run x [options]
```


### Install

After a successful build, you can install _scrcpy_ on the system:

```bash
sudo ninja -Cx install    # without sudo on Windows
```

This installs several files:

 - `/usr/local/bin/scrcpy` (main app)
 - `/usr/local/share/scrcpy/scrcpy-server` (server to push to the device)
 - `/usr/local/share/man/man1/scrcpy.1` (manpage)
 - `/usr/local/share/icons/hicolor/256x256/apps/scrcpy.png` (app icon)
 - `/usr/local/share/icons/hicolor/256x256/apps/disconnected.png` (device
   disconnected icon)
 - `/usr/local/share/zsh/site-functions/_scrcpy` (zsh completion)
 - `/usr/local/share/bash-completion/completions/scrcpy` (bash completion)
 - `/usr/local/share/applications/scrcpy.desktop` (app-without-console desktop
   entry file)
 - `/usr/local/share/applications/scrcpy-console.desktop` (app-with-console
   desktop entry file)

You can then run `scrcpy`.


### Uninstall

```bash
sudo ninja -Cx uninstall  # without sudo on Windows
```

# On Linux

> [!NOTE]
> This retained page describes upstream-style **Android-to-computer** use.
> Linux desktop hosting is not implemented.
> Upstream releases and package-manager installs do not include dskcpy hosting.
> Versioned 4.1 download links below are historical pins, not current-release claims;
> use [upstream releases](https://github.com/Genymobile/scrcpy/releases/latest)
> if you want current upstream scrcpy.

## Install

### Historical upstream 4.1 release

The retained upstream 4.1 static builds are:

 - [`scrcpy-linux-x86_64-v4.1.tar.gz`][direct-linux-x86_64] (x86_64)  
   <sub>SHA-256: `ad56ae8bfeedf41e824945c11dbf55fcb092b3e615b9b486f48a50e30d389635`</sub>

[latest release]: https://github.com/Genymobile/scrcpy/releases/latest
[direct-linux-x86_64]: https://github.com/Genymobile/scrcpy/releases/download/v4.1/scrcpy-linux-x86_64-v4.1.tar.gz

and extract it.


### From your package manager

<a href="https://repology.org/project/scrcpy/versions"><img src="https://repology.org/badge/vertical-allrepos/scrcpy.svg" alt="Packaging status" align="right"></a>

Scrcpy is packaged in several distributions and package managers:

 - Debian/Ubuntu: ~~`apt install scrcpy`~~ _(obsolete version)_
 - Arch Linux: `pacman -S scrcpy`
 - Fedora: `dnf copr enable zeno/scrcpy && dnf install scrcpy`
 - Gentoo: `emerge scrcpy`
 - Snap: ~~`snap install scrcpy`~~ _(obsolete version)_
 - … (see [repology](https://repology.org/project/scrcpy/versions))


### From an install script

This section installs upstream scrcpy from the upstream repository for
Android-to-computer use. It does not install dskcpy or its companion.
The fork's retained `install_release.sh` pins an older upstream server; do not
use it as a dskcpy host installer.

First, you need to install the required packages:

```bash
# for Debian/Ubuntu
sudo apt install ffmpeg libsdl3-0 libusb-1.0-0 adb wget \
                 gcc git pkg-config meson ninja-build libsdl3-dev \
                 libavcodec-dev libavdevice-dev libavformat-dev libavutil-dev \
                 libswresample-dev libusb-1.0-0-dev libv4l-dev
```

Then clone the repo and execute the installation script
([upstream script](https://github.com/Genymobile/scrcpy/blob/master/install_release.sh)):

```bash
git clone https://github.com/Genymobile/scrcpy
cd scrcpy
./install_release.sh
```

When a new release is out, update the repo and reinstall:

```bash
git pull
./install_release.sh
```

To uninstall:

```bash
sudo ninja -Cbuild-auto uninstall
```

_Note that this simplified process only works for released versions (it
downloads a prebuilt server binary), so for example you can't use it for testing
the development branch (`dev`)._

_See [build.md](build.md) to build and install the app manually._


## Run

_Make sure that your device meets the [prerequisites](https://github.com/Genymobile/scrcpy#prerequisites)._

Once installed, run from a terminal:

```bash
scrcpy
```

or with arguments (here to disable audio and record to `file.mkv`):

```bash
scrcpy --no-audio --record=file.mkv
```

Documentation for command line arguments is available:
 - `man scrcpy`
 - `scrcpy --help`
 - on [github](https://github.com/Genymobile/scrcpy)

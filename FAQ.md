# Frequently asked questions

This first section covers **dskcpy desktop hosting**. The
[inherited Android-to-computer FAQ](#inherited-android-to-computer-faq) follows
below. Start with [Windows setup](doc/windows-host.md), [Mac setup](doc/macos-host.md)
or [browser receiving](doc/browser-receiver.md) for the receiver you intend to use.

## Which program should I install?

dskcpy currently requires a source build. Upstream scrcpy downloads and
`brew install scrcpy` do not include this fork's desktop-hosting features.
The native binary is still named `scrcpy`, so confirm the dashboard selects
your build of this fork. Build the native host, dashboard and companion from
matching source. The browser receiver does not install a companion APK.

## Why does the dashboard address fail on my phone?

The dashboard at `http://127.0.0.1:27183` controls the host **on that computer**.
In **Browser receiver**, create an invitation and open its generated receiver
address on the phone. Android USB mode uses an ADB reverse tunnel; remote modes
need trusted HTTPS and private network reachability. See the
[browser connection guide](doc/browser-receiver.md#choose-a-connection).

## What do I check when a stream will not start?

| Symptom | Next step |
| --- | --- |
| Streaming program missing | Build this fork and select its native executable; see the platform setup guide. |
| Windows runtime libraries fail to load | Set `SCRCPY_RUNTIME_DIR` to the UCRT64 `bin` used to build it. Do not mix runtime families. |
| Android device absent or unauthorized | Enable debugging, use a data cable, unlock the phone and approve its prompt. Check `adb devices -l`. |
| Companion APK missing | Build/copy the matching APK for the Android app receiver. Browser-only receiving needs no APK. |
| Android update rejected | Check signing compatibility. Preserve the installed app and its data while resolving a key mismatch. |
| Mac video denied or blank | Check Screen Recording for the launching process; end the session and restart that app if macOS requires it. |
| Mac video works but input does not | Enable Accessibility for that host/launcher. Selected-window mode is intentionally view-only. |
| QR returns to code entry | Check the host's Activity error. Correct capture/connection issues, then create a fresh invitation. |
| Receiver cannot reach a secure link | Check certificate trust, private peer access, HTTPS routing and private media reachability. Do not bypass certificate validation. |

## Are native Internet secrets and browser codes interchangeable?

No. In [native Android Internet mode](doc/internet-mode.md), the phone app
creates a temporary secret and the desktop connects to the reachable phone.
For [browser receiving](doc/browser-receiver.md), the computer creates the
invitation and the receiving browser connects to the computer. VPN reachability
must permit the appropriate direction. Sharing one peer does not automatically
establish the opposite direction.

## Why is Mac or browser audio silent or choppy?

Enable playback on the receiving device and check its media volume. Browsers
may require a tap to allow audio. Mac window mode has audio off; full-desktop
capture needs Screen & System Audio Recording permission. Use a quiet,
non-protected clip and compare each transport separately.

Mac sustained audio stutter remains under investigation. An encoder log,
transport ACK or successful retry does not close it. Source fixes and automated
results are recorded in [Mac testing](doc/testing/mac/README.md); audible
candidate testing remains separate. Receiver mute does not mute the computer.

## Why is the Mac keyboard button missing?

It requires a native host advertising browser keyboard support, a full-desktop
Mac session, and a separate receiver. **This computer** preview and selected
window mode omit forwarding. Windows browser typing is not implemented.
Rebuild the host and dashboard from the same revision. The
[typing guide](doc/browser-receiver.md#mac-window-sharing-and-desktop-keyboard)
explains focus, permissions, IME and reserved-shortcut limits.

## Does leaving the app end the session?

Leaving and stopping are different. Android 6+ can retain a session across
background/return. Browser sessions can resume across a bounded absence or
reload, currently up to two minutes. Explicit Stop/Disconnect ends sharing;
Internet or browser reconnection then needs a fresh secret/invitation.
Process death and network loss are not guaranteed seamless recovery.

## Is the displayed latency physical touch-to-display latency?

No. Native decode-ACK RTT and WebRTC send completion measure different software
boundaries. They do not measure physical touch, display scan-out or glass-to-glass
latency. See [measurement limits](doc/browser-receiver.md#latency-and-validation-boundaries).

## How do I update or report a failure safely?

Finish the active session before replacing its native binary or restarting its
service. Preserve local changes and working artifacts. An existing service keeps
its startup environment; a second launcher or browser refresh does not reconfigure it.

Report the host OS, receiver type, source revision, connection mode, reproduction
steps and first useful Activity/build error to
[this fork](https://github.com/subtlesayak/dskcpy/issues). Remove secrets, device
identifiers, network addresses, personal paths and private desktop content.

## Inherited Android-to-computer FAQ

The following retained guidance is for the original scrcpy direction:
**Android screen → computer**. Commands, upstream issue links and Android input
permissions in this section do not describe dskcpy desktop hosting. Browser
and native Internet receiving can operate without desktop ADB where documented.

[Read in another language](#translations)

Here are the common reported problems and their status.

If you encounter any error, the first step is to upgrade to the latest version.


## `adb` and USB issues

`scrcpy` execute `adb` commands to initialize the connection with the device. If
`adb` fails, then scrcpy will not work.

This is typically not a bug in _scrcpy_, but a problem in your environment.


### `adb` not found

You need `adb` accessible from your `PATH`.

On Windows, the current directory is in your `PATH`, and `adb.exe` is included
in the release, so it should work out-of-the-box.


### Device not detected

>     ERROR: Could not find any ADB device

Check that you correctly enabled [adb debugging][enable-adb].

Your device must be detected by `adb`:

```
adb devices
```

If your device is not detected, you may need some [drivers] (on Windows). There is a separate [USB driver for Google devices][google-usb-driver].

[enable-adb]: https://developer.android.com/studio/command-line/adb.html#Enabling
[drivers]: https://developer.android.com/studio/run/oem-usb.html
[google-usb-driver]: https://developer.android.com/studio/run/win-usb


### Device unauthorized

>     ERROR: Device is unauthorized:
>     ERROR:     -->   (usb)  0123456789abcdef          unauthorized
>     ERROR: A popup should open on the device to request authorization.

When connecting, a popup should open on the device. You must authorize USB
debugging.

If it does not open, check [stackoverflow][device-unauthorized].

[device-unauthorized]: https://stackoverflow.com/questions/23081263/adb-android-device-unauthorized


### Several devices connected

If several devices are connected, you will encounter this error:

>     ERROR: Multiple (2) ADB devices:
>     ERROR:     -->   (usb)  0123456789abcdef                device  Nexus_5
>     ERROR:     --> (tcpip)  192.168.1.5:5555                device  GM1913
>     ERROR: Select a device via -s (--serial), -d (--select-usb) or -e (--select-tcpip)

In that case, you can either provide the identifier of the device you want to
mirror:

```bash
scrcpy -s 0123456789abcdef
```

Or request the single USB (or TCP/IP) device:

```bash
scrcpy -d  # USB device
scrcpy -e  # TCP/IP device
```

Note that if your device is connected over TCP/IP, you might get this message:

>     adb: error: more than one device/emulator
>     ERROR: "adb reverse" returned with value 1
>     WARN: 'adb reverse' failed, fallback to 'adb forward'

This is expected (due to a bug on old Android versions, see [#5]), but in that
case, scrcpy fallbacks to a different method, which should work.

[#5]: https://github.com/Genymobile/scrcpy/issues/5


### Conflicts between adb versions

>     adb server version (41) doesn't match this client (39); killing...

This error occurs when you use several `adb` versions simultaneously. You must
find the program using a different `adb` version, and use the same `adb` version
everywhere.

You could overwrite the `adb` binary in the other program, or ask _scrcpy_ to
use a specific `adb` binary, by setting the `ADB` environment variable:

```bash
# in bash
export ADB=/path/to/your/adb
scrcpy
```

```cmd
:: in cmd
set ADB=C:\path\to\your\adb.exe
scrcpy
```

```powershell
# in PowerShell
$env:ADB = 'C:\path\to\your\adb.exe'
scrcpy
```


### Device disconnected

If _scrcpy_ stops itself with the warning "Device disconnected", then the
`adb` connection has been closed.

Try with another USB cable or plug it into another USB port. See [#281] and
[#283].

[#281]: https://github.com/Genymobile/scrcpy/issues/281
[#283]: https://github.com/Genymobile/scrcpy/issues/283


## OTG issues on Windows

On Windows, if `scrcpy --otg` (or `--keyboard=aoa`/`--mouse=aoa`) results in:

>     ERROR: Could not find any USB device

(or if only unrelated USB devices are detected), there might be drivers issues.

Please read [#3654], in particular [this comment][#3654-comment1], [the next
one][#3654-comment2] and [this one][#3654-comment3].

[#3654]: https://github.com/Genymobile/scrcpy/issues/3654
[#3654-comment1]: https://github.com/Genymobile/scrcpy/issues/3654#issuecomment-1369278232
[#3654-comment2]: https://github.com/Genymobile/scrcpy/issues/3654#issuecomment-1369295011
[#3654-comment3]: https://github.com/Genymobile/scrcpy/issues/3654#issuecomment-2613219725


## Control issues

### Mouse and keyboard do not work

On some devices, you may need to enable an option to allow [simulating input].
In developer options, enable:

> **USB debugging (Security settings)**  
> _Allow granting permissions and simulating input via USB debugging_

Rebooting the device is necessary once this option is set.

[simulating input]: https://github.com/Genymobile/scrcpy/issues/70#issuecomment-373286323


### Special characters do not work

The default text injection method is limited to ASCII characters. A trick allows
to also inject some [accented characters][accented-characters],
but that's all. See [#37].

To avoid the problem, [change the keyboard mode to simulate a physical
keyboard][hid].

[accented-characters]: https://blog.rom1v.com/2018/03/introducing-scrcpy/#handle-accented-characters
[#37]: https://github.com/Genymobile/scrcpy/issues/37
[hid]: doc/keyboard.md#physical-keyboard-simulation


## Client issues

### Issue with Wayland

By default, SDL uses x11 on Linux. The [video driver] can be changed via the
`SDL_VIDEODRIVER` environment variable:

[video driver]: https://wiki.libsdl.org/FAQUsingSDL#how_do_i_choose_a_specific_video_driver

```bash
export SDL_VIDEODRIVER=wayland
scrcpy
```

On some distributions (at least Fedora), the package `libdecor` must be
installed manually.

See issues [#2554] and [#2559].

[#2554]: https://github.com/Genymobile/scrcpy/issues/2554
[#2559]: https://github.com/Genymobile/scrcpy/issues/2559


### KWin compositor crashes

On Plasma Desktop, compositor is disabled while _scrcpy_ is running.

As a workaround, [disable "Block compositing"][kwin].

[kwin]: https://github.com/Genymobile/scrcpy/issues/114#issuecomment-378778613


## Crashes

### Exception

If you get any exception related to `MediaCodec`:

```
ERROR: Exception on thread Thread[main,5,main]
java.lang.IllegalStateException
        at android.media.MediaCodec.native_dequeueOutputBuffer(Native Method)
```

then try with another [encoder](doc/video.md#encoder).


## Translations

Translations of this FAQ in other languages are available in the [wiki].

[wiki]: https://github.com/Genymobile/scrcpy/wiki

Only this FAQ file is guaranteed to be up-to-date.

# Platform support and physical testing

Updated 25 November 2026. Start with the [Mac host guide](macos-host.md),
[Windows host guide](windows-host.md) or [browser receiver guide](browser-receiver.md).
USB and LAN need no dskcpy account. Network browser sessions use trusted HTTPS
and a private route to the host.

## Identify the build

| Build | Evidence |
| --- | --- |
| [21 November preview](downloads.md), source `ed8d33ef`, Android `50003` | Eight hosted jobs passed. The Mac and Windows apps are unsigned. Mac is unnotarized. |
| Merged source `23aed2ea`, followed by documentation-only `9ccd8277` | [Hosted checks](https://github.com/subtlesayak/dskcpy/actions/runs/45610162388) record Windows native and packaging, Android builds, and Intel Mac native, sanitizer and package results. A separately built Apple silicon package passed local integrity and hidden Electron checks. |
| Local Apple silicon candidate `2458525e` | Includes the controller, pairing, launcher, recovery test and Mac permission changes under review. Both UI builds, 568 Node tests and Chromium/WebKit pairing and controller fixtures passed. Operation on hardware is pending. |

Check the [project status](project-status.md) for exact source and verification
details. Each physical result below applies to its recorded build and device.

## Host platforms

| Host | Recorded evidence | Remaining checks |
| --- | --- | --- |
| Apple silicon Mac | Earlier local builds exercised actual screen and control grants, video, audio and input. The current local package passed hidden Electron IPC with a fake host. | Normal launch and relaunch, permission recovery, clean-machine installation, and final-candidate media and input. |
| Intel Mac | The hosted package and smoke test passed on `23aed2ea`. | Physical screen capture, audio, input and minimum-OS installation. |
| Windows x64 | Hosted native and package checks passed on `23aed2ea`. Earlier hardware checks exercised Android USB and private VPN, and localhost browser capture with NVENC. | Physical browser and Android routes, encoder changes and install or upgrade on the exact candidate. |
| Linux | The inherited scrcpy mode can view and control an Android device. A Linux browser can receive from a supported host. | Linux desktop hosting is on the [roadmap](roadmap.md). |

## Receiver routes

| Receiver and route | Recorded evidence | Remaining checks |
| --- | --- | --- |
| Android browser over USB | An earlier Mac build (`4ec8e7fc` with receiver `1d303ab5`) passed touch, typing, five minutes of audible playback, mute, and Home/return. | Repeat on the exact candidate with Chrome or Edge, a data cable and authorized debugging. |
| Android companion over USB or wireless ADB | Historical physical tests exercised streaming on Mac and Windows. A disposable Android 16 emulator accepted a same-key update from 50001 to 50002, retained a seeded preference and completed three cold display-socket handshakes. | Reproduce the physical startup stall and test each route separately. A future upgrade from the 50003 preview requires a higher version code and compatible signing. See [upgrade checks](artifact-upgrades.md). |
| Browser over local Wi-Fi or Ethernet | Trusted-HTTPS LAN pairing and network setup without ADB are in current source. | Test direct LAN media, input and network recovery. A private VPN connection over Wi-Fi is a separate route. |
| Android Edge over a private VPN | Earlier Mac tests exercised video and touch across networks on mobile data. A later approved paired join on phone Wi-Fi resumed after Home/return. | Repeat each transport with audio, input, route loss and same-session recovery on the exact candidate. |
| Desktop browser and installable web receiver | Chromium and WebKit fixtures passed verified address changes, fresh host approval and same-session recovery. Current source opens the saved computer list offline. Live streams require a reachable host. | Verify physical installation, browser media and OS keyboard behavior across devices. |
| Safari on iPhone and iPad | WebKit engine fixtures passed. | Verify Safari, audio gestures, typing, Home/return and installation on both devices. The USB browser tunnel is Android-only. |
| External display with phone controller | Generated browser scenarios passed separate presentation, controller rotation and held-input release. | Verify real playback, background recovery and display privacy. Test a separate presentation browser and hardware casting independently. |
| Gaming | Generated checks exercise relative mouse and held-input cleanup. | Measure physical input-to-display median and p95 on the same workload, starting locally and over USB or wired LAN. |

## Record a hardware result

Use a disposable test window and record the host source, package hash, OS and
architecture, receiver OS and app or browser version, and transport. Start by
checking launch, permissions and one consented stream. Check video, touch or
mouse, drag, two-finger scroll, keyboard and held-input release. Then record
audible playback duration, mute, output-device changes and the recovery events
actually exercised. For Android upgrade tests, record whether the app data and
settings survive the update.

Use the [physical regression procedures](reverse-display-validation.md#physical-device-checks--manual-not-covered-by-unit-tests)
and [Mac hardware history](testing/mac/README.md). Mark unavailable hardware
as pending. Keep invitations, credentials, network identifiers and private
desktop content out of the results.

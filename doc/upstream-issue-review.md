# Upstream issue review

Reviewed 2026-09-05 against scrcpy 4.1. This is a focused review of recent
open reports, not a review of every upstream issue. No upstream issues were
closed or reported as fixed on affected devices.

| Upstream issue | dskcpy assessment |
| --- | --- |
| [#7009: VP8/VP9 documentation](https://github.com/Genymobile/scrcpy/issues/7009) | Fixed in `video.md`: both supported codecs and command examples are documented. Reverse display still uses H.264. |
| [#6992: stalled-client DMA-BUF growth](https://github.com/Genymobile/scrcpy/issues/6992) | Defensive mitigation: Android 10+ video sockets have a two-second blocking-write timeout and encoding does not retry a timed-out transport. Unsupported socket options produce a diagnostic. This does not prove bounded vendor codec memory or fix firmware. Reproduction on the affected Rockchip device remains required. |
| [#6977: capture continues after Wi-Fi loss](https://github.com/Genymobile/scrcpy/issues/6977) | The video write timeout helps when output stops progressing. It is not a universal liveness detector: ADB buffering and idle streams can delay detection. Test wireless camera loss on a phone before claiming resolution. |
| [#6983: UHID Right Shift](https://github.com/Genymobile/scrcpy/issues/6983) | Existing HID mapping assigns right Shift to bit 0x20 and retains its SDL scancode. No confirmed mapping defect. Capture SDL events on an affected Windows keyboard before modifying handling. |
| [#7010: compile-only framework stubs](https://github.com/Genymobile/scrcpy/issues/7010) | A compatibility refactor, not a confirmed user-facing bug. Defer until historical Android signatures and vendor behavior can be tested. |
| [#6991: Android 17 Pixel system crashes](https://github.com/Genymobile/scrcpy/issues/6991) | Device system-service failure; no verified application-side fix. Requires affected hardware and OS diagnostics. |
| [#7021: last frame remains after screen lock](https://github.com/Genymobile/scrcpy/issues/7021) | Needs reproduction and a reliable screen-state signal. Idle video alone cannot distinguish a static desktop from a locked device. |

The scrcpy `dev` const-correctness patch
[`b64b5339`](https://github.com/Genymobile/scrcpy/commit/b64b5339eae8e94646a2759006dacf46d4950425)
is also incorporated in the ADB selector, shortcut parser, and string utility.

## Release integration

Windows release scripts retain the scrcpy 4.1 source pins: SDL 3.4.12,
FFmpeg 8.1.2 and libusb 1.0.30. Downloads are checksum-verified by the dependency
builders; release linking uses an isolated pkg-config directory. Archives now
record source versions/checksums and linked library versions in `dependencies.txt`.
The Windows FFmpeg build must include `h264_mf`; a stale decoder-only cache
fails with a reconfiguration message.

Rolling MSYS2 builds are compatibility/development builds and can use newer
libraries. They are not evidence that the pinned release build has passed.
The full cross-compilation release workflow still needs to run before publishing.

Windows archives include the signed debug companion `reverse-display.apk`.
The portable client discovers it beside the executable; an explicit
`SCRCPY_REVERSE_DISPLAY_APK` still overrides discovery. Debug signing supports
development installs; stable release signing and upgrade-key management remain
release work. The manual no-Gradle build produces the standalone server only;
use Gradle for the installable companion and its assets.

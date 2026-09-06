# Remaining dskcpy work

This checklist records remaining implementation and verification work. It is
not a claim that untested platforms are supported. macOS hosting stays ahead of
browser/iPhone receiving, following the selected product priority.

## 1. Mac hosting completion — active

- [x] ScreenCaptureKit video, VideoToolbox H.264, mouse/scroll and window controls.
- [x] Fix worker-name startup assertion and piped-log telemetry buffering.
- [x] Implement experimental system audio using ScreenCaptureKit and Opus.
- [x] Add an opt-in native Mac CI compile and pipe-telemetry regression.
- [ ] Verify the latest telemetry, audible audio, mute and Home/return on a Mac.
- [ ] Validate USB, direct-IP and Internet independently on physical Mac hardware.
- [ ] Validate display hot-plug/resolution changes and permission recovery.

## 2. Latency and reliability

- [x] Separate Android packet reading from decoder output draining.
- [x] Bound video/audio queues, detect transport stalls, and release input on exit.
- [x] Add explicit wireless discovery and bounded opt-in USB/LAN reconnection.
- [ ] Controlled USB/Wi-Fi/VPN before/after measurements with a repeatable workload.
- [ ] Physical motion-to-photon measurement; the dashboard ACK metric is not this.
- [ ] Long-running stream, network-loss, suspend and output-device-change tests.

## 3. Browser and iPhone/iPad receiving

- [ ] Choose and implement a secure browser media transport and native host adapter.
- [ ] Implement browser decoding/rendering and authenticated input return.
- [ ] Test Safari/iOS codec, gesture, audio and background restrictions.
- [ ] Define any native iOS receiver only after browser receiver constraints are tested.

The existing web dashboard is a localhost controller, not a media receiver.
No public listener, relay deployment or new account permission is implied.

## 4. Distribution and advanced input

- [ ] Reproducible desktop release builds, stable Android signing and upgrade tests.
- [ ] macOS app packaging, signing/notarization and permission identity.
- [ ] Optional desktop wrapper and control profiles.
- [ ] Extended virtual monitor and stylus pressure/Windows Ink: separate substantial
  driver/input projects, not capabilities supplied by a scrcpy fork alone.

See [validation notes](reverse-display-validation.md) for the distinction between
automated fixtures, build checks and physical-device testing.

# Remaining dskcpy work

This checklist records remaining implementation and verification work. It is
not a claim that untested platforms are supported. Physical Mac verification is
paused while the Mac is unavailable; the browser receiver is the current slice.

## 1. Mac hosting completion — hardware verification pending

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

- [x] Implement a separate authenticated WebSocket receiver and native SRD1 bridge.
- [x] Implement WebCodecs video/audio, input return, bounded queues and pause/resume.
- [x] Add USB reverse-tunnel, Wi-Fi/direct-IP HTTPS and private VPN connection setup.
- [x] Verify real Windows NVENC video and browser audio lifecycle on localhost.
- [ ] Verify physical USB Android-browser and Wi-Fi/direct-IP/VPN end-to-end paths.
- [ ] Test Safari/iOS codec, gesture, audio and background restrictions.
- [ ] Define any native iOS receiver only after browser receiver constraints are tested.

The dashboard remains a localhost controller. The separate experimental
[browser receiver](browser-receiver.md) serves only media-receiver assets and
authenticated streaming. Remote TLS listeners require explicit configuration;
no public listener, relay deployment or new account permission is implied.

## 4. Distribution and advanced input

- [ ] Reproducible desktop release builds, stable Android signing and upgrade tests.
- [ ] macOS app packaging, signing/notarization and permission identity.
- [ ] Optional desktop wrapper and control profiles.
- [ ] Extended virtual monitor and stylus pressure/Windows Ink: separate substantial
  driver/input projects, not capabilities supplied by a scrcpy fork alone.

See [validation notes](reverse-display-validation.md) for the distinction between
automated fixtures, build checks and physical-device testing.

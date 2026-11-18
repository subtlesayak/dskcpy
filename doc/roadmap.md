# Remaining dskcpy work

This checklist records remaining implementation and verification work. It is
not a claim that untested platforms are supported. Mac/browser source work and
automated verification continue; current-candidate physical checks remain
separate gates. These are not signed desktop releases.

## 1. Mac hosting completion — hardware verification pending

- [x] ScreenCaptureKit video, VideoToolbox H.264, mouse/scroll and window controls.
- [x] Fix worker-name startup assertion and piped-log telemetry buffering.
- [x] Implement experimental system audio using ScreenCaptureKit and Opus.
- [x] Implement selected Mac window capture with a fixed canvas, owner
  revalidation and native-enforced view-only input. Audio starts off; an explicit
  owner opt-in can share the selected application's audio.
- [x] Implement bounded mono/stereo PCM conversion and default-output-route
  audio epoch recovery, preserving mute and video state.
- [x] Add native Mac CI compilation, sanitizer gates and pipe-telemetry regressions.
- [ ] Verify the latest telemetry, audible audio, mute and Home/return on a Mac.
- [ ] Validate USB, direct-IP and Internet independently on physical Mac hardware.
- [ ] Validate display hot-plug/resolution changes and permission recovery.
- [ ] Physically qualify window resize/occlusion/minimize/close and audible
  output-route recovery on the final candidate.

## 2. Latency and reliability

- [x] Separate Android packet reading from decoder output draining.
- [x] Bound video/audio queues, detect transport stalls, and release input on exit.
- [x] Add explicit wireless discovery and bounded opt-in USB/LAN reconnection.
- [x] Retain bounded partial Android PCM writes and unaccepted codec input;
  clear stale audio epochs and preserve cumulative acknowledgement ordering.
- [ ] Controlled USB/Wi-Fi/VPN before/after measurements with a repeatable workload.
- [ ] Physical motion-to-photon measurement; the dashboard ACK metric is not this.
- [ ] Long-running stream, network-loss, suspend and output-device-change tests.
- [ ] Gaming mode with a repeatable workload and physical input-to-display
  latency measurements; report transport, method, sample count, median and p95.

## 3. Browser and iPhone/iPad receiving

- [x] Implement a separate authenticated WebSocket receiver and native SRD1 bridge.
- [x] Implement WebCodecs video/audio, input return, bounded queues and pause/resume.
- [x] Add private H.264/Opus WebRTC and locally generated one-use QR invitations.
- [x] Add capability-gated Mac and Windows desktop keyboard/Unicode/IME input with paired
  key release, focus/lifecycle cleanup and authenticated input validation.
- [ ] Verify physical keyboard layouts, mobile soft keyboards and IMEs on
  matching Mac and Windows hosts.
- [x] Add USB reverse-tunnel, Wi-Fi/direct-IP HTTPS and private VPN connection setup.
- [x] Verify real Windows NVENC video and browser audio lifecycle on localhost.
- [x] Retain authenticated browser sessions across bounded background/reload gaps;
  force an immediate native keyframe when decoding resumes.
- [x] Add compact Volume/Window trays, non-overlapping show-controls placement,
  fullscreen landscape requests and explicit swipe scrolling.
- [x] Add fractional touch scrolling, adjustable speed and explicit receiver/Host
  Stop confirmation; cancellation preserves the active session.
- [x] Add default-off presentation/controller roles and negotiated secondary click,
  with independent media/input authority and bounded status-only recovery.
- [x] Bound remembered active capture by the original approval deadline; verify
  real HTTPS cookies and expiry in disposable Chromium/WebKit contexts.
- [x] Add paired-computer navigation, verified identity/address checks and owner
  approval of every new stream. Reload/cancellation remains bound to the same
  pending request; stale cancellation cannot stop an established stream.
- [ ] Qualify paired-computer, cancellation and address-change flows on physical
  browsers and each supported private transport.
- [ ] Qualify real presentation/casting, secondary click and phone background/audio
  behavior independently of generated browser fixtures.
- [ ] Verify physical USB Android-browser and Wi-Fi/direct-IP/VPN end-to-end paths.
- [ ] Test Safari/iOS codec, gesture, audio and background restrictions.
- [ ] Define any native iOS receiver only after browser receiver constraints are tested.

The dashboard remains a localhost controller. The separate experimental
[browser receiver](browser-receiver.md) serves only media-receiver assets and
authenticated streaming. Remote TLS listeners require explicit configuration;
no public listener, relay deployment or new account permission is implied.

## 4. Distribution and advanced input

- [x] Windows source-checkout launcher with component checks, ADB SDK discovery,
  safe existing-dashboard reuse and a diagnostic-only mode.
- [ ] Reproducible desktop release builds, stable Android signing and upgrade tests.
- [x] Add an optional guided Electron host prototype and unsigned Mac/Windows
  directory packaging with payload and isolated fake-IPC checks.
- [ ] Finish development-installer packaging and native-OS acceptance checks.
- [ ] Stable macOS signing/notarization, distributed version policy, clean install,
  upgrades and permission identity/retention.
- [ ] Additional control profiles.
- [ ] Extended virtual monitor and stylus pressure/Windows Ink: separate substantial
  driver/input projects, not capabilities supplied by a scrcpy fork alone.

See [validation notes](reverse-display-validation.md) for the distinction between
automated fixtures, build checks and physical-device testing.

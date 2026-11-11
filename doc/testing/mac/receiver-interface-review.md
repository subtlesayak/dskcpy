# Browser receiver interface review — 11 November 2026

## Scope and coverage

Inspected the receiver's connect → stream → right-side controls → typing flow, plus the USB “Open on phone” step. The receiver uses plain HTML, CSS and JavaScript; the existing React host panel and system-font/color conventions are retained. Repository convention sources were `gui/README.md` and `doc/browser-receiver.md`; no additional project style guide was found. Native Android UI, the rest of the dashboard and platform system dialogs are outside this interface review.

| Domain | Evidence inspected | Result |
| --- | --- | --- |
| Accessibility | Receiver labels, native disclosures, focus-visible styling, Close/Escape focus restoration; keyboard lifecycle unit tests and actual typing-panel focus | Clear in inspected states; VoiceOver walk not verified |
| Layout | `receiver.css`, stage/control panels and hidden-controls gutter; rendered 320×640 and 844×390 layouts | Physical findings repaired in source; rendered RTL/200% text-size checks pass; real-phone repeat and browser zoom pending |
| Writing | Connect, USB auto-open, keyboard, Options and permission-recovery messages | Clear in inspected flow |
| Typography | System font, wrapping, button line-height and computed 16px typing field | Clear in inspected states; translated expansion not verified |
| Colors | Computed text, input boundaries and focus-ring contrast | Clear in measured combinations |
| UI polish | Right rail, disclosure states, button targets, hover-capability and reduced-motion rules; actual focus and fullscreen/hidden controls | Compact field no longer resizes manually; rendered icon state/name and target checks pass |

## Findings

Physical phone screenshots supplied after the initial synthetic review reveal the following remaining findings. The earlier synthetic-only approval is superseded. These findings are repaired in source and rendered preview; physical requalification remains open.

| Severity | Domain | Location | Before | After | Why |
| --- | --- | --- | --- | --- | --- |
| HIGH | Layout | `gui/receiver/receiver.css`, `#stream-panel:fullscreen` | Fullscreen height is 100%; only the outer main uses the visual viewport height | Implemented an inner viewport with visible height/offset; actual fullscreen synthetic check passes; phone repeat pending | The landscape soft keyboard covers the lower desktop/control area |
| MEDIUM | Layout | Receiver typing panel and right rail, portrait and landscape | Large panel, help text and text-button rail consume much of the remaining view | Implemented a one-row input strip and 56px icon rail; 44px targets and 200% text sizing verified | The desktop becomes too small to read comfortably while typing |
| LOW | UI | Receiver textarea | Native resize handle is visible on a touch-first remote-input field | Implemented a non-resizable single-row field that grows with enlarged text | Resizing competes with the remote screen for scarce space |

Repairs implemented during this review include moving controls to the right, placing secondary actions in Options, restoring trigger focus on Close/Escape, revealing the typing-panel parent before focusing its field, and improving the input boundary from 2.44:1 to 4.44:1 contrast. USB now opens the authorized phone browser with a one-use automatic invitation; manual entry is a fallback disclosure.

## Verification

Passed:

- `cd gui && npm test`: 175 passed, zero failed, seven optional platform/native-fixture skips. This includes decoder recovery, stale callback isolation, typed input lifecycle, panel focus, authorized USB auto-open, early phone authentication, manual fallback and launcher configuration reuse checks.
- `cd gui && npm run build`: TypeScript and Vite production build passed.
- Actual synthetic video in the browser at 320×640 and 844×390: no horizontal overflow, controls at least 44px, 16px focused typing field visible, Options and typing panels mutually exclusive. Typing now uses a compact row below the video.
- Actual fullscreen and hide/show controls: Exit full screen was exposed; the Show controls target stayed outside the video. Temporary viewport override reset afterward.
- Contrast measurements: main text 15.33:1, button text 11.75:1, secondary text 8.23:1, focus ring against its measured control background 6.70:1, input boundary against input background 4.44:1.
- USB hardware diagnosis: Edge on Android 17 authenticated but stalled without video output; software H.264 configuration was unavailable. A 100ms stalled-output flush, followed by a fresh host IDR, now maintains the authenticated USB stream with fresh frame acknowledgments for over 60 seconds. The user confirms phone video stays visible for 20 seconds and reports typing works. A controlled repeat was independently read as 789 in Mac Calculator, confirming native text delivery. Flushing can reduce frame rate and increase IDR traffic.

- New actual fullscreen preview with a deliberately smaller visual viewport: outer height 390px; visible inner frame 180px at top offset 12px. Video, typing field, Close and Hide all remained inside the expected visible bounds.
- RTL plus 200% root text size at 320px: 32px input text fits a 66px-high field with no internal or page overflow. This is a text-resize check, not a full browser-zoom or screen-reader pass.

Not verified:

- IME/non-Latin layouts, VoiceOver traversal, pseudo-localization and 200% browser zoom.
- Real-phone soft-keyboard/fullscreen repeat of the newly fixed assets remains pending. Earlier phone screenshots are the failing baseline.
- Safari/iPhone/iPad behavior, current candidate audio smoothness, long-session performance and physical recovery regressions.


The native binary is SHA-256 `b083ecfd69cf350e7cf831b767c1ebf36640c5e728ac79579f1fcc4c73331955`. ACK timing is not physical touch-to-display latency. This review is neither a WCAG conformance claim nor a universal device qualification.

## Verdict

Block pending real-phone fullscreen/soft-keyboard repeat verification of the implemented source fix. USB video and native phone typing passed; audio and unverified accessibility/device scenarios remain qualification gates.

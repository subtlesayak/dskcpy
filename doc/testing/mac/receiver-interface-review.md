# Browser receiver interface review — 11 November 2026

## Scope and coverage

Inspected the receiver's connect → stream → right-side controls → typing flow, plus the USB “Open on phone” step. The receiver uses plain HTML, CSS and JavaScript; the existing React host panel and system-font/color conventions are retained. Repository convention sources were `gui/README.md` and `doc/browser-receiver.md`; no additional project style guide was found. Native Android UI, the rest of the dashboard and platform system dialogs are outside this interface review.

| Domain | Evidence inspected | Result |
| --- | --- | --- |
| Accessibility | Receiver labels, native disclosures, focus-visible styling, Close/Escape focus restoration; keyboard lifecycle unit tests and actual typing-panel focus | Clear in inspected states; VoiceOver walk not verified |
| Layout | `receiver.css`, stage/control panels and hidden-controls gutter; rendered 320×640 and 844×390 layouts | Clear in inspected viewports; RTL and 200% browser zoom not verified |
| Writing | Connect, USB auto-open, keyboard, Options and permission-recovery messages | Clear in inspected flow |
| Typography | System font, wrapping, button line-height and computed 16px typing field | Clear in inspected states; translated expansion not verified |
| Colors | Computed text, input boundaries and focus-ring contrast | Clear in measured combinations |
| UI polish | Right rail, disclosure states, button targets, hover-capability and reduced-motion rules; actual focus and fullscreen/hidden controls | Clear in inspected states |

## Findings

No actionable interface findings remain within the inspected states. Repairs implemented during this review include moving controls to the right, placing secondary actions in Options, restoring trigger focus on Close/Escape, revealing the typing-panel parent before focusing its field, and improving the input boundary from 2.44:1 to 4.44:1 contrast. USB now opens the authorized phone browser with a one-use automatic invitation; manual entry is a fallback disclosure.

## Verification

Passed:

- `cd gui && npm test`: 173 passed, zero failed, seven optional platform/native-fixture skips. This includes decoder recovery, stale callback isolation, typed input lifecycle, panel focus, authorized USB auto-open, early phone authentication, manual fallback and launcher configuration reuse checks.
- `cd gui && npm run build`: TypeScript and Vite production build passed.
- Actual synthetic video in the browser at 320×640 and 844×390: no horizontal overflow, controls at least 44px, 16px focused typing field visible, Options and typing panels mutually exclusive. Landscape typing sits beside the video.
- Actual fullscreen and hide/show controls: Exit full screen was exposed; the Show controls target stayed outside the video. Temporary viewport override reset afterward.
- Contrast measurements: main text 15.33:1, button text 11.75:1, secondary text 8.23:1, focus ring against its measured control background 6.70:1, input boundary against input background 4.44:1.
- USB hardware diagnosis: Edge on Android 17 authenticated but stalled without video output; software H.264 configuration was unavailable. A 100ms stalled-output flush, followed by a fresh host IDR, now maintains the authenticated USB stream with fresh frame acknowledgments for over 60 seconds. This is host-side evidence; phone picture and physical keyboard confirmation are pending. Flushing can reduce frame rate and increase IDR traffic.

Not verified:

- Phone typing result, IME/non-Latin layouts, VoiceOver traversal, RTL, pseudo-localization and 200% browser zoom.
- Safari/iPhone/iPad behavior, current candidate audio smoothness, long-session performance and physical recovery regressions.

The native binary is SHA-256 `b083ecfd69cf350e7cf831b767c1ebf36640c5e728ac79579f1fcc4c73331955`. ACK timing is not physical touch-to-display latency. This review is neither a WCAG conformance claim nor a universal device qualification.

## Verdict

Approve for the inspected interface states and measured viewports only. Physical keyboard, audio and the unverified accessibility/device scenarios remain release qualification gates.

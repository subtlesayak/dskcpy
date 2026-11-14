# Browser zoom and local view movement

Select **Move view** (the magnifier in the receiver rail) to navigate the picture.
Pinch with two fingers to zoom from the fitted desktop up to 400%, and drag with
one finger to move the enlarged picture. The zoom, Fit desktop and direction
buttons offer single-pointer alternatives. Focus the picture to use +/− for
zoom, arrows to move and 0 to fit. Done or Escape closes the controls and resumes
remote pointer control at the enlarged view. Direct-touch and trackpad scroll
gestures retain their normal meanings outside Move view.

These gestures change only the local picture, not the Mac's display resolution,
capture, applications or desktop zoom. While Move view is open, its gestures and
keyboard navigation never emit remote input. Existing holds and queued motion
are released when entering or leaving the mode. View-only connections can use
it without receiving input capability. The same transformation applies to both
WebRTC video and the WebCodecs input surface; direct input uses the transformed
surface bounds. Magnification cannot restore detail absent from the stream.

Geometry changes, blur, hiding, cancellation and connection transitions discard
local contacts. Resize retains a bounded normalized view center; a new stream
resolution or explicit Disconnect resets the view to Fit. A temporary reconnect
at the same resolution can retain the view, without replaying old gestures.
The scale and position remain only in page memory.

A new controller is needed to serve view.mjs with the updated receiver. No active
session is updated by these source changes. Controlled deployment and actual
Android Edge, other phone browsers and Safari/iOS gesture, keyboard, fullscreen
and coordinate qualification remain required. Synthetic Chromium gestures and
fake native collectors establish local mapping and lifecycle behavior only;
they do not establish real capture/input or universal browser compatibility.

// A PiP video remains intentionally visible while its original page is hidden.
// PiP changes playback visibility only; it does not enable keyboard focus.
export function receiverIsAway({ hidden, pictureInPictureElement, video, presentationMode, presentationPlayback = false }) {
  return Boolean(hidden && !presentationPlayback && !(video && (pictureInPictureElement === video || presentationMode === 'picture-in-picture')));
}

// Only fixed role booleans cross the host IPC boundary. Never pass invitations,
// endpoint addresses, logs, native diagnostics or arbitrary broker state.
export function presentationSummary(value) {
  const fields = ['ended', 'available', 'controllerConnected', 'controllerActive', 'controllerAuthorized'];
  if (!value || Array.isArray(value) || fields.some(key => typeof value[key] !== 'boolean')) return null;
  const ended = value.ended, available = !ended && value.available;
  const controllerConnected = value.controllerConnected;
  return { ended, available, controllerConnected,
    controllerActive: available && controllerConnected && value.controllerActive,
    controllerAuthorized: controllerConnected || value.controllerAuthorized };
}

export function browserSummary(browser) {
  const value = { waiting: browser?.waiting === true, connected: browser?.connected === true };
  if (browser?.presentation === true) {
    const presentation = presentationSummary({ ended: browser.presentationEnded, available: browser.presentationAvailable,
      controllerConnected: browser.controllerConnected, controllerActive: browser.controllerActive,
      controllerAuthorized: browser.controllerAuthorized });
    if (!presentation) throw Error('Presentation status is unavailable');
    value.presentation = presentation;
  }
  return value;
}

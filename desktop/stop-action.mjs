// Confirm only explicit user Stop on an active session. Programmatic cleanup
// continues to call HostController.stop/close directly and never waits on UI.
export function createStopAction({ snapshot, stop, confirm }) {
  let pending;
  return function requestStop() {
    if (pending) return pending;
    const state = snapshot();
    if (!state.canStop) return Promise.resolve(state);
    const operation = Promise.resolve().then(async () => {
      if (state.phase === 'sharing' && await confirm(state) !== true) return snapshot();
      // The session may have ended while the question was open.
      if (!snapshot().canStop) return snapshot();
      return stop();
    });
    pending = operation.finally(() => { pending = null; });
    return pending;
  };
}

const stages = new Set(['native-fixture-help', 'electron-process', 'app-ready', 'utility-start',
  'utility-readiness', 'utility-idle', 'renderer-load', 'renderer-actions', 'renderer-validation', 'utility-shutdown', 'result-write']);
// Never serialize raw exceptions, stdout/stderr, environment, or local paths.
export function smokeFailure(record, error, phase = 'electron-process') {
  return { passed: false, stage: stages.has(record?.stage) ? record.stage : stages.has(phase) ? phase : 'electron-process',
    category: record?.category === 'assertion' ? 'assertion' : error?.killed ? 'timeout' : 'runtime',
    exitCode: Number.isSafeInteger(error?.code) ? error.code : null,
    signal: ['SIGTERM', 'SIGKILL', 'SIGABRT', 'SIGSEGV'].includes(error?.signal) ? error.signal : null,
    actualHostShellLaunched: false, screenCapture: false, permissionApis: false };
}


// Electron's Windows entry point tests whether this variable exists, even when
// empty. GUI smoke children must delete every casing, rather than set it to ''.
export function electronUiEnvironment(input) {
  return Object.fromEntries(Object.entries(input).filter(([name]) => name.toUpperCase() !== 'ELECTRON_RUN_AS_NODE'));
}

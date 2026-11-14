// A local display preference, never an access grant or a measured quality level.
// Storage is scoped by the browser to this receiver origin, including its port.
const key = 'dskcpy.video.v1';
export function createVideoPreference({ storage = () => null } = {}) {
  let automatic = null;
  try {
    const raw = storage()?.getItem(key);
    if (typeof raw === 'string' && raw.length <= 64) {
      const value = JSON.parse(raw);
      if (value && !Array.isArray(value) && Object.keys(value).length === 2
          && value.version === 1 && typeof value.automatic === 'boolean') automatic = value.automatic;
    }
  } catch { /* Unavailable or invalid storage keeps the host's default. */ }
  return {
    get automatic() { return automatic; },
    choose(value) {
      if (typeof value !== 'boolean') return false;
      automatic = value;
      try {
        const store = storage();
        if (!store) return false;
        store.setItem(key, JSON.stringify({ version: 1, automatic }));
        return true;
      } catch { return false; } // Keep an explicit choice for this page visit.
    },
  };
}

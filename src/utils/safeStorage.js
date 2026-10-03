// Preference storage is optional. Blocked storage must not prevent sign-in;
// component state continues to work for the current page/session.
export const getLocalStorageItem = (key) => {
  try { return globalThis.localStorage?.getItem(key) ?? null; } catch { return null; }
};

export const setLocalStorageItem = (key, value) => {
  try { globalThis.localStorage?.setItem(key, value); } catch { /* unavailable or full */ }
};

export const removeLocalStorageItem = (key) => {
  try { globalThis.localStorage?.removeItem(key); } catch { /* unavailable */ }
};

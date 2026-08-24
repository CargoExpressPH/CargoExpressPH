import { supabase } from './supabase';

// This ID identifies the browser/PWA installation, not the signed-in user.
// It lets one account keep one registration per device and lets a later
// account claim only this device after an account switch.
const PUSH_DEVICE_ID_KEY = 'cargoexpress_push_device_id';

const isMissingLifecycleRpc = (error) => {
  const code = error?.code;
  const message = String(error?.message || '').toLowerCase();
  return code === 'PGRST202'
    || code === '42883'
    || message.includes('claim_push_device_registration')
    || message.includes('remove_push_device_registration');
};

const isMissingDeviceColumn = (error) => {
  const code = error?.code;
  const message = String(error?.message || '').toLowerCase();
  return code === '42703'
    || message.includes('device_id') && (
      message.includes('column')
      || message.includes('schema cache')
      || message.includes('does not exist')
    );
};

const createDeviceId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
};

/** Return the stable ID for this browser/PWA installation. */
export const getPushDeviceId = () => {
  if (typeof window === 'undefined') return null;

  try {
    const existing = localStorage.getItem(PUSH_DEVICE_ID_KEY);
    if (existing) return existing;

    const next = createDeviceId();
    localStorage.setItem(PUSH_DEVICE_ID_KEY, next);
    return next;
  } catch {
    // Private browsing can deny storage. Registration still has a token-based
    // fallback, but it cannot support account switching as reliably.
    return null;
  }
};

/**
 * Claim exactly this browser/device for the current signed-in user.
 * The RPC removes an old account's stale row for this device and replaces the
 * token atomically, without affecting the user's other devices.
 */
export const registerPushDevice = async (userId, token) => {
  if (!userId || !token) return false;

  const deviceId = getPushDeviceId();
  if (deviceId) {
    const { error } = await supabase.rpc('claim_push_device_registration', {
      p_device_id: deviceId,
      p_token: token,
    });

    if (!error) return true;
    if (!isMissingLifecycleRpc(error)) return false;
  }

  // Compatibility fallback for the short rollout window before the migration
  // is applied. New deployments use the RPC above.
  const { error } = await supabase
    .from('user_device_tokens')
    .upsert({ user_id: userId, token }, { onConflict: 'token' });
  return !error;
};

/** Remove this browser/device registration for the current user. */
export const removePushDeviceRegistration = async (userId, token = null) => {
  if (!userId) return false;

  const deviceId = getPushDeviceId();
  if (deviceId) {
    const { error } = await supabase.rpc('remove_push_device_registration', {
      p_device_id: deviceId,
      p_token: token,
    });

    if (!error) return true;
    if (!isMissingLifecycleRpc(error)) return false;
  }

  if (!token) return false;

  const { error } = await supabase
    .from('user_device_tokens')
    .delete()
    .eq('user_id', userId)
    .eq('token', token);
  return !error;
};

/**
 * Check whether this user's current device was previously registered.
 * This is intentionally separate from Notification.permission: permission is
 * only a browser capability, while this query verifies server registration.
 */
export const hasPushDeviceRegistration = async (userId, token = null) => {
  if (!userId) return false;

  const deviceId = getPushDeviceId();
  if (deviceId) {
    const { data, error } = await supabase
      .from('user_device_tokens')
      .select('id')
      .eq('user_id', userId)
      .eq('device_id', deviceId)
      .limit(1)
      .maybeSingle();

    if (!error && data) return true;
    if (error && !isMissingDeviceColumn(error)) return false;
  }

  if (!token) return false;

  const { data, error } = await supabase
    .from('user_device_tokens')
    .select('id')
    .eq('user_id', userId)
    .eq('token', token)
    .limit(1)
    .maybeSingle();
  return !error && Boolean(data);
};

/** Remove legacy state flags. They are no longer used as push truth. */
export const clearLegacyPushState = () => {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem('fcm_enabled');
    localStorage.removeItem('ios_push_subscribed');
    localStorage.removeItem('fcm_token_last_refresh');
  } catch {
    // Storage is optional; server registration is the source of truth.
  }
};

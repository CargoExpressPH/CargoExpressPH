import { supabase } from './supabase';

// Globally cache the session inside this module to avoid calling getSession()
// which can trigger race conditions and unexpected logouts during saves.
let cachedUser = null;
let cachedProfileName = null;

// Initialize cache
supabase.auth.getSession().then(({ data: { session } }) => {
  if (session?.user) {
    cachedUser = session.user;
    fetchProfileName(session.user.id);
  }
});

supabase.auth.onAuthStateChange((event, session) => {
  if (event === 'SIGNED_OUT') {
    cachedUser = null;
    cachedProfileName = null;
  } else if (session?.user) {
    cachedUser = session.user;
    if (!cachedProfileName) fetchProfileName(session.user.id);
  }
});

async function fetchProfileName(userId) {
  try {
    const { data } = await supabase.from('profiles').select('name').eq('id', userId).maybeSingle();
    if (data?.name) cachedProfileName = data.name;
  } catch (err) {
    // ignore
  }
}

export const logActivity = ({
  module,
  action,
  recordType = null,
  recordId = null,
  recordRef = null,
  previousValue = null,
  newValue = null,
  details = null,
}) => {
  (async () => {
    try {
      if (!cachedUser) return; // Not authenticated — skip logging
      
      const adminName = cachedProfileName || cachedUser.email || 'Unknown Admin';

      const { error: insertError } = await supabase.from('activity_logs').insert({
        admin_id: cachedUser.id,
        admin_name: adminName,
        module,
        action,
        record_type: recordType,
        record_id: recordId || null,
        record_ref: recordRef,
        previous_value: previousValue ? JSON.parse(JSON.stringify(previousValue)) : null,
        new_value: newValue ? JSON.parse(JSON.stringify(newValue)) : null,
        details,
      });
      
      if (insertError) throw insertError;
    } catch (err) {
      console.warn('[ActivityLog] Failed to log activity:', err?.message);
    }
  })();
};

export const logOrder = (action, orderId, trackingNumber, extra = {}) =>
  logActivity({ module: 'Orders', action, recordType: 'order', recordId: orderId, recordRef: trackingNumber, ...extra });

export const logTrip = (action, tripId, tripNumber, extra = {}) =>
  logActivity({ module: 'Trips', action, recordType: 'trip', recordId: tripId, recordRef: tripNumber, ...extra });

export const logPayment = (action, orderId, trackingNumber, extra = {}) =>
  logActivity({ module: 'Payments', action, recordType: 'order', recordId: orderId, recordRef: trackingNumber, ...extra });

export const logChat = (action, conversationId, customerName, extra = {}) =>
  logActivity({ module: 'Chat', action, recordType: 'conversation', recordId: conversationId, recordRef: customerName, ...extra });

export const logAuth = (action, extra = {}) =>
  logActivity({ module: 'Authentication', action, recordType: 'user', ...extra });

export const logAnnouncement = (action, announcementId, title, extra = {}) =>
  logActivity({ module: 'System', action, recordType: 'announcement', recordId: announcementId, recordRef: title, ...extra });

export const logSettings = (action, settingKey, extra = {}) =>
  logActivity({ module: 'System', action, recordType: 'setting', recordRef: settingKey, ...extra });

export const logCompany = (action, extra = {}) =>
  logActivity({ module: 'System', action, recordType: 'company', ...extra });


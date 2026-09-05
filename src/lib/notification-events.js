export const NOTIFICATIONS_CHANGED_EVENT = 'cargoexpress:notifications-changed';

/**
 * Tell the mounted layout to refresh its server-backed unread count after a
 * local mutation. Realtime still handles changes from other tabs/devices;
 * this event removes its delivery latency from the UI that made the change.
 */
export const emitNotificationsChanged = () => {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED_EVENT));
  }
};

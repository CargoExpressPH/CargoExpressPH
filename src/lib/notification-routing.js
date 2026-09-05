const orderPath = (prefix, referenceId) => (
  referenceId ? `${prefix}/orders/${encodeURIComponent(referenceId)}` : `${prefix}/orders`
);

/** Return the most relevant destination for a customer notification card. */
export const getCustomerNotificationRoute = (notification) => {
  switch (notification?.type) {
    case 'order_update':
    case 'payment_update':
      return orderPath('/customer', notification.reference_id);
    case 'general':
      return notification.reference_id
        ? orderPath('/customer', notification.reference_id)
        : null;
    case 'trip_update':
      return '/customer/trips';
    case 'chat_message':
      return '/customer/support';
    default:
      return null;
  }
};

/** Return the most relevant destination for an admin notification. */
export const getAdminNotificationRoute = (notification) => {
  switch (notification?.type) {
    case 'order_update':
    case 'payment_update':
      return orderPath('/admin', notification.reference_id);
    case 'trip_update':
      return notification.reference_id
        ? `/admin/trips/${encodeURIComponent(notification.reference_id)}`
        : '/admin/trips';
    case 'inquiry':
      return '/admin/contact-inquiries';
    case 'chat_message':
      return '/admin/inbox';
    case 'feedback':
      return '/admin/feedback';
    case 'announcement':
      return '/admin/announcements';
    case 'system_alert':
      return notification.title === 'Storage Warning'
        ? '/admin/storage-monitoring'
        : '/admin';
    default:
      return '/admin';
  }
};

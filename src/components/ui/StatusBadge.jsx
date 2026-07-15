const statusToClass = (status) => {
  const map = {
    'Pending': 'badge-pending', 'Assigned': 'badge-assigned',
    'Picked Up': 'badge-picked-up', 'In Transit': 'badge-in-transit',
    'Arrived at Hub': 'badge-arrived', 'Out for Delivery': 'badge-out-delivery',
    'Delivered': 'badge-delivered', 'Cancelled': 'badge-cancelled',
    'scheduled': 'badge-info', 'in_progress': 'badge-warning',
    'arrived': 'badge-success', 'completed': 'badge-delivered',
    'cancelled': 'badge-cancelled',
    'paid': 'badge-delivered', 'partial': 'badge-warning', 'unpaid': 'badge-cancelled',
  };
  return map[status] || 'badge-info';
};

const isActiveStatus = (status) => {
  return ['In Transit', 'Out for Delivery', 'in_progress'].includes(status);
};

const StatusBadge = ({ status, size = 'default' }) => {
  const label = (status || '').replace(/_/g, ' ');
  const active = isActiveStatus(status);

  return (
    <span className={`badge ${statusToClass(status)} ${size === 'sm' ? 'text-xs' : ''}`} aria-label={`Status: ${label}`}>
      <span className={`badge-dot ${active ? 'animated' : ''}`} />
      {label}
    </span>
  );
};

export default StatusBadge;

import { useEffect, useRef, useState } from 'react';
import QRCode from 'react-qr-code';
import { Minus, Plus, Printer, QrCode } from 'lucide-react';
import { updateOrder } from '../../lib/database';
import { logOrder } from '../../lib/activityLog';
import { useToast } from '../../hooks/useToast';
import { getAppUrl } from '../../utils/appUrl';
import { ORDER_STATUS } from '../../constants/status';
import PrintLabelsSheet from './PrintLabelsSheet';

// Mirrors orders_package_quantity_check in
// 20260922080000_add_order_package_quantity.sql — the ceiling is a sanity
// bound, not a real business limit, but keeping both in sync means the UI
// never lets the admin pick a value the database would then reject.
const MIN_PACKAGES = 1;
const MAX_PACKAGES = 50;

// Once a booking is out the door, printing a new label set no longer maps to
// anything physical — mirrors the existing contact-details lock
// (ADMIN_CONTACT_EDIT_LOCKED_STATUSES) elsewhere on this page.
const LOCKED_STATUSES = [ORDER_STATUS.OUT_FOR_DELIVERY, ORDER_STATUS.DELIVERED, ORDER_STATUS.CANCELLED];

// The QR payload is intentionally an admin-only deep link, never the public
// /track page: scanning a box with no session lands on the login wall, not
// booking details. See the Admin route guard (ProtectedRoute in App.jsx),
// which preserves ?box=<n> through the login redirect via location.state.from.
const buildLabel = (order, box, total) => ({
  box,
  total,
  trackingNumber: order.tracking_number,
  url: `${getAppUrl()}/admin/orders/${order.id}?box=${box}`,
});

const PackageQrLabels = ({ order, onOrderUpdate }) => {
  const toast = useToast();
  const [count, setCount] = useState(order.package_quantity || 1);
  const [saving, setSaving] = useState(false);
  const saveTimerRef = useRef(null);
  // The last value actually confirmed written to the DB — persist() diffs
  // against this, and a failed write rolls the visible count back to it.
  const savedCountRef = useRef(order.package_quantity || 1);

  // A freshly-loaded order (navigating to a different booking, or a
  // background realtime refresh) always wins over any in-flight local edit —
  // this section never fights loadOrder() for the source of truth.
  useEffect(() => {
    setCount(order.package_quantity || 1);
    savedCountRef.current = order.package_quantity || 1;
  }, [order.id, order.package_quantity]);

  useEffect(() => () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
  }, []);

  const locked = LOCKED_STATUSES.includes(order.status);

  // Debounced so a burst of +/- clicks writes once, not once per click —
  // same 500ms-after-last-change shape as BookShipmentPage's draft autosave.
  const persist = (next) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      if (next === savedCountRef.current) return;
      const previous = savedCountRef.current;
      setSaving(true);
      try {
        await updateOrder(order.id, { package_quantity: next });
        savedCountRef.current = next;
        onOrderUpdate?.({ package_quantity: next });
        logOrder('Package Count Updated', order.id, order.tracking_number, {
          previousValue: { package_quantity: previous },
          newValue: { package_quantity: next },
          details: `Package quantity changed from ${previous} to ${next}.`,
        });
      } catch (e) {
        toast.error(e.message || 'Failed to save the package count. Please try again.');
        setCount(savedCountRef.current); // the DB never got this value — don't let the UI claim it did
      } finally {
        setSaving(false);
      }
    }, 500);
  };

  const changeCount = (delta) => {
    if (locked) return;
    const next = Math.min(MAX_PACKAGES, Math.max(MIN_PACKAGES, count + delta));
    if (next === count) return;
    setCount(next);
    persist(next);
  };

  const labels = Array.from({ length: count }, (_, i) => buildLabel(order, i + 1, count));

  const handlePrint = () => {
    logOrder('Package Labels Printed', order.id, order.tracking_number, {
      details: `Printed ${count} package label${count === 1 ? '' : 's'}.`,
    });
    requestAnimationFrame(() => window.print());
  };

  return (
    <div className="card admin-section-card stagger-item mb-16" style={{ animationDelay: '330ms' }}>
      <div className="card-header">
        <h3><QrCode size={16} className="inline mr-8" />Package QR Labels</h3>
      </div>
      <div className="card-body p-16">
        <div className="flex items-center justify-between gap-16 flex-wrap mb-16">
          <div className="qty-stepper" role="group" aria-label="Number of packages">
            <button
              type="button"
              className="btn btn-outline btn-sm"
              onClick={() => changeCount(-1)}
              disabled={locked || count <= MIN_PACKAGES}
              aria-label="Decrease package count"
            >
              <Minus size={14} />
            </button>
            <span className="qty-stepper-value" aria-live="polite">{count}</span>
            <button
              type="button"
              className="btn btn-outline btn-sm"
              onClick={() => changeCount(1)}
              disabled={locked || count >= MAX_PACKAGES}
              aria-label="Increase package count"
            >
              <Plus size={14} />
            </button>
          </div>

          <span className="text-xs text-secondary">
            {locked
              ? `Locked — the package count can no longer be changed once a booking is ${order.status}.`
              : saving
                ? 'Saving…'
                : `${count} box${count === 1 ? '' : 'es'} for this booking.`}
          </span>

          <button type="button" className="btn btn-primary btn-sm" onClick={handlePrint}>
            <Printer size={14} /> Print Labels
          </button>
        </div>

        <div className="qr-label-preview-grid">
          {labels.map(label => (
            <div className="qr-label-preview" key={label.box}>
              <QRCode value={label.url} size={112} style={{ height: 'auto', maxWidth: '100%', width: '100%' }} viewBox="0 0 112 112" />
              <div className="qr-label-preview-caption">Box {label.box} of {label.total}</div>
              <div className="qr-label-preview-tracking">{label.trackingNumber}</div>
            </div>
          ))}
        </div>
      </div>

      <PrintLabelsSheet trackingNumber={order.tracking_number} labels={labels} />
    </div>
  );
};

export default PackageQrLabels;

// Classifies the text read from a QR code by the admin topbar scanner
// (QrScannerModal.jsx). Pure and DOM-free so the contract test can run it
// under plain Node.
//
// What a scan can be:
//  - 'order'    a package label from PackageQrLabels.jsx:
//               <app origin>/admin/orders/<uuid>?box=<n>
//  - 'tracking' a tracking number, either as bare text (CE-20260801-3261) or
//               inside a public tracking link (/track?q=… or /customer/track?q=…)
//  - 'payment'  the PayMongo GCash checkout QR from PaymentCollectionPanel —
//               recognised only so the scanner can say what it is
//  - 'unknown'  anything else
//
// The origin of a label URL is deliberately not checked. Labels are printed
// with getAppUrl(), which differs between deployments, and the scanner only
// ever uses the path to navigate inside this app, so a foreign host cannot
// send the admin anywhere outside it.

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Same shape supportChatEngine.js accepts: tolerant of a missing or spaced
// dash, since a hand-typed or re-encoded number may lose them.
const TRACKING_RX = /^CE[-\s]?(\d{8})[-\s]?(\d{4})$/i;
const ORDER_PATH_RX = /^\/admin\/orders\/([^/]+)\/?$/;
const TRACK_PATHS = new Set(['/track', '/track/', '/customer/track', '/customer/track/']);

export const normalizeTrackingNumber = (value) => {
  const match = TRACKING_RX.exec(String(value || '').trim());
  return match ? `CE-${match[1]}-${match[2]}` : null;
};

const parseBox = (raw) => {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 ? n : null;
};

export const parseScanPayload = (text) => {
  const value = String(text || '').trim();
  if (!value) return { kind: 'unknown' };

  if (/^https?:\/\//i.test(value)) {
    let url;
    try {
      url = new URL(value);
    } catch {
      return { kind: 'unknown' };
    }

    const orderMatch = ORDER_PATH_RX.exec(url.pathname);
    if (orderMatch) {
      let orderId = orderMatch[1];
      try { orderId = decodeURIComponent(orderId); } catch { return { kind: 'unknown' }; }
      if (!UUID_RX.test(orderId)) return { kind: 'unknown' };
      return { kind: 'order', orderId: orderId.toLowerCase(), box: parseBox(url.searchParams.get('box')) };
    }

    if (TRACK_PATHS.has(url.pathname)) {
      const trackingNumber = normalizeTrackingNumber(url.searchParams.get('q'));
      return trackingNumber ? { kind: 'tracking', trackingNumber } : { kind: 'unknown' };
    }

    const host = url.hostname.toLowerCase();
    if (host === 'paymongo.com' || host.endsWith('.paymongo.com') || host === 'pm.link') {
      return { kind: 'payment' };
    }

    return { kind: 'unknown' };
  }

  const trackingNumber = normalizeTrackingNumber(value);
  if (trackingNumber) return { kind: 'tracking', trackingNumber };

  return { kind: 'unknown' };
};

/** In-app route for an 'order' payload. Keeps ?box so OrderDetailPage shows its "You scanned Box n" banner. */
export const orderRouteForScan = ({ orderId, box }) => (
  `/admin/orders/${orderId}${box ? `?box=${box}` : ''}`
);

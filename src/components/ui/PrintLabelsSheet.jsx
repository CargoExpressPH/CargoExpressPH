import { createPortal } from 'react-dom';
import QRCode from 'react-qr-code';

/**
 * PrintLabelsSheet — print-only sheet of cut-and-stick package QR labels.
 *
 * Deliberately NOT built on PrintDocument: that component is a formal
 * bond-paper business report (letterhead, plain tables, signature lines),
 * the wrong shape for small box stickers. This renders nothing on screen
 * (hidden via .print-labels CSS, see print-labels.css) and, like
 * PrintDocument, portals straight to document.body so it prints even though
 * the app shell (#root) is hidden under @media print.
 *
 * `labels` is an array of { box, total, trackingNumber, url } — one per
 * physical package, in order.
 */
const PrintLabelsSheet = ({ trackingNumber, labels = [] }) => {
  const content = (
    <div className="print-labels" aria-hidden="true">
      <div className="pl-sheet-title">Package Labels — {trackingNumber}</div>
      <div className="pl-grid">
        {labels.map(label => (
          <div className="pl-label" key={label.box}>
            <div className="pl-qr">
              <QRCode value={label.url} size={128} style={{ height: 'auto', maxWidth: '100%', width: '100%' }} viewBox="0 0 128 128" />
            </div>
            <div className="pl-caption">Box {label.box} of {label.total}</div>
            <div className="pl-tracking" style={{ fontSize: '11px', textTransform: 'uppercase' }}>{label.receiverName}</div>
          </div>
        ))}
      </div>
    </div>
  );

  return document.body ? createPortal(content, document.body) : null;
};

export default PrintLabelsSheet;

import { useState, useEffect } from 'react';
import { getCompanyInformation } from '../../lib/database';
import PrintHeader from './PrintHeader';

/**
 * PrintDocument — formal, print-only business report document.
 *
 * Renders nothing on screen (hidden via .print-doc CSS). When the admin
 * prints, ONLY this document is visible: a bond-paper style report with
 * company letterhead, title block, plain tables, and signature lines —
 * never the system UI.
 */
const PrintDocument = ({ title, subtitle, generatedAt, preparedBy, children }) => {
  const [company, setCompany] = useState(null);

  useEffect(() => {
    let mounted = true;
    getCompanyInformation()
      .then(info => { if (mounted) setCompany(info); })
      .catch(() => {});
    return () => { mounted = false; };
  }, []);

  return (
    <div className="print-doc" aria-hidden="true">
      <PrintHeader company={company} />

      {/* ── Title Block ── */}
      <div className="pd-title-block">
        <div className="pd-title">{title}</div>
        {subtitle && <div className="pd-subtitle">{subtitle}</div>}
        {generatedAt && <div className="pd-generated">Date Generated: {generatedAt}</div>}
      </div>

      {/* ── Report Body ── */}
      <main>{children}</main>

      {/* ── Signature Block ── */}
      <div className="pd-signatures">
        <div className="pd-signature">
          <div className="pd-signature-label">Prepared by:</div>
          <div className="pd-signature-line" />
          <div className="pd-signature-name">{preparedBy || 'System Administrator'}</div>
          <div className="pd-signature-role">Administrator</div>
        </div>
        <div className="pd-signature">
          <div className="pd-signature-label">Noted by:</div>
          <div className="pd-signature-line" />
          <div className="pd-signature-name">&nbsp;</div>
          <div className="pd-signature-role">Owner / Manager</div>
        </div>
      </div>

      <footer className="pd-footer">
        This is a system-generated report and is valid without alteration.
      </footer>
    </div>
  );
};

export default PrintDocument;

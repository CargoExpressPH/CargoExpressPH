import { useState, useEffect } from 'react';
import { getCompanyInformation } from '../../lib/database';

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

  const contactBits = [
    company?.manila_address && `Manila: ${company.manila_address}`,
    company?.bohol_address && `Bohol: ${company.bohol_address}`,
  ].filter(Boolean);

  const contactLine2 = [
    company?.smart_phone,
    company?.globe_phone,
    company?.email,
  ].filter(Boolean).join(' · ');

  return (
    <div className="print-doc" aria-hidden="true">
      {/* ── Letterhead ── */}
      <header className="pd-letterhead">
        <div className="pd-company-name">{company?.name || 'Cargo Express PH'}</div>
        <div className="pd-company-tagline">Cargo Delivery &amp; Logistics Services</div>
        {contactBits.map((line, i) => (
          <div key={i} className="pd-company-contact">{line}</div>
        ))}
        {contactLine2 && <div className="pd-company-contact">{contactLine2}</div>}
      </header>

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

/**
 * PrintHeader — the CargoExpress PH corporate letterhead, shared by every
 * printable document and PDF export (reports, and any future waybill,
 * invoice, or manifest layout).
 *
 * Renders as a plain <img> (never a CSS background-image) so the logo
 * survives html2canvas-based PDF export and Chrome/Safari's "Save as PDF",
 * both of which can drop background images depending on print settings.
 */
const PrintHeader = ({ company }) => {
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
    <header className="pd-letterhead">
      <img
        src="/images/logo-nav.png"
        alt="CargoExpress PH"
        className="pd-logo"
      />
      <div className="pd-letterhead-text">
        <div className="pd-company-name">{company?.name || 'CargoExpress PH'}</div>
        <div className="pd-company-tagline">Cargo Delivery &amp; Logistics Services</div>
        {contactBits.map((line, i) => (
          <div key={i} className="pd-company-contact">{line}</div>
        ))}
        {contactLine2 && <div className="pd-company-contact">{contactLine2}</div>}
      </div>
    </header>
  );
};

export default PrintHeader;

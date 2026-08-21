import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, CalendarDays, Mail, Phone, ShieldCheck } from 'lucide-react';
import { getCompanyInformation } from '../../lib/database';
import usePageTitle from '../../hooks/usePageTitle';
import { LEGAL_EFFECTIVE_DATE, LEGAL_EFFECTIVE_DATE_LABEL, LEGAL_POLICY_VERSION } from '../../constants/legal';
import { BrandLogo, BrandWordmark } from '../ui/BrandLogo';

const LegalPageLayout = ({
  title,
  eyebrow,
  description,
  Icon,
  sections,
  children,
}) => {
  usePageTitle(title, description);
  const [companyInfo, setCompanyInfo] = useState(null);

  useEffect(() => {
    let active = true;

    getCompanyInformation()
      .then((data) => {
        if (active) setCompanyInfo(data || null);
      })
      .catch(() => {
        // Legal pages remain usable with the safe brand/contact fallback when
        // the public company-information row is temporarily unavailable.
      });

    return () => {
      active = false;
    };
  }, []);

  const companyName = companyInfo?.name?.trim() || 'Cargo Express PH';
  const contactEmail = companyInfo?.email?.trim() || '';
  const contactPhone = companyInfo?.smart_phone?.trim() || companyInfo?.globe_phone?.trim() || '';
  const documentContent = typeof children === 'function'
    ? children({ companyName, companyInfo })
    : children;

  return (
    <div className="legal-page">
      <a className="legal-skip-link" href="#legal-document">Skip to document</a>

      <header className="legal-site-header">
        <div className="legal-header-inner">
          <Link to="/about" className="legal-brand" aria-label={`Back to ${companyName}`}>
            <BrandLogo size={34} decorative />
            <BrandWordmark />
          </Link>
          <Link to="/about" className="legal-back-link">
            <ArrowLeft size={16} aria-hidden="true" />
            Back to website
          </Link>
        </div>
      </header>

      <main className="legal-main">
        <div className="legal-hero">
          <div className="legal-hero-icon" aria-hidden="true">
            <Icon size={22} />
          </div>
          <p className="legal-eyebrow">{eyebrow}</p>
          <h1 id="legal-document-title" className="legal-title">{title}</h1>
          <p className="legal-lede">{description}</p>
          <p className="legal-meta">
            <CalendarDays size={15} aria-hidden="true" />
            <span>
              Effective <time dateTime={LEGAL_EFFECTIVE_DATE}>{LEGAL_EFFECTIVE_DATE_LABEL}</time>
              <span aria-hidden="true"> · </span>
              Version {LEGAL_POLICY_VERSION}
            </span>
          </p>
        </div>

        <div className="legal-layout">
          <aside className="legal-sidebar" aria-label="Document navigation">
            <nav className="legal-toc" aria-label="On this page">
              <p className="legal-toc-title">On this page</p>
              <ol>
                {sections.map((section) => (
                  <li key={section.id}>
                    <a href={`#${section.id}`}>{section.label}</a>
                  </li>
                ))}
              </ol>
            </nav>

            <div className="legal-contact-card">
              <ShieldCheck size={18} aria-hidden="true" />
              <h2>Questions?</h2>
              <p>We are here to help with service or privacy questions.</p>
              {contactEmail ? (
                <a href={`mailto:${contactEmail}`}>
                  <Mail size={14} aria-hidden="true" />
                  {contactEmail}
                </a>
              ) : (
                <Link to="/about#contact">
                  <Mail size={14} aria-hidden="true" />
                  Contact us
                </Link>
              )}
              {contactPhone && (
                <a href={`tel:${contactPhone}`}>
                  <Phone size={14} aria-hidden="true" />
                  {contactPhone}
                </a>
              )}
            </div>
          </aside>

          <article id="legal-document" className="legal-content" aria-labelledby="legal-document-title">
            {documentContent}
          </article>
        </div>
      </main>

      <footer className="legal-footer">
        <div className="legal-footer-inner">
          <span>© {new Date().getFullYear()} {companyName}</span>
          <nav aria-label="Legal links">
            <Link to="/terms">Terms of Service</Link>
            <Link to="/privacy">Privacy Policy</Link>
            <Link to="/about#contact">Contact</Link>
          </nav>
        </div>
      </footer>
    </div>
  );
};

export default LegalPageLayout;

import { useEffect } from 'react';
import { SITE_ORIGIN, businessContactFields } from '../../seo/publicPages';

const SCRIPT_ID = 'business-structured-data';

/**
 * Adds the business's contact details (phones, hubs, Facebook, email) to the
 * page as schema.org data for search engines, straight from the live
 * company_information row the page already loaded, so an edit in
 * Admin > Company Information shows up without any code change. It extends
 * the Organization the build already describes (same @id). Renders nothing.
 */
const BusinessStructuredData = ({ info }) => {
  useEffect(() => {
    const fields = businessContactFields(info);
    if (!info || Object.keys(fields).length === 0) return undefined;

    const script = document.createElement('script');
    script.type = 'application/ld+json';
    script.id = SCRIPT_ID;
    script.textContent = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'Organization',
      '@id': `${SITE_ORIGIN}/#organization`,
      name: info.name || 'CargoExpress PH',
      url: `${SITE_ORIGIN}/`,
      ...fields,
    }).replace(/</g, '\\u003c');

    document.getElementById(SCRIPT_ID)?.remove();
    document.head.appendChild(script);
    return () => script.remove();
  }, [info]);

  return null;
};

export default BusinessStructuredData;

// Keep these identifiers in sync with the seed data in the legal-consent
// migration. Publishing a revised document means adding a new version here
// and in a new migration; never change the body for an already-published one.
export const LEGAL_DOCUMENT_VERSION = '2026-08-22';
export const LEGAL_EFFECTIVE_DATE = '22 August 2026';

export const LEGAL_DOCUMENTS = {
  terms: {
    key: 'terms',
    title: 'Terms of Service',
    shortTitle: 'Terms',
    path: '/terms',
    version: LEGAL_DOCUMENT_VERSION,
    effectiveDate: LEGAL_EFFECTIVE_DATE,
  },
  privacy: {
    key: 'privacy',
    title: 'Privacy Policy',
    shortTitle: 'Privacy',
    path: '/privacy',
    version: LEGAL_DOCUMENT_VERSION,
    effectiveDate: LEGAL_EFFECTIVE_DATE,
  },
};

export const getLegalDocument = (key) => LEGAL_DOCUMENTS[key];

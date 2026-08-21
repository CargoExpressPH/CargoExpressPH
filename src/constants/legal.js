// Keep the published document version in one place. When either document
// changes materially, update this value and run the matching database
// migration/deployment process so new registrations record the new version.
export const LEGAL_POLICY_VERSION = '2026-08-22';
export const LEGAL_EFFECTIVE_DATE = '2026-08-22';
export const LEGAL_EFFECTIVE_DATE_LABEL = 'August 22, 2026';

export const LEGAL_DOCUMENTS = Object.freeze({
  terms: Object.freeze({
    key: 'terms_of_service',
    title: 'Terms of Service',
    path: '/terms',
  }),
  privacy: Object.freeze({
    key: 'privacy_policy',
    title: 'Privacy Policy',
    path: '/privacy',
  }),
});

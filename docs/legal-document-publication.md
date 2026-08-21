# Publishing legal documents

The Terms of Service and Privacy Policy are versioned product documents. A new version is a release, not an in-place text edit.

## Before publishing

1. Obtain approval from the authorised business owner and qualified legal/privacy reviewer.
2. Confirm the exact company legal name, address, privacy contact, retention schedule, delivery terms, refund rules, and any processor or partner disclosures in the approved copy.
3. Choose an immutable version identifier in `YYYY-MM-DD` format and an effective date that provides any notice required by applicable law.

## Release checklist

1. Add the approved copy as a new version in `src/constants/legalDocuments.js` and the legal-page content. Do not rewrite an already-published version.
2. Add a new Supabase migration that inserts the new rows in `public.legal_documents`, makes them current, and preserves the existing rows and consent records.
3. Update `LEGAL_DOCUMENT_VERSION` only after the migration is included in the same release.
4. Verify the public `/terms` and `/privacy` URLs, registration links, required checkbox, and a newly created test account’s two `legal_consents` rows.
5. Keep the release commit and approved legal copy with the organisation’s records so an accepted version can be reproduced later.

## Consent model

The registration browser sends affirmative acceptance with the version it displayed. The `on_auth_user_created` trigger rejects a signup unless it matches both server-published current documents, then appends one consent record for each document inside the account-creation transaction. Clients have read-only access to their own evidence and cannot create, change, or delete it.

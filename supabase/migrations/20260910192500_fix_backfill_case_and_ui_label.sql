-- Fix the case-mismatch from 20260910183700: 'AUTHENTICATION' should be 'Authentication'
-- The original migration matched 0 rows because Postgres string comparison is case-sensitive.
UPDATE activity_logs
SET record_ref = admin_name
WHERE module = 'Authentication'
  AND (record_ref IS NULL OR record_ref = '');

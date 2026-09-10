-- Backfill missing references for old Authentication logs
UPDATE activity_logs
SET record_ref = admin_name
WHERE module = 'AUTHENTICATION' 
  AND (record_ref IS NULL OR record_ref = '');

-- Fix "column reference upload_mode is ambiguous" when is_supabase_evidence_upload_allowed()
-- is evaluated inside a storage.objects RLS policy (policy context injects storage.objects columns).
-- Qualify the subquery with table alias so Postgres never confuses it with an outer scope.
BEGIN;

CREATE OR REPLACE FUNCTION public.is_supabase_evidence_upload_allowed(p_path TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  SELECT public.is_admin()
    AND (
      (storage.foldername(p_path))[1] NOT IN ('pickup', 'delivery', 'receipts', 'pickup-proofs', 'delivery-proofs')
      OR COALESCE(
        (SELECT (ps.upload_mode = 'automatic' OR ps.force_firebase_expires_at <= now())
         FROM public.photo_storage_settings ps WHERE ps.id = TRUE),
        TRUE
      )
    );
$function$;

COMMIT;

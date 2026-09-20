UPDATE public.activity_logs SET record_ref = 'Company Info' WHERE action IN ('Company Information Updated', 'Image Uploaded', 'Image Removed') AND (record_ref IS NULL OR record_ref = '');

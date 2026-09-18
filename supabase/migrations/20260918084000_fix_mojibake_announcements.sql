UPDATE public.announcements
SET title = REPLACE(title, 'Ã¢â€ â€™', '→')
WHERE title LIKE '%Ã¢â€ â€™%';

UPDATE public.announcements
SET content = REPLACE(content, 'Ã¢â‚¬â€ ', '—')
WHERE content LIKE '%Ã¢â‚¬â€ %';

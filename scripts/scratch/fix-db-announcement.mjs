import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_PERSONAL_ACCESS_TOKEN || process.env.VITE_SUPABASE_ANON_KEY);

async function fix() {
  const { data, error } = await supabase.from('announcements').select('id, title');
  if (error) {
    console.error(error);
    return;
  }
  for (const row of data) {
    if (row.title.includes('Ã¢â€ â€™')) {
      const newTitle = row.title.replace(/Ã¢â€ â€™/g, '→');
      await supabase.from('announcements').update({ title: newTitle }).eq('id', row.id);
      console.log('Fixed:', row.id, newTitle);
    }
  }
}
fix();

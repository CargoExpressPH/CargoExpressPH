import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function check() {
  console.log('Checking payment_refunds...');
  const { data, error } = await supabase
    .from('payment_refunds')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(5);
  
  if (error) console.error(error);
  else console.log('Latest refunds:', data);
}
check();

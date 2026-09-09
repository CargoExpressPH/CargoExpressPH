import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '.env' });

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY);

async function fix() {
  console.log("Signing up...");
  const { data, error } = await supabase.auth.signUp({
    email: process.env.E2E_ADMIN_EMAIL,
    password: process.env.E2E_ADMIN_PASSWORD,
    options: {
      data: {
        full_name: 'Marlon Sarong (Admin)',
        legal_terms_accepted: true,
        legal_privacy_accepted: true,
        legal_terms_version: '2026-08-22',
        legal_privacy_version: '2026-08-22'
      }
    }
  });
  
  if (error) {
    console.error("SignUp failed:", error.message);
  } else {
    console.log("SignUp successful! User ID:", data.user?.id);
  }
}

fix();

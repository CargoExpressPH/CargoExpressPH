import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseKey = process.env.VITE_SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing Supabase credentials in .env");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function run() {
  const { data: trip, error: tripErr } = await supabase
    .from('trips')
    .select('id, trip_number, status')
    .eq('trip_number', 'TRIP-20260920-975')
    .single();

  if (tripErr || !trip) {
    console.error("Trip not found:", tripErr);
    return;
  }

  console.log("Trip found:", trip);

  const { data: orders, error: ordersErr } = await supabase
    .from('orders')
    .select('id, tracking_number, status')
    .eq('trip_id', trip.id);

  if (ordersErr) {
    console.error("Orders error:", ordersErr);
  } else {
    console.log("Connected orders:", orders.length);
    console.log(orders);
  }
}

run();

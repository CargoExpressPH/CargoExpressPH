import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const supabaseUrl = process.env.VITE_SUPABASE_URL;
// Need service role key to bypass RLS for hard deletes
const supabaseKey = process.env.VITE_SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

async function run() {
  const tripNumbers = ['TRIP-20260920-975', 'TRIP-20260921-884'];

  for (const tripNumber of tripNumbers) {
    console.log(`\nProcessing ${tripNumber}...`);
    
    // Find the trip
    const { data: trip, error: tripErr } = await supabase
      .from('trips')
      .select('id')
      .eq('trip_number', tripNumber)
      .single();

    if (tripErr || !trip) {
      console.error(`❌ Trip not found: ${tripNumber}`, tripErr);
      continue;
    }
    console.log(`✅ Found trip ID: ${trip.id}`);

    // Find and delete connected orders
    const { data: orders, error: ordersErr } = await supabase
      .from('orders')
      .select('id')
      .eq('trip_id', trip.id);
      
    if (orders && orders.length > 0) {
      console.log(`🗑️ Deleting ${orders.length} connected orders...`);
      const { error: delOrdersErr } = await supabase
        .from('orders')
        .delete()
        .eq('trip_id', trip.id);
        
      if (delOrdersErr) {
        console.error(`❌ Failed to delete orders:`, delOrdersErr);
        continue;
      }
      console.log(`✅ Orders deleted.`);
    } else {
      console.log(`ℹ️ No connected orders found.`);
    }
    
    // Delete the trip
    console.log(`🗑️ Deleting trip...`);
    const { error: delTripErr } = await supabase
      .from('trips')
      .delete()
      .eq('id', trip.id);
      
    if (delTripErr) {
      console.error(`❌ Failed to delete trip:`, delTripErr);
    } else {
      console.log(`✅ Trip ${tripNumber} successfully deleted.`);
    }
  }
}

run();

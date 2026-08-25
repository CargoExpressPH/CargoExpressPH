const fs = require('fs');
const file = 'src/lib/database.js';
let code = fs.readFileSync(file, 'utf8');

const target = `export const getTrips = async (statusFilter) => {
  let query = supabase
    .from('trips')
    .select('*')
    .order('created_at', { ascending: false });

  if (statusFilter === 'active') {
    query = query.in('status', ['scheduled', 'in_progress']);
  } else if (statusFilter) {
    query = query.eq('status', statusFilter);
  }`;

const replacement = `export const getTrips = async (statusFilter) => {
  let query = supabase
    .from('trips')
    .select('*');

  if (statusFilter === 'active') {
    // Only 'scheduled' trips (not in_progress) that are today or in the future
    const todayStr = new Date(new Date().getTime() - (new Date().getTimezoneOffset() * 60000)).toISOString().split('T')[0];
    query = query
      .in('status', ['scheduled'])
      .gte('departure_date', todayStr)
      .order('departure_date', { ascending: true }); // Earliest first
  } else {
    if (statusFilter) {
      query = query.eq('status', statusFilter);
    }
    // For admins seeing all trips, order newest created first
    query = query.order('created_at', { ascending: false });
  }`;

code = code.replace(target, replacement);
fs.writeFileSync(file, code);

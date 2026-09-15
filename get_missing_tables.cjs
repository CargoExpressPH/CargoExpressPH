const fs = require('fs');
const rawOutput = fs.readFileSync('schema_output.txt', 'utf-8');
const data = JSON.parse(rawOutput);

const targets = ['payment_refunds', 'photo_cleanup_queue', 'photo_storage_events', 'photo_storage_settings', 'company_information', 'notifications', 'orders', 'payment_attempts', 'payment_transactions', 'trips', 'legal_consents', 'notification_delivery_jobs'];

targets.forEach(t => {
  console.log(`\nTable: ${t}`);
  data.rows.filter(r => r.table_name === t).forEach(r => {
    console.log(`  ${r.column_name} (${r.data_type}): ${r.col_desc || 'No DB desc'}`);
  });
});

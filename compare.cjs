const fs = require('fs');

const manuscript = {
  activity_logs: [
    { name: "id", type: "uuid" },
    { name: "admin_id", type: "uuid" },
    { name: "admin_name", type: "text" },
    { name: "module", type: "text" },
    { name: "action", type: "text" },
    { name: "record_type", type: "text" },
    { name: "record_id", type: "uuid" },
    { name: "record_ref", type: "text" },
    { name: "previous_value", type: "jsonb" },
    { name: "new_value", type: "jsonb" },
    { name: "details", type: "text" },
    { name: "created_at", type: "timestamptz" },
    { name: "client_event_id", type: "uuid" },
  ],
  announcements: [
    { name: "id", type: "uuid" },
    { name: "title", type: "varchar" },
    { name: "content", type: "text" },
    { name: "author_id", type: "uuid" },
    { name: "is_active", type: "bool" },
    { name: "created_at", type: "timestamptz" },
    { name: "updated_at", type: "timestamptz" },
    { name: "comments", type: "jsonb" },
    { name: "send_email", type: "bool" },
    { name: "emailed_at", type: "timestamptz" },
  ],
  chat_messages: [
    { name: "id", type: "uuid" },
    { name: "conversation_id", type: "uuid" },
    { name: "sender_id", type: "uuid" },
    { name: "sender_role", type: "varchar" },
    { name: "message", type: "text" },
    { name: "is_read", type: "bool" },
    { name: "created_at", type: "timestamptz" },
  ],
  company_information: [
    { name: "id", type: "uuid" },
    { name: "name", type: "text" },
    { name: "short_description", type: "text" },
    { name: "long_description", type: "text" },
    { name: "banner_image_url", type: "text" },
    { name: "banner_title", type: "text" },
    { name: "banner_description", type: "text" },
    { name: "banner_button_text", type: "text" },
    { name: "banner_button_link", type: "text" },
    { name: "email", type: "text" },
    { name: "facebook", type: "text" },
    { name: "messenger", type: "text" },
    { name: "website", type: "text" },
    { name: "smart_phone", type: "text" },
    { name: "globe_phone", type: "text" },
    { name: "manila_address", type: "text" },
    { name: "bohol_address", type: "text" },
    { name: "created_at", type: "timestamptz" },
    { name: "updated_at", type: "timestamptz" },
    { name: "default_price_per_kg", type: "numeric" },
  ],
  contact_inquiries: [
    { name: "id", type: "uuid" },
    { name: "name", type: "text" },
    { name: "phone", type: "text" },
    { name: "message", type: "text" },
    { name: "status", type: "text" },
    { name: "created_at", type: "timestamptz" },
    { name: "contact_phone", type: "text" },
    { name: "contact_email", type: "text" },
    { name: "assigned_admin_id", type: "uuid" },
    { name: "first_response_at", type: "timestamptz" },
    { name: "resolved_at", type: "timestamptz" },
    { name: "push_dispatched_at", type: "timestamptz" },
    { name: "push_dispatch_started_at", type: "timestamptz" },
    { name: "push_dispatch_claim_id", type: "uuid" },
    { name: "ip", type: "text" },
    { name: "wants_announcements", type: "bool" },
  ],
  conversations: [
    { name: "id", type: "uuid" },
    { name: "customer_id", type: "uuid" },
    { name: "created_at", type: "timestamptz" },
    { name: "status", type: "text" },
    { name: "escalated", type: "bool" },
    { name: "first_response_at", type: "timestamptz" },
    { name: "last_customer_message_at", type: "timestamptz" },
    { name: "resolved_at", type: "timestamptz" },
    { name: "bot_resolved", type: "bool" },
  ],
  customer_feedback: [
    { name: "id", type: "uuid" },
    { name: "order_id", type: "uuid" },
    { name: "customer_id", type: "uuid" },
    { name: "rating", type: "int4" },
    { name: "message", type: "text" },
    { name: "is_hidden", type: "bool" },
    { name: "created_at", type: "timestamptz" },
  ],
  notification_delivery_attempts: [
    { name: "id", type: "uuid" },
    { name: "notification_id", type: "uuid" },
    { name: "user_id", type: "uuid" },
    { name: "device_token_id", type: "uuid" },
    { name: "status", type: "varchar" },
    { name: "provider_message_id", type: "text" },
    { name: "error_message", type: "text" },
    { name: "attempted_at", type: "timestamptz" },
  ],
  notifications: [
    { name: "id", type: "uuid" },
    { name: "user_id", type: "uuid" },
    { name: "message", type: "text" },
    { name: "type", type: "varchar" },
    { name: "reference_id", type: "uuid" },
    { name: "is_read", type: "bool" },
    { name: "created_at", type: "timestamptz" },
  ],
  order_status_events: [
    { name: "id", type: "uuid" },
    { name: "order_id", type: "uuid" },
    { name: "status", type: "varchar" },
    { name: "changed_at", type: "timestamptz" },
    { name: "changed_by", type: "uuid" },
    { name: "note", type: "text" },
  ],
  orders: [
    { name: "id", type: "uuid" },
    { name: "user_id", type: "uuid" },
    { name: "trip_id", type: "uuid" },
    { name: "origin", type: "varchar" },
    { name: "destination", type: "varchar" },
    { name: "tracking_number", type: "varchar" },
    { name: "sender_name", type: "varchar" },
    { name: "sender_phone", type: "varchar" },
    { name: "sender_address", type: "text" },
    { name: "receiver_name", type: "varchar" },
    { name: "receiver_phone", type: "varchar" },
    { name: "receiver_address", type: "text" },
    { name: "package_description", type: "text" },
    { name: "actual_weight", type: "numeric" },
    { name: "shipping_cost", type: "numeric" },
    { name: "payer_type", type: "varchar" },
    { name: "payment_method", type: "varchar" },
    { name: "payment_status", type: "varchar" },
    { name: "amount_paid", type: "numeric" },
    { name: "remaining_balance", type: "numeric" },
    { name: "promised_payment_date", type: "date" },
    { name: "status", type: "varchar" },
    { name: "notes", type: "text" },
    { name: "created_at", type: "timestamptz" },
    { name: "updated_at", type: "timestamptz" },
    { name: "sender_facebook", type: "text" },
    { name: "sender_city", type: "text" },
    { name: "receiver_facebook", type: "text" },
    { name: "receiver_city", type: "text" },
    { name: "receiver_province", type: "text" },
    { name: "sender_province", type: "text" },
    { name: "pickup_photos", type: "jsonb" },
    { name: "delivery_photos", type: "jsonb" },
    { name: "payment_reference", type: "varchar" },
    { name: "service_area_status", type: "text" },
    { name: "service_area_remarks", type: "text" },
    { name: "featured_on_website", type: "bool" },
    { name: "featured_title", type: "text" },
    { name: "featured_caption", type: "text" },
    { name: "featured_image_type", type: "text" },
    { name: "featured_at", type: "timestamptz" },
    { name: "reassignment_history", type: "jsonb" },
    { name: "cancellation_details", type: "jsonb" },
    { name: "payment_preference", type: "text" },
    { name: "last_reminder_sent_at", type: "timestampz" },
  ],
  payment_attempts: [
    { name: "id", type: "uuid" },
    { name: "source_id", type: "text" },
    { name: "order_id", type: "uuid" },
    { name: "amount", type: "numeric" },
    { name: "description", type: "text" },
    { name: "status", type: "text" },
    { name: "payment_id", type: "text" },
    { name: "payment_status", type: "text" },
    { name: "actual_weight", type: "numeric" },
    { name: "payer_type", type: "varchar" },
    { name: "pickup_photos", type: "jsonb" },
    { name: "last_error", type: "text" },
    { name: "reconciled_at", type: "timestamptz" },
    { name: "created_by", type: "uuid" },
    { name: "created_at", type: "timestamptz" },
    { name: "updated_at", type: "timestamptz" },
    { name: "payment_type", type: "text" },
    { name: "estimated_cost", type: "numeric" },
  ],
  payment_transactions: [
    { name: "id", type: "uuid" },
    { name: "order_id", type: "uuid" },
    { name: "amount", type: "numeric" },
    { name: "payment_method", type: "text" },
    { name: "transaction_reference", type: "text" },
    { name: "payment_status", type: "text" },
    { name: "admin_id", type: "uuid" },
    { name: "admin_name", type: "text" },
    { name: "notes", type: "text" },
    { name: "receipt_url", type: "text" },
  ],
  profiles: [
    { name: "id", type: "uuid" },
    { name: "name", type: "varchar" },
    { name: "email", type: "varchar" },
    { name: "phone", type: "varchar" },
    { name: "address_lot_block", type: "varchar" },
    { name: "address_street", type: "varchar" },
    { name: "address_barangay", type: "varchar" },
    { name: "address_city", type: "varchar" },
    { name: "address_province", type: "varchar" },
    { name: "role", type: "varchar" },
    { name: "created_at", type: "timestamptz" },
    { name: "updated_at", type: "timestamptz" },
    { name: "facebook_name", type: "text" },
    { name: "address_landmark", type: "text" },
    { name: "wants_announcements", type: "bool" },
  ],
  trips: [
    { name: "id", type: "uuid" },
    { name: "trip_number", type: "varchar" },
    { name: "origin", type: "varchar" },
    { name: "destination", type: "varchar" },
    { name: "departure_date", type: "timestamptz" },
    { name: "arrival_date", type: "timestamptz" },
    { name: "capacity", type: "int" },
    { name: "price_per_kg", type: "numeric" },
    { name: "status", type: "char" },
    { name: "created_by", type: "uuid" },
    { name: "created_at", type: "timestamptz" },
    { name: "updated_at", type: "timestamptz" },
    { name: "departure_at", type: "timestamptz" },
  ],
  user_device_tokens: [
    { name: "id", type: "uuid" },
    { name: "user_id", type: "uuid" },
    { name: "token", type: "text" },
    { name: "created_at", type: "timestamptz" },
    { name: "device_id", type: "text" },
  ],
  legal_consents: [
    { name: "id", type: "uuid" },
    { name: "user_id", type: "uuid" },
    { name: "document_type", type: "text" },
    { name: "document_version", type: "text" },
    { name: "accepted_at", type: "text" },
    { name: "source", type: "text" },
  ],
  legal_documents: [
    { name: "document_type", type: "text" },
    { name: "version", type: "text" },
    { name: "url_path", type: "text" },
    { name: "effective_at", type: "timestamptz" },
    { name: "published_at", type: "timestamptz" },
    { name: "is_current", type: "bool" },
  ],
  notification_delivery_jobs: [
    { name: "id", type: "uuid" },
    { name: "notification_id", type: "uuid" },
    { name: "user_id", type: "uuid" },
    { name: "device_token_id", type: "uuid" },
    { name: "dedupe_key", type: "text" },
    { name: "status", type: "text" },
  ],
};

const rawOutput = fs.readFileSync('schema_output.txt', 'utf-8');
const data = JSON.parse(rawOutput);

const dbTables = {};
data.rows.forEach(row => {
  if (!dbTables[row.table_name]) {
    dbTables[row.table_name] = {};
  }
  let dtype = row.data_type;
  if (dtype === 'character varying') dtype = 'varchar';
  if (dtype === 'timestamp with time zone') dtype = 'timestamptz';
  if (dtype === 'timestamp without time zone') dtype = 'timestamp';
  if (dtype === 'integer') dtype = 'int4';
  if (dtype === 'boolean') dtype = 'bool';
  if (dtype === 'character') dtype = 'char';
  
  dbTables[row.table_name][row.column_name] = {
    type: dtype,
    desc: row.col_desc
  };
});

let report = `# Chapter 2 Database Comparison Report
Inspection Date: ${new Date().toISOString().split('T')[0]}
Source: Live database schema via Supabase CLI

`;

let missingInMs = [];
for (let tableName in dbTables) {
  if (!manuscript[tableName] && !tableName.startsWith('supabase_')) {
    missingInMs.push(tableName);
  }
}

report += `## 1. Verified Missing Tables (Present in DB, Missing in MS)\n`;
missingInMs.forEach(t => report += `- ${t}\n`);

report += `\n## 2. Obsolete Tables (Present in MS, Missing in DB)\n`;
let obsolete = [];
for (let tableName in manuscript) {
  if (!dbTables[tableName]) {
    obsolete.push(tableName);
    report += `- ${tableName}\n`;
  }
}

report += `\n## 3. Discrepancies in Existing Tables\n`;

const discrepancies = [];

for (let tableName in manuscript) {
  if (obsolete.includes(tableName)) continue;
  
  const msCols = manuscript[tableName];
  const dbCols = dbTables[tableName];
  
  const msColNames = msCols.map(c => c.name);
  const dbColNames = Object.keys(dbCols);
  
  const missingInDB = msColNames.filter(c => !dbColNames.includes(c));
  const missingInMS = dbColNames.filter(c => !msColNames.includes(c));
  
  if (missingInDB.length > 0 || missingInMS.length > 0) {
    report += `\n### Table: ${tableName}\n`;
    missingInDB.forEach(c => {
      report += `- **Missing from DB (No longer present)**: ${c}\n`;
      discrepancies.push({table: tableName, type: 'missing_in_db', col: c});
    });
    missingInMS.forEach(c => {
      report += `- **Missing from Manuscript (Added to DB)**: ${c}\n`;
      discrepancies.push({table: tableName, type: 'missing_in_ms', col: c});
    });
  }
  
  msCols.forEach(msCol => {
    if (missingInDB.includes(msCol.name)) return;
    const dbType = dbCols[msCol.name].type;
    const msTypeNormalized = msCol.type.toLowerCase().replace('int', 'int4');
    const dbTypeNormalized = dbType.toLowerCase().replace('int', 'int4');
    
    // Ignore boolean/bool and int4/int/integer matches
    if (msTypeNormalized !== dbTypeNormalized && 
        !(msTypeNormalized === 'timestampz' && dbTypeNormalized === 'timestamptz') &&
        !(msTypeNormalized === 'date' && dbTypeNormalized === 'timestamptz') && // often mapped this way
        !(msTypeNormalized === 'text' && dbTypeNormalized === 'varchar') &&
        !(msTypeNormalized === 'varchar' && dbTypeNormalized === 'text')) {
      report += `\n### Table: ${tableName}\n`;
      report += `- **Type Mismatch** for \`${msCol.name}\`: MS says \`${msCol.type}\`, DB says \`${dbType}\`\n`;
      discrepancies.push({table: tableName, type: 'type_mismatch', col: msCol.name, msType: msCol.type, dbType});
    }
  });
}

fs.writeFileSync('CHAPTER_2_DATABASE_COMPARISON_REPORT.md', report);
console.log('Report generated.');

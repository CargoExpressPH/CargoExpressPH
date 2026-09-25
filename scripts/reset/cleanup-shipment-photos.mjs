#!/usr/bin/env node
// Shipment-photo cleanup through the SUPPORTED Storage API — NOT EXECUTED.
//
// Part of the fresh-start plan in DATABASE_SIMPLIFICATION_AND_RESET_REVIEW.md.
// Storage metadata (storage.objects) must never be deleted with SQL: that
// orphans the underlying files. This script lists and removes objects with
// supabase-js `storage.from(bucket).list/remove`, which deletes the file and
// its metadata together.
//
// Scope: ONLY the private `cargo-photos` bucket, ONLY the shipment-evidence
// folders below. Company website assets (`company-assets` bucket) are never
// listed or touched.
//
// Modes:
//   --mode=orphans  remove only objects no database row references
//                   (safe at any time; the default)
//   --mode=all      remove every shipment photo; refused unless the database
//                   reset has already emptied orders/payment_transactions
// Dry run is the default. Nothing is deleted without --execute.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (server secret — never a
// VITE_ variable). Object names are not printed, only counts.
//
//   node scripts/reset/cleanup-shipment-photos.mjs                  # dry run, orphans
//   node scripts/reset/cleanup-shipment-photos.mjs --mode=all       # dry run, all
//   node scripts/reset/cleanup-shipment-photos.mjs --mode=all --execute
import { createClient } from '@supabase/supabase-js';

const BUCKET = 'cargo-photos';
const FOLDERS = ['pickup-proofs', 'delivery-proofs', 'receipts']; // src/lib/storage.js makePhotoPath()
const args = new Set(process.argv.slice(2));
const mode = [...args].find(a => a.startsWith('--mode='))?.split('=')[1] || 'orphans';
const execute = args.has('--execute');
if (!['orphans', 'all'].includes(mode)) throw new Error(`Unknown --mode=${mode}`);

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
const supabase = createClient(url, key, { auth: { persistSession: false } });

async function listAll(prefix) {
  const out = [];
  const walk = async (dir) => {
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await supabase.storage.from(BUCKET).list(dir, { limit: 1000, offset });
      if (error) throw error;
      for (const entry of data) {
        const path = `${dir}/${entry.name}`;
        if (entry.id === null) await walk(path);   // a folder
        else out.push(path);
      }
      if (data.length < 1000) break;
    }
  };
  await walk(prefix);
  return out;
}

async function referencedText() {
  // Every place a shipment photo can be referenced (descriptor JSON or URL).
  const chunks = [];
  const page = async (table, cols) => {
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase.from(table).select(cols).range(from, from + 999);
      if (error) throw error;
      chunks.push(JSON.stringify(data));
      if (data.length < 1000) break;
    }
  };
  await page('orders', 'pickup_photos, delivery_photos');
  await page('payment_attempts', 'pickup_photos');
  await page('payment_transactions', 'receipt_url');
  return chunks.join('\n');
}

const { count: orderCount, error: oErr } = await supabase.from('orders').select('id', { count: 'exact', head: true });
if (oErr) throw oErr;
const { count: txCount, error: tErr } = await supabase.from('payment_transactions').select('id', { count: 'exact', head: true });
if (tErr) throw tErr;
if (mode === 'all' && (orderCount > 0 || txCount > 0)) {
  throw new Error(`--mode=all refused: database still has ${orderCount} order(s) and ${txCount} payment(s). Run the approved database reset first, or use --mode=orphans.`);
}

const refs = mode === 'orphans' ? await referencedText() : '';
let total = 0;
const toDelete = [];
for (const folder of FOLDERS) {
  const paths = await listAll(folder);
  const selected = mode === 'all' ? paths : paths.filter(p => !refs.includes(p));
  total += paths.length;
  toDelete.push(...selected);
  console.log(`${folder}: ${paths.length} object(s), ${selected.length} selected for removal`);
}
console.log(`mode=${mode} total=${total} selected=${toDelete.length} execute=${execute}`);

if (!execute) {
  console.log('Dry run only. Re-run with --execute after the owner approves.');
  process.exit(0);
}
for (let i = 0; i < toDelete.length; i += 100) {
  const batch = toDelete.slice(i, i + 100);
  const { error } = await supabase.storage.from(BUCKET).remove(batch);
  if (error) throw error;
  console.log(`removed ${Math.min(i + 100, toDelete.length)}/${toDelete.length}`);
}

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const read = (path) => readFileSync(path, 'utf8');
const storage = read('src/lib/storage.js');
const storeFunction = read('supabase/functions/store-photo-fallback/index.ts');
const getFunction = read('supabase/functions/get-photo-fallback/index.ts');
const deleteFunctionPath = 'supabase/functions/delete-photo-fallback/index.ts';
const migration = read('supabase/migrations/20260831160000_complete_photo_fallback_lifecycle.sql');
const pickup = read('src/components/ui/PickupModal.jsx');
const delivery = read('src/components/ui/DeliveryModal.jsx');
const additional = read('src/components/ui/AdditionalPaymentModal.jsx');
const adminOrder = read('src/pages/admin/OrderDetailPage.jsx');
const customerOrder = read('src/pages/customer/OrderDetailPage.jsx');

assert.match(storage, /receipts:\s*'receipt'/);
assert.match(storage, /delete-photo-fallback/);
assert.match(storage, /Promise\.allSettled\(photos\.map/);
assert.match(storage, /folder === 'receipts' \? `\$\{timestamp\}-\$\{seq\}`/);

assert.match(storeFunction, /\['pickup', 'delivery', 'receipt'\]/);
assert.match(storeFunction, /const docId = `\$\{order_id\}_\$\{folder\}_\$\{safeFileName/);
assert.doesNotMatch(storeFunction, /crypto\.randomUUID/);

const authorizationIndex = getFunction.indexOf('if (!user && !isExactPublicFeature)');
const firestoreFetchIndex = getFunction.indexOf('https://firestore.googleapis.com');
assert.ok(authorizationIndex > 0 && authorizationIndex < firestoreFetchIndex,
  'Fallback reads must authorize before retrieving the Firestore document');
assert.match(getFunction, /descriptorPath\(selectedPhoto\) === firestore_path/);
assert.match(getFunction, /firestoreString\(doc, 'order_id'\) !== orderId/);

assert.ok(existsSync(deleteFunctionPath), 'Missing fallback deletion function');
const deleteFunction = read(deleteFunctionPath);
assert.match(deleteFunction, /profile\?\.role !== 'admin'/);
assert.match(deleteFunction, /method: 'DELETE'/);
assert.match(deleteFunction, /response\.status === 404/);

assert.match(migration, /is_featured_photo_path\(p_path TEXT\)/);
assert.match(migration, /public\.is_featured_photo_path\(name\)/);
assert.match(migration, /DROP FUNCTION IF EXISTS public\.is_featured_order_ref/);
assert.doesNotMatch(migration, /is_featured_order_ref\(\(storage\.foldername/);

for (const modal of [pickup, delivery, additional]) {
  assert.match(modal, /serializePhotoReference\(rResult\)/);
}
for (const modal of [pickup, delivery]) {
  assert.match(modal, /photoUrls\.map\(\(photo\) => deletePhoto\(photo\)\)/);
}
for (const page of [adminOrder, customerOrder]) {
  assert.match(page, /<ResolvedPhotoLink photo=\{tx\.receipt_url\}/);
}

console.log('Photo fallback contract tests passed.');

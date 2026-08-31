import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

const virtualSupabaseId = '\0photo-fallback-test-supabase';
const virtualCompressionId = '\0photo-fallback-test-compression';

const harnessPlugin = {
  name: 'photo-fallback-browser-harness',
  enforce: 'pre',
  resolveId(source, importer) {
    if (source === './supabase' && importer?.replaceAll('\\', '/').includes('/src/lib/storage.js')) {
      return virtualSupabaseId;
    }
    if (source === 'browser-image-compression') return virtualCompressionId;
    return null;
  },
  load(id) {
    if (id === virtualSupabaseId) return 'export const supabase = globalThis.__testSupabase;';
    if (id === virtualCompressionId) return 'export default async (file) => file;';
    return null;
  },
  configureServer(server) {
    server.middlewares.use('/__photo_fallback_test__', (_req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<!doctype html><html><body>photo fallback harness</body></html>');
    });
  },
};

const server = await createServer({
  configFile: false,
  root: process.cwd(),
  appType: 'custom',
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 41739, strictPort: true },
  plugins: [harnessPlugin],
});

let browser;
try {
  await server.listen();
  const address = server.httpServer.address();
  const port = typeof address === 'object' && address ? address.port : 5173;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/__photo_fallback_test__`);

  const result = await page.evaluate(async () => {
    const state = {
      config: {},
      uploadCalls: 0,
      uploads: [],
      removals: [],
      functionCalls: [],
    };
    const reset = (config = {}) => {
      state.config = config;
      state.uploadCalls = 0;
      state.uploads = [];
      state.removals = [];
      state.functionCalls = [];
    };

    globalThis.__testSupabase = {
      storage: {
        from: (bucket) => ({
          upload: async (path) => {
            state.uploadCalls += 1;
            state.uploads.push({ bucket, path });
            const failed = (state.config.failUploadCalls || []).includes(state.uploadCalls);
            return failed ? { error: { message: 'forced storage outage' } } : { error: null };
          },
          remove: async (paths) => {
            state.removals.push({ bucket, paths });
            return { error: null };
          },
          createSignedUrl: async (path) => ({
            data: { signedUrl: `https://signed.test/${bucket}/${path}` },
            error: null,
          }),
          getPublicUrl: (path) => ({ data: { publicUrl: `https://public.test/${bucket}/${path}` } }),
        }),
      },
      functions: {
        invoke: async (name, options) => {
          state.functionCalls.push({ name, body: options?.body });
          if (name === 'store-photo-fallback') {
            if (state.config.failStore) return { data: null, error: { message: 'forced fallback failure' } };
            const safeName = String(options.body.file_name).replace(/[^a-zA-Z0-9_-]/g, '_');
            return {
              data: {
                firestore_path: `photoFallbacks/${options.body.order_id}_${options.body.folder}_${safeName}`,
                created_at: '2026-08-31T00:00:00.000Z',
              },
              error: null,
            };
          }
          if (name === 'get-photo-fallback') {
            return { data: { data_url: 'data:image/jpeg;base64,/9j/' }, error: null };
          }
          if (name === 'delete-photo-fallback') return { data: { deleted: true }, error: null };
          return { data: null, error: { message: `unexpected function ${name}` } };
        },
      },
    };

    const storage = await import('/src/lib/storage.js?photo-fallback-browser-test');
    const orderId = '00000000-0000-4000-8000-000000000001';
    const photoFile = () => new File([new Uint8Array([255, 216, 255, 217])], 'proof.jpg', { type: 'image/jpeg' });

    reset();
    const primary = await storage.uploadPhoto(photoFile(), 'receipts', 'CE-TEST', 1, orderId);
    const primaryOnly = primary.type === 'supabase_storage'
      && state.functionCalls.length === 0
      && primary.path.startsWith('receipts/CE-TEST/receipts-');

    await new Promise(resolve => setTimeout(resolve, 2));
    const secondReceipt = await storage.uploadPhoto(photoFile(), 'receipts', 'CE-TEST', 1, orderId);
    const receiptsAreUnique = primary.path !== secondReceipt.path;

    reset({ failUploadCalls: [1] });
    const fallback = await storage.uploadPhoto(photoFile(), 'receipts', 'CE-TEST', 1, orderId);
    const storeCall = state.functionCalls.find(call => call.name === 'store-photo-fallback');
    const receiptFallback = fallback.type === 'firestore_fallback' && storeCall?.body?.folder === 'receipt';

    const resolved = await storage.resolvePhotoUrl(JSON.stringify(fallback));
    const serializedFallbackResolves = resolved === 'data:image/jpeg;base64,/9j/'
      && state.functionCalls.some(call => call.name === 'get-photo-fallback');

    await storage.deletePhoto(fallback);
    const fallbackDeletes = state.functionCalls.some(call => call.name === 'delete-photo-fallback');

    reset({ failUploadCalls: [2], failStore: true });
    let originalErrorPreserved = false;
    try {
      await storage.uploadMultiplePhotos(
        [photoFile(), photoFile()],
        'pickup-proofs',
        'CE-ROLLBACK',
        null,
        orderId,
      );
    } catch (error) {
      originalErrorPreserved = error.message.includes('forced storage outage');
    }
    const partialUploadRolledBack = state.removals.length === 1
      && state.removals[0].paths.length === 1
      && state.removals[0].paths[0].includes('pickup-1.jpg');

    reset({ failUploadCalls: [1] });
    let invalidRejected = false;
    try {
      await storage.uploadPhoto(new File(['not an image'], 'bad.txt', { type: 'text/plain' }), 'receipts', 'CE-TEST', 1, orderId);
    } catch (error) {
      invalidRejected = error.message.includes('Invalid file type');
    }
    const validationDoesNotFallback = invalidRejected && state.uploadCalls === 0 && state.functionCalls.length === 0;

    return {
      primaryOnly,
      receiptsAreUnique,
      receiptFallback,
      serializedFallbackResolves,
      fallbackDeletes,
      originalErrorPreserved,
      partialUploadRolledBack,
      validationDoesNotFallback,
    };
  });

  for (const [name, passed] of Object.entries(result)) {
    assert.equal(passed, true, `Browser fallback assertion failed: ${name}`);
  }
  console.log(`Photo fallback browser tests passed (${Object.keys(result).length} assertions).`);
} finally {
  await browser?.close();
  await server.close();
}

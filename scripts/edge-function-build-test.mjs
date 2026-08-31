import { build } from 'esbuild';

const entryPoints = [
  'supabase/functions/store-photo-fallback/index.ts',
  'supabase/functions/get-photo-fallback/index.ts',
  'supabase/functions/delete-photo-fallback/index.ts',
];

for (const entryPoint of entryPoints) {
  await build({
    entryPoints: [entryPoint],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    external: ['https://*'],
    logLevel: 'silent',
  });
}

console.log(`Edge Function build tests passed (${entryPoints.length} functions).`);

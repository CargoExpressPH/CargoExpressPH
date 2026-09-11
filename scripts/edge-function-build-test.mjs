import { build } from 'esbuild';
import fs from 'fs';
import path from 'path';

const functionsDir = 'supabase/functions';
const entryPoints = fs.readdirSync(functionsDir)
  .filter(f => fs.statSync(path.join(functionsDir, f)).isDirectory())
  .map(f => path.join(functionsDir, f, 'index.ts'))
  .filter(f => fs.existsSync(f));

console.log(`Found ${entryPoints.length} edge functions. Building...`);

for (const entryPoint of entryPoints) {
  try {
    await build({
      entryPoints: [entryPoint],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'neutral',
      external: ['https://*'],
      logLevel: 'silent',
    });
  } catch (error) {
    console.error(`Failed to build ${entryPoint}:`, error);
    process.exit(1);
  }
}

console.log(`Edge Function build tests passed (${entryPoints.length} functions).`);

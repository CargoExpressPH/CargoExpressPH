// Loads the LIVE schema snapshot (live-schema.sql) into an in-memory PGlite
// and optionally applies migration files on top. Isolated: no network, no
// production connection. See snapshot-live-schema.py for how the snapshot
// is produced (catalog SELECTs only).
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '..', '..');

export async function makeDb({ migrations = [] } = {}) {
  const db = new PGlite({ extensions: { pgcrypto, uuid_ossp, pg_trgm } });
  await db.exec(readFileSync(path.join(HERE, 'bootstrap.sql'), 'utf8'));
  await db.exec(readFileSync(path.join(HERE, 'live-schema.sql'), 'utf8'));
  await db.exec(`SET search_path TO public, extensions`);
  for (const m of migrations) {
    // A bare name is read from supabase/migrations/; a path containing '/' is repo-relative.
    const file = m.includes('/') ? path.join(REPO, m) : path.join(REPO, 'supabase/migrations', m);
    await db.exec(readFileSync(file, 'utf8'));
  }
  return db;
}

/** Run fn inside a transaction impersonating a user (auth.uid()) and role. */
export async function as(db, uid, role, fn) {
  return db.transaction(async (tx) => {
    await tx.query(`SELECT set_config('app.uid', $1, true), set_config('app.role', $2, true)`, [uid || '', role]);
    return fn(tx);
  });
}

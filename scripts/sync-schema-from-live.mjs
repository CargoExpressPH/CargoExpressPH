#!/usr/bin/env node
/**
 * sync-schema-from-live.mjs
 * ─────────────────────────
 * Pulls the LIVE Supabase database schema (public) and writes it to
 * supabase/schema.sql.  Uses the Management API **read-only** query
 * endpoint — absolutely nothing is written to the live database.
 *
 * Requirements: SUPABASE_PERSONAL_ACCESS_TOKEN in .env, Node ≥ 18 (native fetch).
 */

// Corporate/network proxy does SSL inspection — same workaround as deployment.js
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT       = path.resolve(__dirname, '..');

// ── Load .env ──────────────────────────────────────────────────────────
function loadEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach(line => {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) return;
    const [key, ...vals] = t.split('=');
    const k = key.trim();
    if (k && !process.env[k]) process.env[k] = vals.join('=').trim();
  });
}
loadEnv();

// The token variable is SUPABASE_PERSONAL_ACCESS_TOKEN — the name .env has
// always used. This script read `supabase_PAT`, a name that exists nowhere in
// the project, so it exited on line 1 every time it was run.
//
// SUPABASE_ACCESS_TOKEN is accepted as a second name because that is what the
// Supabase CLI itself reads, so a shell or CI job already exported for `npx
// supabase` can run this with no .env at all.
const PAT = process.env.SUPABASE_PERSONAL_ACCESS_TOKEN || process.env.SUPABASE_ACCESS_TOKEN;
if (!PAT) {
  console.error('❌  No access token found.');
  console.error('    Set SUPABASE_PERSONAL_ACCESS_TOKEN in .env (or export SUPABASE_ACCESS_TOKEN).');
  console.error('    Generate one at https://supabase.com/dashboard/account/tokens');
  process.exit(1);
}

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || '';
const refMatch = SUPABASE_URL.match(/https:\/\/([a-z0-9]+)\.supabase\.co/);
if (!refMatch) { console.error('❌  Cannot extract project ref from VITE_SUPABASE_URL'); process.exit(1); }
const PROJECT_REF = refMatch[1];
const API_BASE = `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;

// ── API helper ─────────────────────────────────────────────────────────
async function runQuery(sql) {
  const res = await fetch(API_BASE, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${PAT}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text}`);
  }
  return res.json();
}

// ── Queries ────────────────────────────────────────────────────────────

async function getTables() {
  return runQuery(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name;
  `);
}

async function getColumns() {
  return runQuery(`
    SELECT
      c.table_name,
      c.column_name,
      c.ordinal_position,
      c.column_default,
      c.is_nullable,
      CASE
        WHEN c.data_type = 'USER-DEFINED' THEN c.udt_name
        WHEN c.data_type = 'ARRAY' THEN c.udt_name
        WHEN c.character_maximum_length IS NOT NULL
          THEN c.data_type || '(' || c.character_maximum_length || ')'
        WHEN c.numeric_precision IS NOT NULL AND c.data_type = 'numeric'
          THEN 'DECIMAL(' || c.numeric_precision || ',' || COALESCE(c.numeric_scale, 0) || ')'
        ELSE c.data_type
      END AS full_type,
      c.data_type AS base_type
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
    ORDER BY c.table_name, c.ordinal_position;
  `);
}

// Use pg_constraint for accurate constraint-to-column mapping
async function getAllConstraints() {
  return runQuery(`
    SELECT
      c.conname,
      c.contype,
      cl.relname,
      pg_get_constraintdef(c.oid, true) AS cdef,
      c.confrelid::regclass::text AS ref_table,
      c.confdeltype,
      (SELECT array_agg(a.attname ORDER BY ord)
       FROM unnest(c.conkey) WITH ORDINALITY AS u(attnum, ord)
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = u.attnum
      ) AS col_names,
      CASE WHEN c.confrelid > 0 THEN
        (SELECT array_agg(a.attname ORDER BY ord)
         FROM unnest(c.confkey) WITH ORDINALITY AS u(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = u.attnum
        )
      END AS ref_col_names
    FROM pg_constraint c
    JOIN pg_class cl ON c.conrelid = cl.oid
    JOIN pg_namespace n ON cl.relnamespace = n.oid
    WHERE n.nspname = 'public'
    ORDER BY cl.relname, c.contype, c.conname;
  `);
}

async function getIndexes() {
  return runQuery(`
    SELECT tablename, indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = 'public'
    ORDER BY tablename, indexname;
  `);
}

async function getFunctions() {
  return runQuery(`
    SELECT
      p.proname AS function_name,
      pg_get_functiondef(p.oid) AS function_def
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p')
    ORDER BY p.proname;
  `);
}

async function getTriggers() {
  return runQuery(`
    SELECT
      tg.tgname AS trigger_name,
      c.relname AS table_name,
      pg_get_triggerdef(tg.oid, true) AS trigger_def
    FROM pg_trigger tg
    JOIN pg_class c ON tg.tgrelid = c.oid
    JOIN pg_namespace n ON c.relnamespace = n.oid
    WHERE n.nspname = 'public' AND NOT tg.tgisinternal
    ORDER BY c.relname, tg.tgname;
  `);
}

async function getRLSStatus() {
  return runQuery(`
    SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced
    FROM pg_class c
    JOIN pg_namespace n ON c.relnamespace = n.oid
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY c.relname;
  `);
}

async function getRLSPolicies() {
  return runQuery(`
    SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
    FROM pg_policies WHERE schemaname = 'public'
    ORDER BY tablename, policyname;
  `);
}

async function getRealtimePublications() {
  return runQuery(`
    SELECT p.pubname, pt.schemaname, pt.tablename
    FROM pg_publication p
    JOIN pg_publication_tables pt ON p.pubname = pt.pubname
    WHERE pt.schemaname = 'public'
    ORDER BY p.pubname, pt.tablename;
  `);
}

async function getExtensions() {
  return runQuery(`SELECT extname FROM pg_extension WHERE extname NOT IN ('plpgsql') ORDER BY extname;`);
}

async function getStorageBuckets() {
  return runQuery(`SELECT id, name, public, file_size_limit, allowed_mime_types FROM storage.buckets ORDER BY name;`);
}

async function getStoragePolicies() {
  return runQuery(`
    SELECT policyname, tablename, permissive, roles, cmd, qual, with_check
    FROM pg_policies WHERE schemaname = 'storage'
    ORDER BY tablename, policyname;
  `);
}

async function getCronJobs() {
  return runQuery(`SELECT jobid, schedule, command, nodename, database, active FROM cron.job ORDER BY jobid;`);
}

async function getColumnComments() {
  return runQuery(`
    SELECT c.relname AS table_name, a.attname AS column_name, d.description
    FROM pg_description d
    JOIN pg_class c ON d.objoid = c.oid
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = d.objsubid
    JOIN pg_namespace n ON c.relnamespace = n.oid
    WHERE n.nspname = 'public' AND d.objsubid > 0
    ORDER BY c.relname, a.attnum;
  `);
}

async function getFunctionPrivileges() {
  return runQuery(`
    SELECT
      p.proname AS fn_name,
      pg_catalog.pg_get_function_identity_arguments(p.oid) AS fn_args,
      has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_execute,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_execute,
      has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc_execute
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public'
    ORDER BY p.proname;
  `);
}

// ── Type mapping ───────────────────────────────────────────────────────

function pgTypeToSQL(fullType) {
  const typeMap = {
    'character varying': 'VARCHAR',
    'timestamp with time zone': 'TIMESTAMPTZ',
    'timestamp without time zone': 'TIMESTAMP',
    'boolean': 'BOOLEAN',
    'integer': 'INTEGER',
    'bigint': 'BIGINT',
    'smallint': 'SMALLINT',
    'text': 'TEXT',
    'uuid': 'UUID',
    'jsonb': 'JSONB',
    'json': 'JSON',
    'date': 'DATE',
    'numeric': 'NUMERIC',
    'real': 'REAL',
    'double precision': 'DOUBLE PRECISION',
  };
  if (fullType.startsWith('DECIMAL(')) return fullType;
  if (fullType.startsWith('character varying('))
    return fullType.replace('character varying', 'VARCHAR');
  return typeMap[fullType] || fullType.toUpperCase();
}

function fkDeleteAction(code) {
  const map = { a: '', r: ' ON DELETE RESTRICT', c: ' ON DELETE CASCADE', n: ' ON DELETE SET NULL', d: ' ON DELETE SET DEFAULT' };
  return map[code] || '';
}

// Parse PostgreSQL array text format '{a,b,c}' → ['a','b','c']
function pgArrayToJS(val) {
  if (!val || val === '{}') return [];
  if (Array.isArray(val)) return val;
  return val.replace(/^\{|\}$/g, '').split(',').map(s => s.trim());
}

// Normalize constraint rows from API format to usable JS objects
function normalizeConstraints(rows) {
  return rows.map(r => ({
    constraint_name: r.conname,
    constraint_type: r.contype,       // p=PK, f=FK, c=CHECK, u=UNIQUE
    table_name: r.relname,
    constraint_def: r.cdef,
    ref_table: r.ref_table,
    delete_rule: r.confdeltype?.trim() || '',
    column_names: pgArrayToJS(r.col_names),
    ref_column_names: pgArrayToJS(r.ref_col_names),
  }));
}

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  📥 Sync schema.sql FROM live Supabase DB (read-only)   ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`   Project ref: ${PROJECT_REF}`);
  console.log('   Direction:   LIVE DB → local schema.sql');
  console.log('   DB writes:   NONE (read-only queries only)\n');
  console.log('⏳ Querying live database schema...');

  const [
    tables, columns, constraints, indexes, functions, triggers,
    rlsStatus, rlsPolicies, realtimePubs, extensions,
    storageBuckets, storagePolicies, cronJobs, columnComments,
    fnPrivileges
  ] = await Promise.all([
    getTables(), getColumns(), getAllConstraints(), getIndexes(),
    getFunctions(), getTriggers(), getRLSStatus(), getRLSPolicies(),
    getRealtimePublications(), getExtensions(),
    getStorageBuckets(), getStoragePolicies(), getCronJobs(),
    getColumnComments(), getFunctionPrivileges(),
  ]);

  console.log(`   ✓ ${tables.length} tables`);
  console.log(`   ✓ ${columns.length} columns`);
  console.log(`   ✓ ${constraints.length} constraints`);
  console.log(`   ✓ ${functions.length} functions`);
  console.log(`   ✓ ${triggers.length} triggers`);
  console.log(`   ✓ ${rlsPolicies.length} RLS policies`);
  console.log(`   ✓ ${indexes.length} indexes`);
  console.log(`   ✓ ${extensions.length} extensions`);
  console.log(`   ✓ ${storageBuckets.length} storage buckets`);
  console.log(`   ✓ ${storagePolicies.length} storage policies`);
  console.log(`   ✓ ${cronJobs.length} cron jobs`);
  console.log(`   ✓ ${columnComments.length} column comments`);
  const restrictedFns = fnPrivileges.filter(f => !f.anon_execute || !f.auth_execute || !f.svc_execute);
  console.log(`   ✓ ${restrictedFns.length} restricted function grants`);

  // ── Organize by table ──
  const colsByTable = {};
  for (const col of columns) (colsByTable[col.table_name] ??= []).push(col);

  // Normalize and organize constraints by table
  const normalizedConstraints = normalizeConstraints(constraints);
  const consByTable = {};
  for (const con of normalizedConstraints) (consByTable[con.table_name] ??= []).push(con);

  const rlsByTable = {};
  for (const r of rlsStatus) rlsByTable[r.table_name] = r;

  const policiesByTable = {};
  for (const p of rlsPolicies) (policiesByTable[p.tablename] ??= []).push(p);

  const triggersByTable = {};
  for (const t of triggers) (triggersByTable[t.table_name] ??= []).push(t);

  const indexesByTable = {};
  for (const idx of indexes) (indexesByTable[idx.tablename] ??= []).push(idx);

  // ── Generate SQL ──
  console.log('\n📝 Generating schema.sql...');
  const lines = [];
  const now = new Date().toISOString().slice(0, 10);

  lines.push('-- ============================================================');
  lines.push('-- Cargo Express PH — Complete Supabase PostgreSQL Schema');
  lines.push('-- Single source-of-truth for the entire database.');
  lines.push(`-- Synced from LIVE database on ${now}`);
  lines.push('-- Run this in: Supabase Dashboard → SQL Editor → New Query');
  lines.push('-- ============================================================');
  lines.push('');

  // ── Extensions ──
  if (extensions.length > 0) {
    lines.push('');
    lines.push('-- ===================== EXTENSIONS =====================');
    for (const ext of extensions) {
      lines.push(`CREATE EXTENSION IF NOT EXISTS "${ext.extname}";`);
    }
    lines.push('');
  }

  // ── Tables ──
  let tableNum = 0;
  for (const table of tables) {
    tableNum++;
    const tname = table.table_name;
    const cols = colsByTable[tname] || [];
    const cons = consByTable[tname] || [];

    const pkCons = cons.filter(c => c.constraint_type === 'p');
    const fkCons = cons.filter(c => c.constraint_type === 'f');
    const checkCons = cons.filter(c => c.constraint_type === 'c');
    const uniqueCons = cons.filter(c => c.constraint_type === 'u');

    // Build sets for quick lookup
    const pkColNames = pkCons.length > 0 ? pkCons[0].column_names : [];
    const isSinglePK = pkColNames.length === 1;

    // Map: column -> FK constraint (for single-column inline FKs)
    const singleColFKs = {};
    for (const fk of fkCons) {
      if (fk.column_names.length === 1) {
        singleColFKs[fk.column_names[0]] = fk;
      }
    }

    // Map: column -> UNIQUE (for single-column inline UNIQUE)
    const singleColUniques = new Set();
    const multiColUniques = [];
    for (const u of uniqueCons) {
      if (u.column_names.length === 1) {
        singleColUniques.add(u.column_names[0]);
      } else {
        multiColUniques.push(u);
      }
    }

    // Map: column -> CHECK constraints (single-column checks only)
    // A check is single-column if it references exactly one column from column_names
    const singleColChecks = {};
    const tableChecks = [];
    for (const ch of checkCons) {
      if (ch.column_names.length === 1) {
        const col = ch.column_names[0];
        (singleColChecks[col] ??= []).push(ch);
      } else {
        tableChecks.push(ch);
      }
    }

    lines.push('');
    lines.push(`-- ===================== ${tableNum}. ${tname.toUpperCase()} =====================`);
    lines.push(`CREATE TABLE IF NOT EXISTS ${tname} (`);

    const colDefs = [];
    for (const col of cols) {
      let def = `  ${col.column_name} ${pgTypeToSQL(col.full_type)}`;

      // PRIMARY KEY inline (single-col only)
      if (isSinglePK && pkColNames[0] === col.column_name) {
        def += ' PRIMARY KEY';
      }

      // NOT NULL (skip if PK — PK implies NOT NULL)
      if (col.is_nullable === 'NO' && !pkColNames.includes(col.column_name)) {
        def += ' NOT NULL';
      }

      // UNIQUE inline
      if (singleColUniques.has(col.column_name)) {
        def += ' UNIQUE';
      }

      // DEFAULT
      if (col.column_default) {
        def += ` DEFAULT ${col.column_default}`;
      }

      // FK inline (single-column)
      const fk = singleColFKs[col.column_name];
      if (fk) {
        def += ` REFERENCES ${fk.ref_table}(${fk.ref_column_names[0]})`;
        def += fkDeleteAction(fk.delete_rule);
      }

      // CHECK inline (single-column)
      const colChecks = singleColChecks[col.column_name] || [];
      for (const ch of colChecks) {
        def += ` CHECK ${ch.constraint_def.replace(/^CHECK\s*/i, '')}`;
      }

      colDefs.push(def);
    }

    // Multi-column PKs
    if (pkColNames.length > 1) {
      colDefs.push(`  PRIMARY KEY (${pkColNames.join(', ')})`);
    }

    // Multi-column FKs
    for (const fk of fkCons) {
      if (fk.column_names.length > 1) {
        colDefs.push(`  FOREIGN KEY (${fk.column_names.join(', ')}) REFERENCES ${fk.ref_table}(${fk.ref_column_names.join(', ')})${fkDeleteAction(fk.delete_rule)}`);
      }
    }

    // Multi-column UNIQUE
    for (const u of multiColUniques) {
      colDefs.push(`  UNIQUE (${u.column_names.join(', ')})`);
    }

    // Table-level CHECK constraints (multi-column)
    for (const ch of tableChecks) {
      colDefs.push(`  CONSTRAINT ${ch.constraint_name} ${ch.constraint_def}`);
    }

    lines.push(colDefs.join(',\n'));
    lines.push(');');
    lines.push('');
  }

  // ── Functions ──
  if (functions.length > 0) {
    lines.push('');
    lines.push('-- ============================================================');
    lines.push('-- FUNCTIONS');
    lines.push('-- ============================================================');
    for (const fn of functions) {
      lines.push('');
      let fnDef = fn.function_def;
      fnDef = fnDef.replace(/^CREATE FUNCTION/i, 'CREATE OR REPLACE FUNCTION');
      fnDef = fnDef.replace(/^CREATE PROCEDURE/i, 'CREATE OR REPLACE PROCEDURE');
      lines.push(fnDef);
      lines.push('');
    }
  }

  // ── Function Privileges (REVOKE/GRANT for restricted functions) ──
  if (restrictedFns.length > 0) {
    lines.push('');
    lines.push('-- ============================================================');
    lines.push('-- FUNCTION PRIVILEGES');
    lines.push('-- (Only emitted for functions with non-default access.)');
    lines.push('-- (Default: anon, authenticated, service_role all have EXECUTE)');
    lines.push('-- ============================================================');
    for (const f of restrictedFns) {
      const sig = f.fn_args ? `public.${f.fn_name}(${f.fn_args})` : `public.${f.fn_name}()`;
      lines.push('');
      // Revoke from all, then grant back selectively
      lines.push(`REVOKE ALL ON FUNCTION ${sig} FROM PUBLIC;`);
      lines.push(`REVOKE ALL ON FUNCTION ${sig} FROM anon;`);
      lines.push(`REVOKE ALL ON FUNCTION ${sig} FROM authenticated;`);
      if (f.svc_execute)  lines.push(`GRANT EXECUTE ON FUNCTION ${sig} TO service_role;`);
      if (f.auth_execute)  lines.push(`GRANT EXECUTE ON FUNCTION ${sig} TO authenticated;`);
      if (f.anon_execute)  lines.push(`GRANT EXECUTE ON FUNCTION ${sig} TO anon;`);
    }
    lines.push('');
  }

  // ── Triggers ──
  if (triggers.length > 0) {
    lines.push('');
    lines.push('-- ============================================================');
    lines.push('-- TRIGGERS');
    lines.push('-- ============================================================');
    const seen = new Set();
    for (const t of triggers) {
      const key = `${t.table_name}.${t.trigger_name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push('');
      lines.push(`DROP TRIGGER IF EXISTS ${t.trigger_name} ON public.${t.table_name};`);
      lines.push(`${t.trigger_def};`);
    }
    lines.push('');
  }

  // ── Indexes (exclude PK and unique-constraint-backing indexes) ──
  const constraintNames = new Set(normalizedConstraints.map(c => c.constraint_name));
  const customIndexes = [];
  for (const table of tables) {
    const tIndexes = indexesByTable[table.table_name] || [];
    for (const idx of tIndexes) {
      if (idx.indexname.endsWith('_pkey')) continue;
      if (constraintNames.has(idx.indexname)) continue;
      customIndexes.push(idx);
    }
  }

  if (customIndexes.length > 0) {
    lines.push('');
    lines.push('-- ============================================================');
    lines.push('-- INDEXES');
    lines.push('-- ============================================================');
    for (const idx of customIndexes) {
      lines.push('');
      const def = idx.indexdef
        .replace(/^CREATE INDEX/i, 'CREATE INDEX IF NOT EXISTS')
        .replace(/^CREATE UNIQUE INDEX/i, 'CREATE UNIQUE INDEX IF NOT EXISTS');
      lines.push(`${def};`);
    }
    lines.push('');
  }

  // ── RLS ──
  const rlsTables = rlsStatus.filter(r => r.rls_enabled);
  if (rlsTables.length > 0) {
    lines.push('');
    lines.push('-- ============================================================');
    lines.push('-- ROW LEVEL SECURITY');
    lines.push('-- ============================================================');
    for (const r of rlsTables) {
      lines.push('');
      lines.push(`ALTER TABLE public.${r.table_name} ENABLE ROW LEVEL SECURITY;`);
      if (r.rls_forced) {
        lines.push(`ALTER TABLE public.${r.table_name} FORCE ROW LEVEL SECURITY;`);
      }
      const policies = policiesByTable[r.table_name] || [];
      for (const p of policies) {
        const permissive = p.permissive === 'PERMISSIVE' ? '' : ' AS RESTRICTIVE';
        const roles = p.roles === '{*}' ? 'public' : p.roles.replace(/[{}]/g, '');
        lines.push('');
        lines.push(`DROP POLICY IF EXISTS "${p.policyname}" ON public.${p.tablename};`);
        let pDef = `CREATE POLICY "${p.policyname}" ON public.${p.tablename}${permissive}`;
        pDef += `\n  FOR ${p.cmd}`;
        pDef += `\n  TO ${roles}`;
        if (p.qual) pDef += `\n  USING (${p.qual})`;
        if (p.with_check) pDef += `\n  WITH CHECK (${p.with_check})`;
        pDef += ';';
        lines.push(pDef);
      }
    }
    lines.push('');
  }

  // ── Storage Buckets ──
  if (storageBuckets.length > 0) {
    lines.push('');
    lines.push('-- ============================================================');
    lines.push('-- STORAGE BUCKETS');
    lines.push('-- ============================================================');
    for (const b of storageBuckets) {
      const limit = b.file_size_limit ?? 'NULL';
      const mimes = Array.isArray(b.allowed_mime_types) && b.allowed_mime_types.length > 0
        ? `ARRAY[${b.allowed_mime_types.map(m => `'${m}'`).join(', ')}]`
        : 'NULL';
      lines.push(`INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)`);
      lines.push(`  VALUES ('${b.id}', '${b.name}', ${b.public}, ${limit}, ${mimes})`);
      lines.push(`  ON CONFLICT (id) DO UPDATE SET public = EXCLUDED.public, file_size_limit = EXCLUDED.file_size_limit, allowed_mime_types = EXCLUDED.allowed_mime_types;`);
    }
    lines.push('');
  }

  // ── Storage Policies ──
  if (storagePolicies.length > 0) {
    lines.push('');
    lines.push('-- ============================================================');
    lines.push('-- STORAGE POLICIES');
    lines.push('-- ============================================================');
    for (const p of storagePolicies) {
      const permissive = p.permissive === 'PERMISSIVE' ? '' : ' AS RESTRICTIVE';
      const roles = p.roles === '{*}' ? 'public' : p.roles.replace(/[{}]/g, '');
      lines.push('');
      lines.push(`DROP POLICY IF EXISTS "${p.policyname}" ON storage.${p.tablename};`);
      let pDef = `CREATE POLICY "${p.policyname}" ON storage.${p.tablename}${permissive}`;
      pDef += `\n  FOR ${p.cmd}`;
      pDef += `\n  TO ${roles}`;
      if (p.qual) pDef += `\n  USING (${p.qual})`;
      if (p.with_check) pDef += `\n  WITH CHECK (${p.with_check})`;
      pDef += ';';
      lines.push(pDef);
    }
    lines.push('');
  }

  // ── Cron Jobs ──
  if (cronJobs.length > 0) {
    lines.push('');
    lines.push('-- ============================================================');
    lines.push('-- CRON JOBS (pg_cron)');
    lines.push('-- ============================================================');
    for (const job of cronJobs) {
      lines.push(`SELECT cron.schedule('${job.schedule}', $cron$${job.command}$cron$);`);
    }
    lines.push('');
  }

  // ── Column Comments ──
  if (columnComments.length > 0) {
    lines.push('');
    lines.push('-- ============================================================');
    lines.push('-- COLUMN COMMENTS');
    lines.push('-- ============================================================');
    for (const c of columnComments) {
      const escaped = c.description.replace(/'/g, "''");
      lines.push(`COMMENT ON COLUMN public.${c.table_name}.${c.column_name} IS '${escaped}';`);
    }
    lines.push('');
  }

  // ── Realtime Publications ──
  if (realtimePubs.length > 0) {
    lines.push('');
    lines.push('-- ============================================================');
    lines.push('-- REALTIME PUBLICATIONS');
    lines.push('-- ============================================================');
    const byPub = {};
    for (const p of realtimePubs) (byPub[p.pubname] ??= []).push(p.tablename);
    for (const [pubName, pubTables] of Object.entries(byPub)) {
      lines.push('');
      for (const t of pubTables) {
        lines.push(`ALTER PUBLICATION ${pubName} ADD TABLE IF NOT EXISTS public.${t};`);
      }
    }
    lines.push('');
  }

  // ── Write file ──
  const outputPath = path.join(ROOT, 'supabase', 'schema.sql');
  const content = lines.join('\n') + '\n';
  fs.writeFileSync(outputPath, content, 'utf8');

  const sizeKB = (Buffer.byteLength(content) / 1024).toFixed(1);
  console.log(`\n✅ schema.sql updated successfully!`);
  console.log(`   📄 ${outputPath}`);
  console.log(`   📏 ${lines.length} lines, ${sizeKB} KB`);
  console.log(`   📋 ${tables.length} tables, ${functions.length} functions, ${triggers.length} triggers`);
  console.log(`   🔒 ${rlsPolicies.length} RLS policies, ${customIndexes.length} indexes`);
  console.log(`   🪣 ${storageBuckets.length} storage buckets, ${storagePolicies.length} storage policies`);
  console.log(`   ⏱️  ${cronJobs.length} cron jobs, ${extensions.length} extensions`);
  console.log('\n   ⚠️  The live database was NOT modified.');
}

main().catch(err => {
  console.error('\n❌ Error:', err.message);
  if (err.message.includes('401') || err.message.includes('403')) {
    console.error('   → Check that SUPABASE_PERSONAL_ACCESS_TOKEN in .env is valid and has not expired.');
  }
  process.exit(1);
});

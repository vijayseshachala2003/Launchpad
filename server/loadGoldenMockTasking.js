#!/usr/bin/env node
/**
 * Load gold-label CSV into Supabase table "golden-mock-tasking".
 *
 * Prereq: run server/sql/golden-mock-tasking.sql in Supabase once.
 *
 * Usage (from repo root, with backend/.env containing DATABASE_URL or SUPABASE_DB_*):
 *   cd server && npm install && node loadGoldenMockTasking.js
 *
 * Optional env:
 *   GOLDEN_MOCK_CSV — absolute or relative path (default: backend/scripts/AE-v1 Accuracy - Gold Label New Script (3).csv)
 */

import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parse } from 'csv-parse/sync';
import pg from 'pg';
import { getPostgresConfig, hasPostgresConfig } from './db.js';

const { Client } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

dotenv.config({ path: path.join(REPO_ROOT, 'backend', '.env') });

const TABLE = '"golden-mock-tasking"';
const DEFAULT_CSV = path.join(
  REPO_ROOT,
  'backend',
  'scripts',
  'AE-v1 Accuracy - Gold Label New Script (3).csv'
);

function main() {
  const csvPath = path.resolve(process.env.GOLDEN_MOCK_CSV || DEFAULT_CSV);
  if (!fs.existsSync(csvPath)) {
    console.error('CSV not found:', csvPath);
    process.exit(1);
  }

  const raw = fs.readFileSync(csvPath, 'utf8');
  const records = parse(raw, { columns: true, skip_empty_lines: true, trim: true, relax_column_count: true });
  if (!records.length) {
    console.error('No data rows in CSV.');
    process.exit(1);
  }

  const cols = Object.keys(records[0]);
  if (!cols.includes('subtask_id')) {
    console.error('CSV must include a subtask_id column.');
    process.exit(1);
  }

  const updateCols = cols.filter((c) => c !== 'subtask_id');
  const colList = cols.join(', ');
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
  const setClause = updateCols.map((c) => `${c} = EXCLUDED.${c}`).join(', ');
  const sql = `INSERT INTO ${TABLE} (${colList}) VALUES (${placeholders}) ON CONFLICT (subtask_id) DO UPDATE SET ${setClause}`;

  if (!hasPostgresConfig()) {
    console.error('Missing DATABASE_URL (or SUPABASE_DATABASE_URL) or SUPABASE_DB_* in backend/.env');
    process.exit(1);
  }
  const cfg = getPostgresConfig();

  const client = new Client(cfg);
  return client
    .connect()
    .then(async () => {
      let n = 0;
      for (const row of records) {
        const values = cols.map((c) => {
          const v = row[c];
          if (v === undefined || v === '') return null;
          return String(v);
        });
        await client.query(sql, values);
        n += 1;
      }
      console.log(`Upserted ${n} row(s) into ${TABLE} from ${csvPath}`);
    })
    .finally(() => client.end());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

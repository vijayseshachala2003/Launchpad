#!/usr/bin/env node
/**
 * Load gold-label CSV into Supabase table "golden_datasets".
 *
 * Prereq: create table golden_datasets in Supabase once.
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

const TABLE = '"golden_datasets"';
const GOLDEN_PURPOSE = (process.env.GOLDEN_PURPOSE || 'annotator_judge').trim() || 'annotator_judge';
const DEPRECATE_OLD_ON_LOAD = String(process.env.GOLDEN_DEPRECATE_OLD_ON_LOAD || '1') !== '0';
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

  const metaCols = ['purpose', 'gold_created_at', 'is_active', 'deprecated_at'];
  const allCols = [...cols, ...metaCols];
  const updateCols = allCols.filter((c) => c !== 'subtask_id');
  const colList = allCols.join(', ');
  const placeholders = allCols.map((_, i) => `$${i + 1}`).join(', ');
  const setClause = updateCols.map((c) => `${c} = EXCLUDED.${c}`).join(', ');
  const sql = `INSERT INTO ${TABLE} (${colList}) VALUES (${placeholders}) ON CONFLICT (purpose, subtask_id) DO UPDATE SET ${setClause}`;

  if (!hasPostgresConfig()) {
    console.error('Missing DATABASE_URL (or SUPABASE_DATABASE_URL) or SUPABASE_DB_* in backend/.env');
    process.exit(1);
  }
  const cfg = getPostgresConfig();

  const client = new Client(cfg);
  return client
    .connect()
    .then(async () => {
      // Ensure metadata columns exist for versioned / active gold sets.
      await client.query(`
        ALTER TABLE ${TABLE}
          ADD COLUMN IF NOT EXISTS purpose TEXT,
          ADD COLUMN IF NOT EXISTS gold_created_at TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true,
          ADD COLUMN IF NOT EXISTS deprecated_at TIMESTAMPTZ;
      `);

      // Optional behavior: when loading a new set for this purpose, deactivate the previous one.
      if (DEPRECATE_OLD_ON_LOAD) {
        await client.query(
          `UPDATE ${TABLE}
           SET is_active = false, deprecated_at = NOW()
           WHERE COALESCE(purpose, 'annotator_judge') = $1
             AND COALESCE(is_active, true) = true`,
          [GOLDEN_PURPOSE]
        );
      }

      let n = 0;
      for (const row of records) {
        const values = cols.map((c) => {
          const v = row[c];
          if (v === undefined || v === '') return null;
          return String(v);
        });
        values.push(GOLDEN_PURPOSE, new Date().toISOString(), true, null);
        await client.query(sql, values);
        n += 1;
      }
      console.log(
        `Upserted ${n} row(s) into ${TABLE} from ${csvPath} (purpose=${GOLDEN_PURPOSE}, deprecate_old=${DEPRECATE_OLD_ON_LOAD}).`
      );
    })
    .finally(() => client.end());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

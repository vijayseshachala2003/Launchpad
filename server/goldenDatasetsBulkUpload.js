import { parse } from 'csv-parse/sync';
import pg from 'pg';
import { getPostgresConfig } from './db.js';

const { Client } = pg;

export const GOLDEN_PURPOSES = {
  LAUNCHPAD_EVAL: 'Launchpad - eval',
  ANNOTATOR_JUDGE: 'annotator_judge',
};

const LAUNCHPAD_COLUMNS = ['uniqueid', 'q1_label', 'q2_label', 'q3_label', 'q4_label', 'q5_label'];
const ANNOTATOR_COLUMNS = [
  'subtask_id',
  'punt_a',
  'punt_a_priority',
  'instruction_a',
  'instruction_a_priority',
  'context_awareness_a',
  'context_awareness_a_priority',
  'relevance_a',
  'relevance_a_priority',
  'completeness_a',
  'completeness_a_priority',
  'writing_style_a',
  'writing_style_a_priority',
  'collab_a',
  'collab_a_priority',
  'factuality_a',
  'factuality_a_priority',
  'info_retrieval_a',
  'info_retrieval_a_priority',
  'code_a',
  'code_a_priority',
  'code_sequence_a',
  'code_sequence_a_priority',
  'code_output_a',
  'code_output_a_priority',
  'overall_a',
  'overall_a_priority',
  'punt_b',
  'punt_b_priority',
  'instruction_b',
  'instruction_b_priority',
  'context_awareness_b',
  'context_awareness_b_priority',
  'relevance_b',
  'relevance_b_priority',
  'completeness_b',
  'completeness_b_priority',
  'writing_style_b',
  'writing_style_b_priority',
  'collab_b',
  'collab_b_priority',
  'factuality_b',
  'factuality_b_priority',
  'info_retrieval_b',
  'info_retrieval_b_priority',
  'code_b',
  'code_b_priority',
  'code_sequence_b',
  'code_sequence_b_priority',
  'code_output_b',
  'code_output_b_priority',
  'overall_b',
  'overall_b_priority',
  'likert_scale',
  'likert_scale_priority',
];

function goldenTableRawName() {
  return (process.env.GOLDEN_MOCK_TABLE || 'golden_datasets').trim().replace(/^"|"$/g, '');
}

function assessmentTableRawName() {
  return (process.env.GOLDEN_ASSESSMENT_TABLE || 'golden_datasets_assessments')
    .trim()
    .replace(/^"|"$/g, '');
}

function safeTableSql(raw, envName) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw)) {
    throw new Error(`Unsafe ${envName} name: "${raw}"`);
  }
  return `"${raw}"`;
}

function goldenTableSql() {
  return safeTableSql(goldenTableRawName(), 'GOLDEN_MOCK_TABLE');
}

function assessmentTableSql() {
  return safeTableSql(assessmentTableRawName(), 'GOLDEN_ASSESSMENT_TABLE');
}

function normalizePurpose(value) {
  const input = String(value || '').trim();
  if (!input) throw new Error('purpose is required.');
  if (input === GOLDEN_PURPOSES.LAUNCHPAD_EVAL) return GOLDEN_PURPOSES.LAUNCHPAD_EVAL;
  if (input === GOLDEN_PURPOSES.ANNOTATOR_JUDGE) return GOLDEN_PURPOSES.ANNOTATOR_JUDGE;
  throw new Error(
    `Invalid purpose "${input}". Allowed: "${GOLDEN_PURPOSES.LAUNCHPAD_EVAL}", "${GOLDEN_PURPOSES.ANNOTATOR_JUDGE}".`
  );
}

function parseCsvRows(csvText) {
  const rows = parse(String(csvText || '').replace(/^\uFEFF/, ''), {
    columns: true,
    skip_empty_lines: true,
    bom: true,
    trim: true,
    relax_column_count: true,
    relax_quotes: true,
  });
  return Array.isArray(rows) ? rows : [];
}

function nonEmptyTrimmed(v) {
  return String(v == null ? '' : v).trim();
}

function validateHeaders(rows, requiredColumns) {
  const first = rows[0] || {};
  const keys = Object.keys(first);
  const missing = requiredColumns.filter((k) => !keys.includes(k));
  if (missing.length) {
    throw new Error(`CSV is missing required column(s): ${missing.join(', ')}`);
  }
}

function sanitizeLaunchpadRow(row, rowNum) {
  const rec = {};
  for (const c of LAUNCHPAD_COLUMNS) rec[c] = nonEmptyTrimmed(row[c]);
  if (!rec.uniqueid) throw new Error(`Row ${rowNum}: uniqueid is required.`);
  return rec;
}

function sanitizeAnnotatorRow(row, rowNum) {
  const rec = {};
  for (const c of ANNOTATOR_COLUMNS) rec[c] = nonEmptyTrimmed(row[c]);
  if (!rec.subtask_id) throw new Error(`Row ${rowNum}: subtask_id is required.`);
  return rec;
}

async function upsertLaunchpadRows(client, table, purpose, rows) {
  let n = 0;
  const sql = `
    INSERT INTO ${table} (
      purpose, is_active, gold_created_at,
      uniqueid, q1_label, q2_label, q3_label, q4_label, q5_label
    )
    VALUES ($1, true, NOW(), $2, $3, $4, $5, $6, $7)
    ON CONFLICT (uniqueid)
    DO UPDATE SET
      q1_label = EXCLUDED.q1_label,
      q2_label = EXCLUDED.q2_label,
      q3_label = EXCLUDED.q3_label,
      q4_label = EXCLUDED.q4_label,
      q5_label = EXCLUDED.q5_label,
      is_active = true,
      deprecated_at = NULL,
      gold_created_at = NOW()
  `;
  for (const r of rows) {
    await client.query(sql, [purpose, r.uniqueid, r.q1_label, r.q2_label, r.q3_label, r.q4_label, r.q5_label]);
    n += 1;
  }
  return n;
}

async function upsertAnnotatorRows(client, table, purpose, rows) {
  let n = 0;
  const sql = `
    INSERT INTO ${table} (
      purpose, is_active, gold_created_at,
      subtask_id,
      punt_a, punt_a_priority, instruction_a, instruction_a_priority,
      context_awareness_a, context_awareness_a_priority, relevance_a, relevance_a_priority,
      completeness_a, completeness_a_priority, writing_style_a, writing_style_a_priority,
      collab_a, collab_a_priority, factuality_a, factuality_a_priority,
      info_retrieval_a, info_retrieval_a_priority, code_a, code_a_priority,
      code_sequence_a, code_sequence_a_priority, code_output_a, code_output_a_priority,
      overall_a, overall_a_priority,
      punt_b, punt_b_priority, instruction_b, instruction_b_priority,
      context_awareness_b, context_awareness_b_priority, relevance_b, relevance_b_priority,
      completeness_b, completeness_b_priority, writing_style_b, writing_style_b_priority,
      collab_b, collab_b_priority, factuality_b, factuality_b_priority,
      info_retrieval_b, info_retrieval_b_priority, code_b, code_b_priority,
      code_sequence_b, code_sequence_b_priority, code_output_b, code_output_b_priority,
      overall_b, overall_b_priority, likert_scale, likert_scale_priority
    )
    VALUES (
      $1, true, NOW(),
      $2,
      $3, $4, $5, $6,
      $7, $8, $9, $10,
      $11, $12, $13, $14,
      $15, $16, $17, $18,
      $19, $20, $21, $22,
      $23, $24, $25, $26,
      $27, $28,
      $29, $30, $31, $32,
      $33, $34, $35, $36,
      $37, $38, $39, $40,
      $41, $42, $43, $44,
      $45, $46, $47, $48,
      $49, $50, $51, $52,
      $53, $54, $55, $56
    )
    ON CONFLICT (purpose, subtask_id)
    DO UPDATE SET
      punt_a = EXCLUDED.punt_a,
      punt_a_priority = EXCLUDED.punt_a_priority,
      instruction_a = EXCLUDED.instruction_a,
      instruction_a_priority = EXCLUDED.instruction_a_priority,
      context_awareness_a = EXCLUDED.context_awareness_a,
      context_awareness_a_priority = EXCLUDED.context_awareness_a_priority,
      relevance_a = EXCLUDED.relevance_a,
      relevance_a_priority = EXCLUDED.relevance_a_priority,
      completeness_a = EXCLUDED.completeness_a,
      completeness_a_priority = EXCLUDED.completeness_a_priority,
      writing_style_a = EXCLUDED.writing_style_a,
      writing_style_a_priority = EXCLUDED.writing_style_a_priority,
      collab_a = EXCLUDED.collab_a,
      collab_a_priority = EXCLUDED.collab_a_priority,
      factuality_a = EXCLUDED.factuality_a,
      factuality_a_priority = EXCLUDED.factuality_a_priority,
      info_retrieval_a = EXCLUDED.info_retrieval_a,
      info_retrieval_a_priority = EXCLUDED.info_retrieval_a_priority,
      code_a = EXCLUDED.code_a,
      code_a_priority = EXCLUDED.code_a_priority,
      code_sequence_a = EXCLUDED.code_sequence_a,
      code_sequence_a_priority = EXCLUDED.code_sequence_a_priority,
      code_output_a = EXCLUDED.code_output_a,
      code_output_a_priority = EXCLUDED.code_output_a_priority,
      overall_a = EXCLUDED.overall_a,
      overall_a_priority = EXCLUDED.overall_a_priority,
      punt_b = EXCLUDED.punt_b,
      punt_b_priority = EXCLUDED.punt_b_priority,
      instruction_b = EXCLUDED.instruction_b,
      instruction_b_priority = EXCLUDED.instruction_b_priority,
      context_awareness_b = EXCLUDED.context_awareness_b,
      context_awareness_b_priority = EXCLUDED.context_awareness_b_priority,
      relevance_b = EXCLUDED.relevance_b,
      relevance_b_priority = EXCLUDED.relevance_b_priority,
      completeness_b = EXCLUDED.completeness_b,
      completeness_b_priority = EXCLUDED.completeness_b_priority,
      writing_style_b = EXCLUDED.writing_style_b,
      writing_style_b_priority = EXCLUDED.writing_style_b_priority,
      collab_b = EXCLUDED.collab_b,
      collab_b_priority = EXCLUDED.collab_b_priority,
      factuality_b = EXCLUDED.factuality_b,
      factuality_b_priority = EXCLUDED.factuality_b_priority,
      info_retrieval_b = EXCLUDED.info_retrieval_b,
      info_retrieval_b_priority = EXCLUDED.info_retrieval_b_priority,
      code_b = EXCLUDED.code_b,
      code_b_priority = EXCLUDED.code_b_priority,
      code_sequence_b = EXCLUDED.code_sequence_b,
      code_sequence_b_priority = EXCLUDED.code_sequence_b_priority,
      code_output_b = EXCLUDED.code_output_b,
      code_output_b_priority = EXCLUDED.code_output_b_priority,
      overall_b = EXCLUDED.overall_b,
      overall_b_priority = EXCLUDED.overall_b_priority,
      likert_scale = EXCLUDED.likert_scale,
      likert_scale_priority = EXCLUDED.likert_scale_priority,
      is_active = true,
      deprecated_at = NULL,
      gold_created_at = NOW()
  `;
  for (const r of rows) {
    const values = [
      purpose,
      r.subtask_id,
      r.punt_a,
      r.punt_a_priority,
      r.instruction_a,
      r.instruction_a_priority,
      r.context_awareness_a,
      r.context_awareness_a_priority,
      r.relevance_a,
      r.relevance_a_priority,
      r.completeness_a,
      r.completeness_a_priority,
      r.writing_style_a,
      r.writing_style_a_priority,
      r.collab_a,
      r.collab_a_priority,
      r.factuality_a,
      r.factuality_a_priority,
      r.info_retrieval_a,
      r.info_retrieval_a_priority,
      r.code_a,
      r.code_a_priority,
      r.code_sequence_a,
      r.code_sequence_a_priority,
      r.code_output_a,
      r.code_output_a_priority,
      r.overall_a,
      r.overall_a_priority,
      r.punt_b,
      r.punt_b_priority,
      r.instruction_b,
      r.instruction_b_priority,
      r.context_awareness_b,
      r.context_awareness_b_priority,
      r.relevance_b,
      r.relevance_b_priority,
      r.completeness_b,
      r.completeness_b_priority,
      r.writing_style_b,
      r.writing_style_b_priority,
      r.collab_b,
      r.collab_b_priority,
      r.factuality_b,
      r.factuality_b_priority,
      r.info_retrieval_b,
      r.info_retrieval_b_priority,
      r.code_b,
      r.code_b_priority,
      r.code_sequence_b,
      r.code_sequence_b_priority,
      r.code_output_b,
      r.code_output_b_priority,
      r.overall_b,
      r.overall_b_priority,
      r.likert_scale,
      r.likert_scale_priority,
    ];
    await client.query(sql, values);
    n += 1;
  }
  return n;
}

export function getGoldenUploadRules() {
  return {
    [GOLDEN_PURPOSES.LAUNCHPAD_EVAL]: {
      target_table: assessmentTableRawName(),
      required_columns: LAUNCHPAD_COLUMNS,
      notes: [
        'CSV header names must match exactly.',
        'uniqueid must be present and non-empty for every row.',
        'Rows are upserted by (uniqueid). Existing rows are updated.',
      ],
    },
    [GOLDEN_PURPOSES.ANNOTATOR_JUDGE]: {
      target_table: goldenTableRawName(),
      required_columns: ANNOTATOR_COLUMNS,
      notes: [
        'CSV header names must match exactly.',
        'subtask_id must be present and non-empty for every row.',
        'Rows are upserted by (purpose, subtask_id). Existing rows are updated.',
      ],
    },
  };
}

export async function bulkUploadGoldenDatasetCsv({ purpose, csvText }) {
  const normalizedPurpose = normalizePurpose(purpose);
  const rows = parseCsvRows(csvText);
  if (!rows.length) throw new Error('CSV has no data rows.');

  const rules = getGoldenUploadRules()[normalizedPurpose];
  validateHeaders(rows, rules.required_columns);
  const sanitized =
    normalizedPurpose === GOLDEN_PURPOSES.LAUNCHPAD_EVAL
      ? rows.map((r, i) => sanitizeLaunchpadRow(r, i + 2))
      : rows.map((r, i) => sanitizeAnnotatorRow(r, i + 2));

  const client = new Client(getPostgresConfig());
  await client.connect();
  try {
    await client.query('BEGIN');
    const table =
      normalizedPurpose === GOLDEN_PURPOSES.LAUNCHPAD_EVAL ? assessmentTableSql() : goldenTableSql();
    const affected =
      normalizedPurpose === GOLDEN_PURPOSES.LAUNCHPAD_EVAL
        ? await upsertLaunchpadRows(client, table, normalizedPurpose, sanitized)
        : await upsertAnnotatorRows(client, table, normalizedPurpose, sanitized);
    await client.query('COMMIT');
    return {
      purpose: normalizedPurpose,
      target_table:
        normalizedPurpose === GOLDEN_PURPOSES.LAUNCHPAD_EVAL ? assessmentTableRawName() : goldenTableRawName(),
      received_rows: rows.length,
      upserted_rows: affected,
    };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    await client.end();
  }
}

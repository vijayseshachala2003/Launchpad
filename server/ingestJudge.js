/**
 * Annotator-judge ingest — same policy as `ingest.js` / `runIngest`:
 * always query Soul for the UTC range; stage rows; drop rows whose `subtask_id` already exists (or blank key);
 * insert new rows only (no overwrite). Natural key here is `subtask_id`; assessment uses `uniqueid`.
 */
import fetch from 'node-fetch';
import pg from 'pg';
import { getPostgresConfig } from './db.js';

const { Client } = pg;

const API_ENDPOINT = 'https://reporting.soulhq.ai/read-query/execute';
const SOURCE = 'Node ETL Judge';

/** Override in env if you use a different table name. */
const JUDGE_TABLE = (process.env.ANNOTATOR_JUDGE_TABLE || 'annotator_judge_table').trim();

const STAGE_IDS_SQL = `(
  'stc_260210093443510LIGAL',
  'stc_260315191240238RD39P'
)`;

/** Soul query (same shape as ingest-mock). `A.created_at` is prepended for date-range ingest + (created_at, email) dedupe. */
const BASE_QUERY = `
SELECT
  A.created_at,
  A.user_id,
  u.email,
  A.status,
  A.task_allocation_id,
  A.updated_at,
  A.previous_data ->> 'uniqueId' AS subtask_id,
  A.response_data ->> 'punt_a' AS punt_a,
  A.response_data ->> 'instruction_a' AS instruction_a,
  A.response_data ->> 'context_awareness_a' AS context_awareness_a,
  A.response_data ->> 'relevance_a' AS relevance_a,
  A.response_data ->> 'completeness_a' AS completeness_a,
  A.response_data ->> 'writing_style_a' AS writing_style_a,
  A.response_data ->> 'collab_a' AS collab_a,
  A.response_data ->> 'factuality_a' AS factuality_a,
  A.response_data ->> 'info_retrieval_a' AS info_retrieval_a,
  A.response_data ->> 'code_a' AS code_a,
  A.response_data ->> 'code_sequence_a' AS code_sequence_a,
  A.response_data ->> 'code_output_a' AS code_output_a,
  A.response_data ->> 'overall_a' AS overall_a,
  A.response_data ->> 'punt_b' AS punt_b,
  A.response_data ->> 'instruction_b' AS instruction_b,
  A.response_data ->> 'context_awareness_b' AS context_awareness_b,
  A.response_data ->> 'relevance_b' AS relevance_b,
  A.response_data ->> 'completeness_b' AS completeness_b,
  A.response_data ->> 'writing_style_b' AS writing_style_b,
  A.response_data ->> 'collab_b' AS collab_b,
  A.response_data ->> 'factuality_b' AS factuality_b,
  A.response_data ->> 'info_retrieval_b' AS info_retrieval_b,
  A.response_data ->> 'code_b' AS code_b,
  A.response_data ->> 'code_sequence_b' AS code_sequence_b,
  A.response_data ->> 'code_output_b' AS code_output_b,
  A.response_data ->> 'overall_b' AS overall_b,
  A.response_data ->> 'Likert_Scale' AS likert_scale,
  A.response_data ->> 'Justification' AS justification
FROM annotation_task_response_data A
LEFT JOIN annotation_users u ON A.user_id = u.id
WHERE A.stage_id IN ${STAGE_IDS_SQL}
  AND A.status = 'SUBMITTED'
`;

/** Columns on annotator_judge_table / annotator CSV (shared with export pipeline). */
export const ANNOTATOR_JUDGE_CSV_COLUMNS = [
  'created_at',
  'user_id',
  'email',
  'status',
  'task_allocation_id',
  'updated_at',
  'subtask_id',
  'punt_a',
  'instruction_a',
  'context_awareness_a',
  'relevance_a',
  'completeness_a',
  'writing_style_a',
  'collab_a',
  'factuality_a',
  'info_retrieval_a',
  'code_a',
  'code_sequence_a',
  'code_output_a',
  'overall_a',
  'punt_b',
  'instruction_b',
  'context_awareness_b',
  'relevance_b',
  'completeness_b',
  'writing_style_b',
  'collab_b',
  'factuality_b',
  'info_retrieval_b',
  'code_b',
  'code_sequence_b',
  'code_output_b',
  'overall_b',
  'likert_scale',
  'justification',
];

const COLS = ANNOTATOR_JUDGE_CSV_COLUMNS;
const NUM_COLS = COLS.length;
const INGEST_COLS = COLS.join(', ');

function escapeTs(s) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) throw new Error('Invalid timestamp format');
  return s.replace(/'/g, "''");
}

function buildQuery(dateFrom, dateTo) {
  let q = BASE_QUERY.trim();
  if (dateFrom) q += `\n  AND A.created_at >= '${escapeTs(dateFrom)}'::timestamptz`;
  if (dateTo) q += `\n  AND A.created_at <= '${escapeTs(dateTo)}'::timestamptz`;
  q += '\nORDER BY A.updated_at DESC;';
  return q;
}

async function fetchApiRows(query) {
  const url = `${API_ENDPOINT}?source=${encodeURIComponent(SOURCE)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`Soul API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  if (Array.isArray(data)) return data;
  if (data?.data) return data.data;
  if (data?.rows) return data.rows;
  throw new Error('Unexpected Soul API response format');
}

function normalizeTimestamp(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'string' && /^\d{4}-\d{2}/.test(value)) {
    return value.replace('Z', '+00:00');
  }
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function pick(row, ...keys) {
  for (const k of keys) {
    if (row[k] != null && row[k] !== '') return row[k];
  }
  return null;
}

function toRow(row) {
  return [
    normalizeTimestamp(pick(row, 'created_at', 'createdAt')),
    pick(row, 'user_id', 'userId') != null ? String(pick(row, 'user_id', 'userId')) : null,
    pick(row, 'email', 'Email'),
    pick(row, 'status', 'Status'),
    pick(row, 'task_allocation_id', 'taskAllocationId') != null
      ? String(pick(row, 'task_allocation_id', 'taskAllocationId'))
      : null,
    normalizeTimestamp(pick(row, 'updated_at', 'updatedAt')),
    pick(row, 'subtask_id', 'subtaskId', 'Subtask_ID'),
    pick(row, 'punt_a', 'punt_A'),
    pick(row, 'instruction_a', 'instruction_A'),
    pick(row, 'context_awareness_a', 'context_awareness_A'),
    pick(row, 'relevance_a', 'relevance_A'),
    pick(row, 'completeness_a', 'completeness_A'),
    pick(row, 'writing_style_a', 'writing_style_A'),
    pick(row, 'collab_a', 'collab_A'),
    pick(row, 'factuality_a', 'factuality_A'),
    pick(row, 'info_retrieval_a', 'info_retrieval_A'),
    pick(row, 'code_a', 'code_A'),
    pick(row, 'code_sequence_a', 'code_sequence_A'),
    pick(row, 'code_output_a', 'code_output_A'),
    pick(row, 'overall_a', 'overall_A'),
    pick(row, 'punt_b', 'punt_B'),
    pick(row, 'instruction_b', 'instruction_B'),
    pick(row, 'context_awareness_b', 'context_awareness_B'),
    pick(row, 'relevance_b', 'relevance_B'),
    pick(row, 'completeness_b', 'completeness_B'),
    pick(row, 'writing_style_b', 'writing_style_B'),
    pick(row, 'collab_b', 'collab_B'),
    pick(row, 'factuality_b', 'factuality_B'),
    pick(row, 'info_retrieval_b', 'info_retrieval_B'),
    pick(row, 'code_b', 'code_B'),
    pick(row, 'code_sequence_b', 'code_sequence_B'),
    pick(row, 'code_output_b', 'code_output_B'),
    pick(row, 'overall_b', 'overall_B'),
    pick(row, 'likert_scale', 'Likert_Scale', 'likert_Scale'),
    pick(row, 'justification', 'Justification'),
  ];
}

function createStagingSql() {
  const defs = COLS.map((c) => {
    if (c === 'created_at' || c === 'updated_at') return `${c} timestamptz`;
    return `${c} text`;
  }).join(', ');
  return `CREATE TEMP TABLE _annotator_judge_staging (${defs}) ON COMMIT DROP;`;
}

/** Remove Soul rows already present (by subtask_id) or without key — no overwrite of existing rows. */
function deleteStagingAlreadyInDbSql() {
  return `
DELETE FROM _annotator_judge_staging AS i
WHERE COALESCE(btrim(i.subtask_id), '') = ''
   OR EXISTS (
     SELECT 1 FROM ${JUDGE_TABLE} AS t
     WHERE t.subtask_id IS NOT DISTINCT FROM i.subtask_id
   );`;
}

function insertNewSql() {
  return `
INSERT INTO ${JUDGE_TABLE} (${INGEST_COLS}, ingest_status)
SELECT ${INGEST_COLS}, 'PENDING'
FROM _annotator_judge_staging AS i
WHERE i.subtask_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM ${JUDGE_TABLE} AS t WHERE t.subtask_id IS NOT DISTINCT FROM i.subtask_id
  );`;
}

/**
 * Ingest Soul rows for annotator-judge stages into `annotator_judge_table` (or ANNOTATOR_JUDGE_TABLE).
 * Always queries Soul for the range, then inserts only rows whose subtask_id is not already in the judge table.
 * Does not update existing rows.
 *
 * @param {string} dateFrom - UTC ISO
 * @param {string} dateTo - UTC ISO
 * @returns {Promise<{ soul_rows_fetched: number, skipped_existing: number, rows_inserted: number }>}
 */
export async function runJudgeIngest(dateFrom, dateTo) {
  const query = buildQuery(dateFrom, dateTo);
  const apiRows = await fetchApiRows(query);
  if (!apiRows.length) {
    return { soul_rows_fetched: 0, skipped_existing: 0, rows_inserted: 0 };
  }

  const values = apiRows.map(toRow);
  const client = new Client(getPostgresConfig());
  await client.connect();

  const CREATE_STAGING = createStagingSql();
  const DELETE_STAGING_ALREADY_IN_DB = deleteStagingAlreadyInDbSql();
  const INSERT_NEW = insertNewSql();

  try {
    await client.query('BEGIN');
    await client.query(CREATE_STAGING);
    for (let i = 0; i < values.length; i += 200) {
      const chunk = values.slice(i, i + 200);
      const flat = chunk.flat();
      const placeholders = chunk
        .map(
          (_, rowIdx) =>
            `(${Array.from({ length: NUM_COLS }, (_, colIdx) => `$${rowIdx * NUM_COLS + colIdx + 1}`).join(', ')})`
        )
        .join(', ');
      await client.query(
        `INSERT INTO _annotator_judge_staging (${INGEST_COLS}) VALUES ${placeholders}`,
        flat
      );
    }
    await client.query(DELETE_STAGING_ALREADY_IN_DB);
    const eligibleRes = await client.query('SELECT COUNT(*)::bigint AS n FROM _annotator_judge_staging');
    const eligible = Number(eligibleRes.rows[0].n);
    const insertRes = await client.query(INSERT_NEW);
    const inserted = insertRes.rowCount ?? 0;
    await client.query('COMMIT');
    return {
      soul_rows_fetched: apiRows.length,
      skipped_existing: apiRows.length - eligible,
      rows_inserted: inserted,
    };
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw e;
  } finally {
    await client.end();
  }
}

import pg from 'pg';
import { getPostgresConfig, hasPostgresConfig } from './db.js';
import { ANNOTATOR_JUDGE_CSV_COLUMNS } from './ingestJudge.js';

const { Client } = pg;

function annotatorTableName() {
  return (process.env.ANNOTATOR_JUDGE_TABLE || 'annotator_judge_table').trim();
}

/** Quoted Postgres identifier for golden table (hyphenated name). */
function goldenTableRawName() {
  return (process.env.GOLDEN_MOCK_TABLE || 'golden-mock-tasking').trim().replace(/^"|"$/g, '');
}

function goldenTableSql() {
  const raw = goldenTableRawName();
  return `"${raw.replace(/"/g, '""')}"`;
}

export const GOLDEN_CSV_COLUMNS = [
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

/**
 * Annotator rows in created_at range that have a matching gold row (trimmed subtask_id).
 * @param {string} dateFromUtc - ISO
 * @param {string} dateToUtc - ISO
 * @param {number} maxRows - 0 = no limit
 */
export async function fetchAnnotatorRowsWithGold(dateFromUtc, dateToUtc, maxRows) {
  const ann = annotatorTableName();
  const gold = goldenTableSql();
  const aCols = ANNOTATOR_JUDGE_CSV_COLUMNS.map((c) => `a.${c}`).join(', ');

  let sql = `
    SELECT ${aCols}
    FROM ${ann} a
    INNER JOIN ${gold} g ON BTRIM(a.subtask_id) = BTRIM(g.subtask_id)
    WHERE a.created_at >= $1::timestamptz AND a.created_at <= $2::timestamptz
    ORDER BY a.updated_at DESC NULLS LAST
  `;
  const params = [dateFromUtc, dateToUtc];
  if (maxRows > 0) {
    sql += ` LIMIT $3`;
    params.push(maxRows);
  }

  const client = new Client(getPostgresConfig());
  await client.connect();
  try {
    const res = await client.query(sql, params);
    return res.rows;
  } finally {
    await client.end();
  }
}

/**
 * Gold rows for the given subtask ids (trimmed string match).
 */
export async function fetchGoldenRowsForSubtaskIds(subtaskIds) {
  const uniq = [...new Set((subtaskIds || []).map((id) => String(id ?? '').trim()).filter(Boolean))];
  if (!uniq.length) return [];

  const gold = goldenTableSql();
  const client = new Client(getPostgresConfig());
  await client.connect();
  try {
    const res = await client.query(
      `SELECT * FROM ${gold} g WHERE BTRIM(g.subtask_id) = ANY($1::text[])`,
      [uniq]
    );
    return res.rows;
  } finally {
    await client.end();
  }
}

/**
 * Verify DB connectivity and annotator-judge tables (row counts + join count).
 * @returns {Promise<{ ok: boolean, error?: string, details?: object }>}
 */
export async function verifyAnnotatorJudgeDbConnection() {
  if (!hasPostgresConfig()) {
    return {
      ok: false,
      error:
        'Missing DB config. Set DATABASE_URL (or SUPABASE_DATABASE_URL) in backend/.env, or SUPABASE_DB_HOST, SUPABASE_DB_USER, SUPABASE_DB_PASSWORD.',
    };
  }

  const ann = annotatorTableName();
  const gold = goldenTableSql();
  const client = new Client(getPostgresConfig());

  try {
    await client.connect();
  } catch (e) {
    return { ok: false, error: `Connection failed: ${e.message || e}` };
  }

  const details = {
    annotator_table: ann,
    golden_table: goldenTableRawName(),
    annotator_judge_row_count: null,
    golden_mock_row_count: null,
    joinable_row_count: null,
  };

  try {
    const r1 = await client.query(`SELECT COUNT(*)::bigint AS c FROM ${ann}`);
    details.annotator_judge_row_count = Number(r1.rows[0].c);
  } catch (e) {
    await client.end();
    return {
      ok: false,
      error: `annotator table "${ann}": ${e.message || e}`,
      details,
    };
  }

  try {
    const r2 = await client.query(`SELECT COUNT(*)::bigint AS c FROM ${gold}`);
    details.golden_mock_row_count = Number(r2.rows[0].c);
  } catch (e) {
    await client.end();
    return {
      ok: false,
      error: `golden table: ${e.message || e}`,
      details,
    };
  }

  try {
    const r3 = await client.query(`
      SELECT COUNT(*)::bigint AS c
      FROM ${ann} a
      INNER JOIN ${gold} g ON BTRIM(a.subtask_id) = BTRIM(g.subtask_id)
    `);
    details.joinable_row_count = Number(r3.rows[0].c);
  } catch (e) {
    await client.end();
    return {
      ok: false,
      error: `Join query failed: ${e.message || e}`,
      details,
    };
  }

  await client.end();
  return { ok: true, details };
}

import fetch from 'node-fetch';
import pg from 'pg';
import { getPostgresConfig } from './db.js';

const { Client } = pg;

const API_ENDPOINT = 'https://reporting.soulhq.ai/read-query/execute';
const SOURCE = 'Node ETL';

const STAGE_IDS_SQL = `(
  'stc_260210093443510LIGAL','stc_260315191240238RD39P'
)`;

const BASE_QUERY = `
 SELECT
  user_id,
  u.email,
  annotation_task_response_data.status,
  task_allocation_id, annotation_task_response_data.updated_at,
  previous_data ->> 'uniqueId' AS subtask_id,

  -- Ordered Fields (A side first)
  response_data ->> 'punt_a' AS punt_a,
  response_data ->> 'instruction_a' AS instruction_a,
  response_data ->> 'context_awareness_a' AS context_awareness_a,
  response_data ->> 'relevance_a' AS relevance_a,
  response_data ->> 'completeness_a' AS completeness_a,
  response_data ->> 'writing_style_a' AS writing_style_a,
  response_data ->> 'collab_a' AS collab_a,
  response_data ->> 'factuality_a' AS factuality_a,
  response_data ->> 'info_retrieval_a' AS info_retrieval_a,
  response_data ->> 'code_a' AS code_a,
  response_data ->> 'code_sequence_a' AS code_sequence_a,
  response_data ->> 'code_output_a' AS code_output_a,
  response_data ->> 'overall_a' AS overall_a,
  

  -- B side
  response_data ->> 'punt_b' AS punt_b,
  response_data ->> 'instruction_b' AS instruction_b,
  response_data ->> 'context_awareness_b' AS context_awareness_b,
  response_data ->> 'relevance_b' AS relevance_b,
  response_data ->> 'completeness_b' AS completeness_b,
  response_data ->> 'writing_style_b' AS writing_style_b,
  response_data ->> 'collab_b' AS collab_b,
  response_data ->> 'factuality_b' AS factuality_b,
  response_data ->> 'info_retrieval_b' AS info_retrieval_b,
  response_data ->> 'code_b' AS code_b,
  response_data ->> 'code_sequence_b' AS code_sequence_b,
  response_data ->> 'code_output_b' AS code_output_b,
  response_data ->> 'overall_b' AS overall_b,
  
  -- Likert at the end
  response_data ->> 'Likert_Scale' AS Likert_Scale,
  response_data ->> 'Justification' AS Justification

FROM
  annotation_task_response_data
LEFT JOIN annotation_users u
  ON annotation_task_response_data.user_id = u.id
  WHERE A.stage_id IN ${STAGE_IDS_SQL} AND annotation_task_response_data.status = 'SUBMITTED'
ORDER BY
  annotation_task_response_data.updated_at DESC;
`;

function escapeTs(s) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) throw new Error('Invalid timestamp format');
  return s.replace(/'/g, "''");
}

function buildQuery(dateFrom, dateTo) {
  let q = BASE_QUERY.trim();
  if (dateFrom) q += `\n  AND A.created_at >= '${escapeTs(dateFrom)}'::timestamptz`;
  if (dateTo) q += `\n  AND A.created_at <= '${escapeTs(dateTo)}'::timestamptz`;
  q += '\nORDER BY A.created_at;';
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
  return value;
}

function toRow(row) {
  return [
    normalizeTimestamp(row.created_at),
    row.email ?? null,
    row.uniqueId ?? null,
    row.initialValue_passage ?? null,
    row.initialValue_question_1 ?? null,
    row.ans_1 ?? null,
    row.initialValue_question_2 ?? null,
    row.ans_2 ?? null,
    row.initialValue_question_3 ?? null,
    row.ans_3 ?? null,
    row.initialValue_question_4 ?? null,
    row.ans_4 ?? null,
    row.initialValue_question_5 ?? null,
    row.ans_5 ?? null,
    row.initialValue_prompt ?? null,
    row.initialValue_ai_response ?? null,
    row.section_2_instruction ?? null,
    row.task_1 ?? null,
    row.task_1_response ?? null,
    row.task_2 ?? null,
    row.task_2_response ?? null,
    row.task_3 ?? null,
    row.task_3_response ?? null,
    row.initialValue_scenario ?? null,
    row.initialValue_sec_3_qn ?? null,
    row.section_3_instruction ?? null,
    row.sec_3_ans ?? null,
  ];
}

const INGEST_COLS =
  'created_at, email, uniqueid, initialvalue_passage, initialvalue_question_1, ans_1, ' +
  'initialvalue_question_2, ans_2, initialvalue_question_3, ans_3, initialvalue_question_4, ans_4, ' +
  'initialvalue_question_5, ans_5, initialvalue_prompt, initialvalue_ai_response, section_2_instruction, ' +
  'task_1, task_1_response, task_2, task_2_response, task_3, task_3_response, initialvalue_scenario, ' +
  'initialvalue_sec_3_qn, section_3_instruction, sec_3_ans';

const CREATE_STAGING = `
CREATE TEMP TABLE _launchpad_ingest (
  created_at timestamptz, email text, uniqueid text, initialvalue_passage text, initialvalue_question_1 text,
  ans_1 text, initialvalue_question_2 text, ans_2 text, initialvalue_question_3 text, ans_3 text,
  initialvalue_question_4 text, ans_4 text, initialvalue_question_5 text, ans_5 text,
  initialvalue_prompt text, initialvalue_ai_response text, section_2_instruction text,
  task_1 text, task_1_response text, task_2 text, task_2_response text, task_3 text, task_3_response text,
  initialvalue_scenario text, initialvalue_sec_3_qn text, section_3_instruction text, sec_3_ans text
) ON COMMIT DROP;
`;

const DELETE_DUPLICATES = `
DELETE FROM _launchpad_ingest AS i
WHERE EXISTS (
  SELECT 1 FROM new_evaluation_table AS t
  WHERE t.created_at IS NOT DISTINCT FROM i.created_at AND t.email IS NOT DISTINCT FROM i.email
);
`;

const UPDATE_FROM_STAGING = `
UPDATE new_evaluation_table AS t SET
  created_at = i.created_at, email = i.email, initialvalue_passage = i.initialvalue_passage,
  initialvalue_question_1 = i.initialvalue_question_1, ans_1 = i.ans_1,
  initialvalue_question_2 = i.initialvalue_question_2, ans_2 = i.ans_2,
  initialvalue_question_3 = i.initialvalue_question_3, ans_3 = i.ans_3,
  initialvalue_question_4 = i.initialvalue_question_4, ans_4 = i.ans_4,
  initialvalue_question_5 = i.initialvalue_question_5, ans_5 = i.ans_5,
  initialvalue_prompt = i.initialvalue_prompt, initialvalue_ai_response = i.initialvalue_ai_response,
  section_2_instruction = i.section_2_instruction, task_1 = i.task_1, task_1_response = i.task_1_response,
  task_2 = i.task_2, task_2_response = i.task_2_response, task_3 = i.task_3, task_3_response = i.task_3_response,
  initialvalue_scenario = i.initialvalue_scenario, initialvalue_sec_3_qn = i.initialvalue_sec_3_qn,
  section_3_instruction = i.section_3_instruction, sec_3_ans = i.sec_3_ans,
  sec_2_eval_status = 'PENDING', sec_3_eval_status = 'PENDING'
FROM _launchpad_ingest AS i WHERE t.uniqueid = i.uniqueid;
`;

const INSERT_NEW = `
INSERT INTO new_evaluation_table (${INGEST_COLS}, sec_2_eval_status, sec_3_eval_status)
SELECT ${INGEST_COLS}, 'PENDING', 'PENDING'
FROM _launchpad_ingest AS i
WHERE NOT EXISTS (SELECT 1 FROM new_evaluation_table AS t WHERE t.uniqueid = i.uniqueid);
`;

/**
 * @param {string|null} dateFrom - UTC ISO
 * @param {string|null} dateTo - UTC ISO
 * @returns {Promise<number>} rows applied (after duplicate guard)
 */
export async function runIngest(dateFrom, dateTo) {
  const query = buildQuery(dateFrom, dateTo);
  const apiRows = await fetchApiRows(query);
  if (!apiRows.length) return 0;

  const values = apiRows.map(toRow);
  const client = new Client(getPostgresConfig());
  await client.connect();
  try {
    // CREATE TEMP ... ON COMMIT DROP removes the table when that transaction ends.
    // node-pg commits each standalone query by default, so without BEGIN/COMMIT the
    // temp table was dropped after CREATE_STAGING and INSERT failed.
    await client.query('BEGIN');
    await client.query(CREATE_STAGING);
    for (let i = 0; i < values.length; i += 200) {
      const chunk = values.slice(i, i + 200);
      const flat = chunk.flat();
      const placeholders = chunk
        .map(
          (_, rowIdx) =>
            `(${Array.from({ length: 27 }, (_, colIdx) => `$${rowIdx * 27 + colIdx + 1}`).join(', ')})`
        )
        .join(', ');
      await client.query(
        `INSERT INTO _launchpad_ingest (${INGEST_COLS}) VALUES ${placeholders}`,
        flat
      );
    }
    await client.query(DELETE_DUPLICATES);
    await client.query(UPDATE_FROM_STAGING);
    await client.query(INSERT_NEW);
    const countRes = await client.query('SELECT COUNT(*) AS n FROM _launchpad_ingest');
    const n = parseInt(countRes.rows[0].n, 10);
    await client.query('COMMIT');
    return n;
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

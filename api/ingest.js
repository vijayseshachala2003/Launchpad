import fetch from 'node-fetch';
import pg from 'pg';
import { getPostgresConfig } from './db.js';

const { Client } = pg;

const API_ENDPOINT = 'https://reporting.soulhq.ai/read-query/execute';
const SOURCE = 'Node ETL';

const STAGE_IDS_SQL = `(
  'stc_260218173538143LSI2M',
  'stc_26020219454705910Z9Z',
  'stc_260226150737582HP0J1',
  'stc_2603051253374341APCA',
  'stc_260307170924816MJKG9',
  'stc_2603111315195612L5NS'
)`;

const BASE_QUERY = `
SELECT
  A.created_at,
  u.email,
  A.previous_data ->> 'uniqueId' AS "uniqueId",
  A.previous_data ->> 'initialValue_passage' AS "initialValue_passage",
  A.previous_data ->> 'initialValue_question_1' AS "initialValue_question_1",
  A.response_data ->> 'ans_1' AS ans_1,
  A.previous_data ->> 'initialValue_question_2' AS "initialValue_question_2",
  A.response_data ->> 'ans_2' AS ans_2,
  A.previous_data ->> 'initialValue_question_3' AS "initialValue_question_3",
  A.response_data ->> 'ans_3' AS ans_3,
  A.previous_data ->> 'initialValue_question_4' AS "initialValue_question_4",
  A.response_data ->> 'ans_4' AS ans_4,
  A.previous_data ->> 'initialValue_question_5' AS "initialValue_question_5",
  A.response_data ->> 'ans_5' AS ans_5,
  A.previous_data ->> 'initialValue_prompt' AS "initialValue_prompt",
  A.previous_data ->> 'initialValue_ai_response' AS "initialValue_ai_response",
  A.previous_data ->> 'section_2_instruction' AS section_2_instruction,
  A.previous_data ->> 'initialValue_task_1' AS task_1,
  A.response_data ->> 'task_1_response' AS task_1_response,
  A.previous_data ->> 'initialValue_task_2' AS task_2,
  A.response_data ->> 'task_2_response' AS task_2_response,
  A.previous_data ->> 'initialValue_task_3' AS task_3,
  A.response_data ->> 'task_3_response' AS task_3_response,
  A.previous_data ->> 'initialValue_scenario' AS "initialValue_scenario",
  A.previous_data ->> 'initialValue_sec_3_qn' AS "initialValue_sec_3_qn",
  A.previous_data ->> 'section_3_instruction' AS section_3_instruction,
  A.response_data ->> 'sec_3_ans' AS sec_3_ans
FROM annotation_task_response_data A
LEFT JOIN annotation_users u ON A.user_id = u.id
WHERE A.status = 'SUBMITTED'
  AND A.stage_id IN ${STAGE_IDS_SQL}
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
    return parseInt(countRes.rows[0].n, 10);
  } finally {
    await client.end();
  }
}

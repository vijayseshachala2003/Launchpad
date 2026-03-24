/**
 * Persist batch_evaluate.py output (evaluation_results.json) onto annotator_judge_table.
 * All judge fields are written to dedicated columns (no JSONB results blob).
 */
import { readFile } from 'fs/promises';
import pg from 'pg';
import { getPostgresConfig } from './db.js';

const { Client } = pg;

/** Matches ae_v1_mappings.json dimension keys — M1 match/penalty per response side. */
const M1_DIMS = [
  'punt',
  'instruction',
  'context_awareness',
  'relevance',
  'completeness',
  'writing_style',
  'collab',
  'factuality',
  'info_retrieval',
  'code',
  'code_sequence',
  'code_output',
  'overall',
];

function judgeTableName() {
  return (process.env.ANNOTATOR_JUDGE_TABLE || 'annotator_judge_table').trim();
}

function str(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function boolOrNull(v) {
  if (v === true || v === false) return v;
  return null;
}

function scoresByDimension(scoresList) {
  const m = new Map();
  for (const s of scoresList || []) {
    if (!s || s.dimension_id == null) continue;
    const id = String(s.dimension_id).trim();
    if (id) m.set(id, s);
  }
  return m;
}

/** @param {Record<string, unknown>} row */
function m1FlatValues(row) {
  const ma = scoresByDimension(row.scores_a);
  const mb = scoresByDimension(row.scores_b);
  const vals = [];
  for (const d of M1_DIMS) {
    const sa = ma.get(d);
    const sb = mb.get(d);
    vals.push(
      boolOrNull(sa?.match),
      num(sa?.penalty),
      boolOrNull(sb?.match),
      num(sb?.penalty)
    );
  }
  vals.push(num(row.dimension_score));
  vals.push(num(row.final_score));
  return vals;
}

function m3AssessmentsText(m3) {
  const arr = m3.dimension_assessments;
  if (!Array.isArray(arr) || !arr.length) return null;
  const lines = [];
  for (const a of arr) {
    if (!a || typeof a !== 'object') continue;
    lines.push(
      [
        str(a.dimension),
        str(a.annotator_rating),
        str(a.golden_rating),
        str(a.rubric_understanding),
        a.rating_justified === true || a.rating_justified === false ? String(a.rating_justified) : '',
        str(a.explanation),
      ].join(' | ')
    );
  }
  return lines.length ? lines.join('\n') : null;
}

function issuesText(m2) {
  const iss = m2.issues_found;
  if (iss == null) return null;
  if (Array.isArray(iss)) return iss.map((x) => String(x)).join('\n') || null;
  return String(iss);
}

/**
 * @param {Record<string, unknown>} row - one EvaluationResult dict
 * @returns {unknown[]} values for $2..$N (SET clause), in order
 */
function setValuesFromResult(row) {
  const m2 =
    row.justification_coherence && typeof row.justification_coherence === 'object'
      ? row.justification_coherence
      : {};
  const m3 =
    row.rubric_compliance && typeof row.rubric_compliance === 'object'
      ? row.rubric_compliance
      : {};

  const coherence =
    num(row.justification_coherence_score) ?? num(row.justification_score);

  const m3Def = Array.isArray(m3.defensible_disagreements)
    ? m3.defensible_disagreements.map(String).join('; ')
    : m3.defensible_disagreements != null
      ? String(m3.defensible_disagreements)
      : null;
  const m3Err = Array.isArray(m3.clear_errors)
    ? m3.clear_errors.map(String).join('; ')
    : m3.clear_errors != null
      ? String(m3.clear_errors)
      : null;

  const flagReasons = Array.isArray(row.flag_reasons)
    ? row.flag_reasons.map(String).join('; ')
    : row.flag_reasons != null
      ? String(row.flag_reasons)
      : null;

  return [
    ...m1FlatValues(row),
    coherence,
    str(m2.claim_verification),
    str(m2.rating_alignment),
    str(m2.likert_consistency),
    str(m2.logical_flow),
    issuesText(m2),
    str(m2.explanation),
    num(row.rubric_compliance_score),
    str(m3.overall_compliance),
    m3Def,
    m3Err,
    str(m3.explanation),
    m3AssessmentsText(m3),
    boolOrNull(row.flagged),
    flagReasons,
    str(row.annotator_likert),
    str(row.golden_likert),
    boolOrNull(row.likert_match),
    num(row.likert_penalty),
  ];
}

function buildUpdateSql(table) {
  const setParts = ['aj_eval_completed_at = NOW()', "aj_eval_status = 'COMPLETED'"];
  let n = 2;
  for (const d of M1_DIMS) {
    setParts.push(`aj_m1_${d}_a_match = $${n++}`);
    setParts.push(`aj_m1_${d}_a_penalty = $${n++}`);
    setParts.push(`aj_m1_${d}_b_match = $${n++}`);
    setParts.push(`aj_m1_${d}_b_penalty = $${n++}`);
  }
  setParts.push(`aj_m1_dimension_score = $${n++}`);
  setParts.push(`aj_final_score = $${n++}`);
  const m2m3 = [
    'aj_m2_coherence_score',
    'aj_m2_claim_verification',
    'aj_m2_rating_alignment',
    'aj_m2_likert_consistency',
    'aj_m2_logical_flow',
    'aj_m2_issues_text',
    'aj_m2_explanation',
    'aj_m3_compliance_score',
    'aj_m3_overall_compliance',
    'aj_m3_defensible_disagreements',
    'aj_m3_clear_errors',
    'aj_m3_summary_explanation',
    'aj_m3_dimension_assessments_text',
    'aj_flagged',
    'aj_flag_reasons',
    'aj_eval_annotator_likert',
    'aj_golden_likert',
    'aj_likert_match',
    'aj_likert_penalty',
  ];
  for (const col of m2m3) {
    setParts.push(`${col} = $${n++}`);
  }
  const sql = `UPDATE ${table} SET\n  ${setParts.join(',\n  ')}\nWHERE subtask_id IS NOT DISTINCT FROM $1`;
  return sql;
}

let cachedSql = null;
let cachedTable = null;

function updateSqlForTable(table) {
  if (cachedSql && cachedTable === table) return cachedSql;
  cachedTable = table;
  cachedSql = buildUpdateSql(table);
  return cachedSql;
}

/**
 * @param {string} resultsJsonPath - path to evaluation_results.json (array of EvaluationResult dicts)
 * @returns {Promise<{ updated: number; skipped_no_id: number; not_found: number }>}
 */
export async function applyAnnotatorEvaluationResults(resultsJsonPath) {
  const raw = await readFile(resultsJsonPath, 'utf8');
  const arr = JSON.parse(raw);
  if (!Array.isArray(arr)) {
    throw new Error('evaluation_results.json must be a JSON array');
  }

  const table = judgeTableName();
  const sql = updateSqlForTable(table);

  const client = new Client(getPostgresConfig());
  await client.connect();
  let updated = 0;
  let skipped_no_id = 0;
  let not_found = 0;
  try {
    for (const row of arr) {
      const sid = row.subtask_id != null ? String(row.subtask_id).trim() : '';
      if (!sid) {
        skipped_no_id += 1;
        continue;
      }
      const setVals = setValuesFromResult(row);
      const res = await client.query(sql, [sid, ...setVals]);
      const n = res.rowCount ?? 0;
      if (n === 0) not_found += 1;
      else updated += n;
    }
    return { updated, skipped_no_id, not_found };
  } finally {
    await client.end();
  }
}

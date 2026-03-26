import { spawn } from 'child_process';
import { parse } from 'csv-parse/sync';
import { mkdir, writeFile, readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { getPostgresConfig, fetchRowsForRange, fetchEvaluatedSummaryRows } from './db.js';
import { runIngest } from './ingest.js';
import { registerPipelineExports } from './csvExportRegistry.js';
import pg from 'pg';

const { Client } = pg;

function assessmentGoldenTableRawName() {
  return (process.env.GOLDEN_ASSESSMENT_TABLE || 'golden_datasets_assessments')
    .trim()
    .replace(/^"|"$/g, '');
}

function assessmentGoldenTableSql() {
  const raw = assessmentGoldenTableRawName();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw)) {
    throw new Error(`Unsafe GOLDEN_ASSESSMENT_TABLE name: "${raw}"`);
  }
  return `"${raw}"`;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BACKEND_DIR = path.join(REPO_ROOT, 'backend');
const SCRIPTS_DIR = path.join(BACKEND_DIR, 'scripts');

/**
 * Match rows by Postgres-rounded epoch ms (same as fetch + pairing). Avoids 0-row UPDATEs when
 * JS Date round-trips lose microsecond precision vs timestamptz in the DB.
 */
const UPDATE_SEC2 = `
UPDATE new_evaluation_table SET
  sec_2_judge_model = $1, sec_2_evaluation_score = $2, sec_2_evaluation_justification = $3,
  sec_2_attention_to_detail_score = $4, sec_2_attention_to_detail_justification = $5,
  sec_2_articulation_score = $6, sec_2_articulation_justification = $7,
  sec_2_comprehension_score = $8, sec_2_comprehension_justification = $9,
  sec_2_evaluated_at = NOW(), sec_2_eval_status = 'COMPLETED'
WHERE BTRIM(COALESCE(uniqueid::text, '')) IS NOT DISTINCT FROM $10
  AND (ROUND(EXTRACT(EPOCH FROM created_at) * 1000))::bigint = $11::bigint
  AND email IS NOT DISTINCT FROM $12
`;

const UPDATE_SEC3 = `
UPDATE new_evaluation_table SET
  sec3_judge_model = $1, reasoning_score = $2, reasoning_justification = $3,
  sec3_evaluation_score = $4, sec3_evaluation_justification = $5,
  sec3_articulation_score = $6, sec3_articulation_justification = $7,
  sec_3_evaluated_at = NOW(), sec_3_eval_status = 'COMPLETED'
WHERE BTRIM(COALESCE(uniqueid::text, '')) IS NOT DISTINCT FROM $8
  AND (ROUND(EXTRACT(EPOCH FROM created_at) * 1000))::bigint = $9::bigint
  AND email IS NOT DISTINCT FROM $10
`;

const UPDATE_SEC1_FROM_GOLD = (goldTableSql) => `
WITH active_gold AS (
  SELECT DISTINCT ON (BTRIM(COALESCE(g.uniqueid, '')))
    BTRIM(COALESCE(g.uniqueid, '')) AS gold_uniqueid,
    g.q1_label, g.q2_label, g.q3_label, g.q4_label, g.q5_label
  FROM ${goldTableSql} g
  WHERE COALESCE(g.is_active, true) = true
    AND COALESCE(g.purpose, '') = $3
  ORDER BY BTRIM(COALESCE(g.uniqueid, '')), g.gold_created_at DESC NULLS LAST
)
UPDATE new_evaluation_table e
SET
  sec1_q1_score = CASE WHEN e.ans_1 IS NOT DISTINCT FROM ag.q1_label THEN 1 ELSE 0 END,
  sec1_q2_score = CASE WHEN e.ans_2 IS NOT DISTINCT FROM ag.q2_label THEN 1 ELSE 0 END,
  sec1_q3_score = CASE WHEN e.ans_3 IS NOT DISTINCT FROM ag.q3_label THEN 1 ELSE 0 END,
  sec1_q4_score = CASE WHEN e.ans_4 IS NOT DISTINCT FROM ag.q4_label THEN 1 ELSE 0 END,
  sec1_q5_score = CASE WHEN e.ans_5 IS NOT DISTINCT FROM ag.q5_label THEN 1 ELSE 0 END,
  section1_total =
    (CASE WHEN e.ans_1 IS NOT DISTINCT FROM ag.q1_label THEN 1 ELSE 0 END +
     CASE WHEN e.ans_2 IS NOT DISTINCT FROM ag.q2_label THEN 1 ELSE 0 END +
     CASE WHEN e.ans_3 IS NOT DISTINCT FROM ag.q3_label THEN 1 ELSE 0 END +
     CASE WHEN e.ans_4 IS NOT DISTINCT FROM ag.q4_label THEN 1 ELSE 0 END +
     CASE WHEN e.ans_5 IS NOT DISTINCT FROM ag.q5_label THEN 1 ELSE 0 END)
FROM active_gold ag
WHERE e.created_at >= $1::timestamptz
  AND e.created_at <= $2::timestamptz
  AND BTRIM(COALESCE(e.uniqueid, '')) = ag.gold_uniqueid
`;

function escapeCsv(val) {
  const s = String(val ?? '');
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Columns for consolidated download: pre-filled responses + S1/S2/S3 scores + final + selection. */
const EVAL_SUMMARY_COLS = [
  'email',
  'uniqueid',
  'created_at',
  'created_at_epoch_ms',
  'ans_1',
  'ans_2',
  'ans_3',
  'ans_4',
  'ans_5',
  'sec1_q1_score',
  'sec1_q2_score',
  'sec1_q3_score',
  'sec1_q4_score',
  'sec1_q5_score',
  'section1_total',
  'initialvalue_prompt',
  'initialvalue_ai_response',
  'section_2_instruction',
  'task_1_response',
  'task_2_response',
  'task_3_response',
  'initialvalue_scenario',
  'initialvalue_sec_3_qn',
  'section_3_instruction',
  'sec_3_ans',
  'sec_2_judge_model',
  'sec_2_evaluation_score',
  'sec_2_evaluation_justification',
  'sec_2_attention_to_detail_score',
  'sec_2_attention_to_detail_justification',
  'sec_2_articulation_score',
  'sec_2_articulation_justification',
  'sec_2_comprehension_score',
  'sec_2_comprehension_justification',
  'sec_2_evaluated_at',
  'sec_2_eval_status',
  'sec3_judge_model',
  'reasoning_score',
  'reasoning_justification',
  'sec3_evaluation_score',
  'sec3_evaluation_justification',
  'sec3_articulation_score',
  'sec3_articulation_justification',
  'sec_3_evaluated_at',
  'sec_3_eval_status',
  'final_score',
  'post_eval_status',
  'is_selected',
];

function evalSummaryCell(r, col) {
  if (col === 'is_selected') {
    if (r.post_eval_status === 'SELECTED') return 'YES';
    if (r.post_eval_status === 'REJECTED') return 'NO';
    return '';
  }
  if (col === 'created_at' || col === 'sec_2_evaluated_at' || col === 'sec_3_evaluated_at') {
    const v = r[col];
    if (v == null || v === '') return '';
    return formatCreatedAtForCsv(v);
  }
  const v = r[col];
  if (v == null) return '';
  return v;
}

/**
 * Rows must come from fetchEvaluatedSummaryRows (Section 2+3 COMPLETED in range).
 * @param {Record<string, unknown>[]} rows
 * @param {string} filePath
 */
async function writeEvalSummaryCsv(rows, filePath) {
  const header = EVAL_SUMMARY_COLS.join(',');
  const body = rows
    .map((r) => EVAL_SUMMARY_COLS.map((c) => escapeCsv(evalSummaryCell(r, c))).join(','))
    .join('\n');
  return writeFile(filePath, header + '\n' + body, 'utf8');
}

function normalizeUniqueId(v) {
  if (v == null || v === '') return '';
  return String(v).trim();
}

/** ISO string for CSV; stable for judge scripts to echo back for row targeting. */
function formatCreatedAtForCsv(v) {
  if (v == null || v === '') return '';
  if (v instanceof Date) return v.toISOString();
  const s = String(v).trim();
  if (!s) return '';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toISOString();
}

function normalizeTimestampForKey(v) {
  if (v == null || v === '') return '';
  if (v instanceof Date) return v.toISOString();
  const s = String(v).trim();
  if (!s) return '';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toISOString();
}

/** Same instant as Postgres ROUND(EXTRACT(EPOCH FROM created_at) * 1000)::bigint (see db.js SELECT). */
function epochMsKeyFromDbRow(row) {
  if (row.created_at_epoch_ms != null) return String(row.created_at_epoch_ms);
  return String(Math.round(new Date(row.created_at).getTime()));
}

function epochMsKeyFromJudgeRow(row) {
  const e = row.created_at_epoch_ms;
  if (e != null && String(e).trim() !== '') return String(e).trim();
  return String(Math.round(new Date(row.created_at).getTime()));
}

function normalizeRowKeyFromDbRow(row) {
  const uid = normalizeUniqueId(row.uniqueid);
  const ts = epochMsKeyFromDbRow(row);
  const em = row.email != null ? String(row.email).trim() : '';
  return `${uid}\0${ts}\0${em}`;
}

function normalizeRowKeyFromJudgeRow(row) {
  const uid = normalizeUniqueId(row.uniqueid ?? row.uniqueId ?? row.unique_id);
  const ts = epochMsKeyFromJudgeRow(row);
  const em = row.email != null ? String(row.email).trim() : '';
  return `${uid}\0${ts}\0${em}`;
}

/**
 * WHERE clause values from the paired Supabase row (epoch ms matches UPDATE + pairing; email as stored).
 */
function getDbUpdateWhereFromPairedDbRow(dbRow) {
  const epochMs =
    dbRow.created_at_epoch_ms != null
      ? Number(dbRow.created_at_epoch_ms)
      : Math.round(new Date(dbRow.created_at).getTime());
  return {
    uniqueid: normalizeUniqueId(dbRow.uniqueid),
    createdAtEpochMs: epochMs,
    email: dbRow.email == null ? null : dbRow.email,
  };
}

/**
 * FIFO pairing: each judge row (in file order) consumes one Supabase row with the same normalized key.
 * Reordering in the judge file is OK; using dbRows[i] for keys is not.
 * @returns {number[]} dbIdxPerJudgeRow — pairedRows[j] is the Supabase batch index for judge CSV row j.
 */
function pairJudgeRowsToDbRows(parsedRows, dbRows, sectionLabel) {
  const byKey = new Map();
  for (let i = 0; i < dbRows.length; i++) {
    const k = normalizeRowKeyFromDbRow(dbRows[i]);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(i);
  }
  const dbIdxPerJudgeRow = [];
  for (let j = 0; j < parsedRows.length; j++) {
    const k = normalizeRowKeyFromJudgeRow(parsedRows[j]);
    const q = byKey.get(k);
    if (!q || q.length === 0) {
      throw new Error(
        `${sectionLabel}: judge CSV row ${j + 1} has no matching Supabase row (uniqueid+created_at+email).`
      );
    }
    dbIdxPerJudgeRow.push(q.shift());
  }
  for (const q of byKey.values()) {
    if (q.length > 0) {
      throw new Error(
        `${sectionLabel}: ${q.length} Supabase row(s) unmatched by judge CSV (uniqueid+created_at+email).`
      );
    }
  }
  return dbIdxPerJudgeRow;
}

function writeSection2Csv(rows, filePath) {
  const cols = [
    'email',
    'created_at',
    'created_at_epoch_ms',
    'initialvalue_prompt',
    'initialvalue_ai_response',
    'section_2_instruction',
    'task_1_response',
    'task_2_response',
    'task_3_response',
    'uniqueid',
  ];
  const header = cols.join(',');
  const body = rows
    .map((r) =>
      cols
        .map((c) => {
          if (c === 'created_at') return escapeCsv(formatCreatedAtForCsv(r.created_at));
          if (c === 'created_at_epoch_ms') {
            const ms =
              r.created_at_epoch_ms != null
                ? r.created_at_epoch_ms
                : Math.round(new Date(r.created_at).getTime());
            return escapeCsv(ms);
          }
          return escapeCsv(r[c]);
        })
        .join(',')
    )
    .join('\n');
  return writeFile(filePath, header + '\n' + body, 'utf8');
}

function writeSection3Csv(rows, filePath) {
  const cols = [
    'email',
    'created_at',
    'created_at_epoch_ms',
    'initialvalue_scenario',
    'initialvalue_sec_3_qn',
    'section_3_instruction',
    'sec_3_ans',
    'uniqueid',
  ];
  const header = cols.join(',');
  const body = rows
    .map((r) => {
      const ans = (r.sec_3_ans || r.task_3_response || '').trim() || '';
      return cols
        .map((c) => {
          if (c === 'sec_3_ans') return escapeCsv(ans);
          if (c === 'created_at') return escapeCsv(formatCreatedAtForCsv(r.created_at));
          if (c === 'created_at_epoch_ms') {
            const ms =
              r.created_at_epoch_ms != null
                ? r.created_at_epoch_ms
                : Math.round(new Date(r.created_at).getTime());
            return escapeCsv(ms);
          }
          return escapeCsv(r[c]);
        })
        .join(',');
    })
    .join('\n');
  return writeFile(filePath, header + '\n' + body, 'utf8');
}

/**
 * Parse judge output CSV. Python's csv module quotes fields that contain commas or newlines;
 * splitting the file on \\n before parsing breaks column alignment and caused Supabase updates
 * to miss rows while downloads still looked correct. Always use this (or csv-parse) for judge outputs.
 */
function parseJudgeOutputCsv(content) {
  const text = content.replace(/^\uFEFF/, '');
  const rows = parse(text, {
    columns: true,
    skip_empty_lines: true,
    bom: true,
    relax_column_count: true,
    relax_quotes: true,
    trim: true,
  });
  return Array.isArray(rows) ? rows : [];
}

/**
 * Ensures judge CSV rows map 1:1 to Supabase batch by (uniqueid, created_at, email) multiset.
 * Pairing is FIFO per key so judge output row order may differ from fetch order.
 * @returns {number[]} dbIdxPerJudgeRow — use with getDbUpdateWhereFromPairedDbRow(dbRows[idx]) for UPDATE WHERE.
 */
function assertJudgeCsvMatchesBatch(parsedRows, dbRows, sectionLabel) {
  if (parsedRows.length !== dbRows.length) {
    throw new Error(
      `${sectionLabel}: judge CSV has ${parsedRows.length} data row(s) but the Supabase batch has ${dbRows.length}. Output file and DB are out of sync.`
    );
  }
  for (let i = 0; i < dbRows.length; i++) {
    const expected = normalizeUniqueId(dbRows[i].uniqueid);
    if (!expected) {
      throw new Error(
        `${sectionLabel}: batch row ${i + 1} has empty uniqueid in Supabase; fix data before re-running eval.`
      );
    }
  }
  for (let i = 0; i < parsedRows.length; i++) {
    const pr = parsedRows[i];
    const got = normalizeUniqueId(pr.uniqueid ?? pr.uniqueId ?? pr.unique_id);
    if (!got) {
      throw new Error(`${sectionLabel}: judge CSV row ${i + 1} has empty uniqueid.`);
    }
    const hasEpoch = pr.created_at_epoch_ms != null && String(pr.created_at_epoch_ms).trim() !== '';
    if (!hasEpoch && !normalizeTimestampForKey(pr.created_at)) {
      throw new Error(
        `${sectionLabel}: judge CSV row ${i + 1} is missing created_at / created_at_epoch_ms (regenerate pipeline input CSV).`
      );
    }
  }
  return pairJudgeRowsToDbRows(parsedRows, dbRows, sectionLabel);
}

/** @returns {Promise<number>} rows updated (equals dbRows.length on success) */
async function applySection2Scores(csvPath, dbRows) {
  const content = await readFile(csvPath, 'utf8');
  const rows = parseJudgeOutputCsv(content);
  const dbIdxPerJudgeRow = assertJudgeCsvMatchesBatch(rows, dbRows, 'Section 2');

  const client = new Client(getPostgresConfig());
  await client.connect();
  let n = 0;
  try {
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const w = getDbUpdateWhereFromPairedDbRow(dbRows[dbIdxPerJudgeRow[i]]);
      const res = await client.query(UPDATE_SEC2, [
        r.judge_model || '',
        String(r.evaluation_score ?? ''),
        r.evaluation_justification || '',
        String(r.attention_to_detail_score ?? ''),
        r.attention_to_detail_justification || '',
        String(r.articulation_score ?? ''),
        r.articulation_justification || '',
        String(r.comprehension_score ?? ''),
        r.comprehension_justification || '',
        w.uniqueid,
        w.createdAtEpochMs,
        w.email,
      ]);
      const rc = res.rowCount ?? 0;
      if (rc !== 1) {
        throw new Error(
          `Section 2: UPDATE for judge CSV row ${i + 1} (uniqueid "${w.uniqueid}") affected ${rc} row(s); expected exactly 1 — paired Supabase row keys did not match a row (duplicate composite key or RLS blocking UPDATE?).`
        );
      }
      n += rc;
    }
    return n;
  } finally {
    await client.end();
  }
}

/** @returns {Promise<number>} rows updated (equals dbRows.length on success) */
async function applySection3Scores(csvPath, dbRows) {
  const content = await readFile(csvPath, 'utf8');
  const rows = parseJudgeOutputCsv(content);
  const dbIdxPerJudgeRow = assertJudgeCsvMatchesBatch(rows, dbRows, 'Section 3');

  const client = new Client(getPostgresConfig());
  await client.connect();
  let n = 0;
  try {
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const w = getDbUpdateWhereFromPairedDbRow(dbRows[dbIdxPerJudgeRow[i]]);
      const res = await client.query(UPDATE_SEC3, [
        r.judge_model || '',
        String(r.reasoning_score ?? ''),
        r.reasoning_justification || '',
        String(r.evaluation_score ?? ''),
        r.evaluation_justification || '',
        String(r.articulation_score ?? ''),
        r.articulation_justification || '',
        w.uniqueid,
        w.createdAtEpochMs,
        w.email,
      ]);
      const rc = res.rowCount ?? 0;
      if (rc !== 1) {
        throw new Error(
          `Section 3: UPDATE for judge CSV row ${i + 1} (uniqueid "${w.uniqueid}") affected ${rc} row(s); expected exactly 1 — paired Supabase row keys did not match a row (duplicate composite key or RLS blocking UPDATE?).`
        );
      }
      n += rc;
    }
    return n;
  } finally {
    await client.end();
  }
}

/**
 * Section 1 deterministic scoring against active gold labels.
 * Requires:
 * - new_evaluation_table columns: ans_1...ans_5, sec1_q*_score, section1_total
 * - assessment gold table columns: uniqueid, q1_label...q5_label, purpose, is_active, gold_created_at
 */
async function applySection1ScoresByGold(dateFrom, dateTo) {
  const client = new Client(getPostgresConfig());
  await client.connect();
  try {
    const purpose = process.env.GOLDEN_PURPOSE_LAUNCHPAD_EVAL || 'Launchpad - eval';
    const goldTableSql = assessmentGoldenTableSql();
    const res = await client.query(UPDATE_SEC1_FROM_GOLD(goldTableSql), [dateFrom, dateTo, purpose]);
    const summaryRes = await client.query(
      `
      WITH active_gold AS (
        SELECT DISTINCT ON (BTRIM(COALESCE(g.uniqueid, '')))
          BTRIM(COALESCE(g.uniqueid, '')) AS gold_uniqueid
        FROM ${goldTableSql} g
        WHERE COALESCE(g.is_active, true) = true
          AND COALESCE(g.purpose, '') = $3
        ORDER BY BTRIM(COALESCE(g.uniqueid, '')), g.gold_created_at DESC NULLS LAST
      )
      SELECT
        COUNT(*)::bigint AS compared_rows,
        COALESCE(AVG(e.section1_total::numeric), 0)::numeric(10,2) AS avg_total,
        SUM(CASE WHEN e.section1_total = 5 THEN 1 ELSE 0 END)::bigint AS perfect_rows
      FROM new_evaluation_table e
      INNER JOIN active_gold ag ON BTRIM(COALESCE(e.uniqueid, '')) = ag.gold_uniqueid
      WHERE e.created_at >= $1::timestamptz
        AND e.created_at <= $2::timestamptz
      `,
      [dateFrom, dateTo, purpose]
    );
    const row = summaryRes.rows[0] || {};
    return {
      updated: res.rowCount ?? 0,
      purpose,
      comparedRows: Number(row.compared_rows || 0),
      avgTotal: Number(row.avg_total || 0),
      perfectRows: Number(row.perfect_rows || 0),
    };
  } finally {
    await client.end();
  }
}

/**
 * Final weighted score + post-eval status.
 * Weights:
 * - Eval: 20 (avg of sec_2_evaluation_score, sec3_evaluation_score)
 * - Attention to Detail: 20 (sec_2_attention_to_detail_score)
 * - Reasoning: 20 (reasoning_score)
 * - Articulate Reasoning (Writing Skills): 25 (avg of sec_2_articulation_score, sec3_articulation_score)
 * - Comprehension (Grasping Ability): 15 (sec_2_comprehension_score)
 *
 * Formula: weighted sum / 100.
 */
async function applyFinalScoreAndPostEvalStatus(dateFrom, dateTo, threshold, section1Threshold) {
  const client = new Client(getPostgresConfig());
  await client.connect();
  try {
    const sql = `
    WITH parsed AS (
      SELECT
        e.uniqueid,
        CASE WHEN BTRIM(COALESCE(e.sec_2_evaluation_score::text, '')) ~ '^-?\\d+(\\.\\d+)?$'
          THEN e.sec_2_evaluation_score::numeric ELSE NULL END AS sec2_eval,
        CASE WHEN BTRIM(COALESCE(e.sec3_evaluation_score::text, '')) ~ '^-?\\d+(\\.\\d+)?$'
          THEN e.sec3_evaluation_score::numeric ELSE NULL END AS sec3_eval,
        CASE WHEN BTRIM(COALESCE(e.sec_2_attention_to_detail_score::text, '')) ~ '^-?\\d+(\\.\\d+)?$'
          THEN e.sec_2_attention_to_detail_score::numeric ELSE NULL END AS attention,
        CASE WHEN BTRIM(COALESCE(e.reasoning_score::text, '')) ~ '^-?\\d+(\\.\\d+)?$'
          THEN e.reasoning_score::numeric ELSE NULL END AS reasoning,
        CASE WHEN BTRIM(COALESCE(e.sec_2_articulation_score::text, '')) ~ '^-?\\d+(\\.\\d+)?$'
          THEN e.sec_2_articulation_score::numeric ELSE NULL END AS sec2_art,
        CASE WHEN BTRIM(COALESCE(e.sec3_articulation_score::text, '')) ~ '^-?\\d+(\\.\\d+)?$'
          THEN e.sec3_articulation_score::numeric ELSE NULL END AS sec3_art,
        CASE WHEN BTRIM(COALESCE(e.sec_2_comprehension_score::text, '')) ~ '^-?\\d+(\\.\\d+)?$'
          THEN e.sec_2_comprehension_score::numeric ELSE NULL END AS comprehension
      FROM new_evaluation_table e
      WHERE e.created_at >= $1::timestamptz
        AND e.created_at <= $2::timestamptz
    ),
    scored AS (
      SELECT
        p.uniqueid,
        (
          (((p.sec2_eval + p.sec3_eval) / 2.0) * 20.0) +
          (p.attention * 20.0) +
          (p.reasoning * 20.0) +
          ((((p.sec2_art + p.sec3_art) / 2.0) * 25.0)) +
          (p.comprehension * 15.0)
        ) / 100.0 AS final_score_calc
      FROM parsed p
      WHERE p.sec2_eval IS NOT NULL
        AND p.sec3_eval IS NOT NULL
        AND p.attention IS NOT NULL
        AND p.reasoning IS NOT NULL
        AND p.sec2_art IS NOT NULL
        AND p.sec3_art IS NOT NULL
        AND p.comprehension IS NOT NULL
    )
    UPDATE new_evaluation_table e
    SET
      final_score = ROUND(s.final_score_calc::numeric, 4),
      post_eval_status = CASE
        WHEN COALESCE(e.section1_total::numeric, -1) >= $4::numeric
         AND s.final_score_calc >= $3::numeric THEN 'SELECTED'
        ELSE 'REJECTED'
      END
    FROM scored s
    WHERE e.uniqueid IS NOT DISTINCT FROM s.uniqueid
    `;
    const res = await client.query(sql, [dateFrom, dateTo, threshold, section1Threshold]);
    return res.rowCount ?? 0;
  } finally {
    await client.end();
  }
}

const COMPLETED_RE = /Completed\s+(\d+)\/(\d+)/;

/** Run one judge; onLine(label, line) called for each line; resolves with { code, err } when done */
export function runJudgeStream(cmd, cwd, env, label, onLine) {
  return new Promise((resolve) => {
    const proc = spawn(cmd[0], cmd.slice(1), {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    const flush = (s) => {
      const lines = (buf + s).split(/\r?\n/);
      buf = lines.pop() || '';
      for (const line of lines) if (line) onLine(label, line);
    };
    proc.stdout.on('data', (chunk) => flush(chunk.toString('utf8')));
    proc.stderr.on('data', (chunk) => flush(chunk.toString('utf8')));
    proc.on('close', (code) => resolve({ code: code ?? -1, err: null }));
    proc.on('error', (err) => resolve({ code: -1, err: err.message }));
  });
}

/**
 * @param {object} opts
 * @param {string} opts.dateFrom
 * @param {string} opts.dateTo
 * @param {number} opts.maxRows
 * @param {string} opts.pythonCmd
 * @param {boolean} opts.skipIngest
 * @param {boolean} [opts.downloadCsv] - register short-lived token so browser can download CSVs + summary JSON
 * @param {(ev: object) => void} [send] - called for judge stdout (progress/log) so they can stream
 * @returns {AsyncGenerator<{ type: string; message?: string; section?: string; current?: number; total?: number; rows_evaluated?: number; sec2_output?: string; sec3_output?: string; csv_download_token?: string; updated_rows?: number; compared_rows?: number; avg_total?: number; perfect_rows?: number; purpose?: string }>}
 */
export async function* runPipelineEvents(opts, send = () => {}) {
  const { dateFrom, dateTo, maxRows, pythonCmd, skipIngest, downloadCsv, threshold, section1Threshold } = opts;

  yield { type: 'log', message: 'Starting pipeline…' };

  if (!skipIngest) {
    yield {
      type: 'log',
      message: `Ingesting from API (GMT/UTC range: ${dateFrom} … ${dateTo})…`,
    };
    try {
      const ing = await runIngest(dateFrom, dateTo);
      yield {
        type: 'log',
        message: `Ingest: ${ing.soul_rows_fetched} from Soul; ${ing.rows_inserted} inserted; ${ing.skipped_existing} already in DB (unchanged).`,
      };
    } catch (e) {
      yield { type: 'error', message: `Ingest failed: ${e.message}` };
      return;
    }
  } else {
    yield { type: 'log', message: 'Skipping ingest (using existing Supabase rows in range).' };
  }

  yield { type: 'log', message: 'Loading rows from Supabase…' };
  let dbRows;
  try {
    dbRows = await fetchRowsForRange(dateFrom, dateTo, maxRows);
  } catch (e) {
    yield { type: 'error', message: `DB fetch failed: ${e.message}` };
    return;
  }

  if (!dbRows.length) {
    yield {
      type: 'log',
      message: 'No rows in Supabase for this range — querying read-only Soul API and ingesting…',
    };
    try {
      const fb = await runIngest(dateFrom, dateTo);
      yield {
        type: 'log',
        message: `Fallback ingest: ${fb.soul_rows_fetched} from Soul; ${fb.rows_inserted} inserted; ${fb.skipped_existing} already in DB.`,
      };
      if (fb.soul_rows_fetched === 0) {
        yield { type: 'error', message: 'Read-only API returned no rows for this date range.' };
        return;
      }
    } catch (e) {
      yield { type: 'error', message: `Read-only ingest failed: ${e.message}` };
      return;
    }
    try {
      dbRows = await fetchRowsForRange(dateFrom, dateTo, maxRows);
    } catch (e) {
      yield { type: 'error', message: `Supabase fetch after ingest failed: ${e.message}` };
      return;
    }
    if (!dbRows.length) {
      yield {
        type: 'error',
        message: 'Supabase still empty after ingest (e.g. created_at mismatch vs Soul data).',
      };
      return;
    }
  }

  yield {
    type: 'log',
    message: `Evaluating ${dbRows.length} rows (Section 2 + Section 3 in parallel).`,
  };

  for (let i = 0; i < dbRows.length; i++) {
    if (!normalizeUniqueId(dbRows[i].uniqueid)) {
      yield {
        type: 'error',
        message: `Batch row ${i + 1} has empty uniqueid in Supabase; cannot run eval (CSV ↔ DB alignment requires a key).`,
      };
      return;
    }
  }

  yield {
    type: 'log',
    message:
      'Section 1: running deterministic gold comparison before Section 2/3 (purpose "Launchpad - eval" unless GOLDEN_PURPOSE_LAUNCHPAD_EVAL is set)…',
  };
  try {
    const s1 = await applySection1ScoresByGold(dateFrom, dateTo);
    yield {
      type: 'log',
      message: `Section 1: updated ${s1.updated} row(s); compared ${s1.comparedRows} row(s), avg total ${s1.avgTotal.toFixed(2)}, perfect ${s1.perfectRows}, purpose "${s1.purpose}".`,
    };
    yield {
      type: 'section1-summary',
      updated_rows: s1.updated,
      compared_rows: s1.comparedRows,
      avg_total: s1.avgTotal,
      perfect_rows: s1.perfectRows,
      purpose: s1.purpose,
    };
  } catch (e) {
    yield {
      type: 'error',
      message:
        `Section 1 DB update failed: ${e.message}. Ensure columns exist in new_evaluation_table and ${assessmentGoldenTableRawName()} (uniqueid/q*_label/purpose/is_active).`,
    };
    return;
  }

  await mkdir(SCRIPTS_DIR, { recursive: true });
  const runId = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .slice(0, 19);
  const sec2In = path.join(SCRIPTS_DIR, `pipeline_s2_${runId}.csv`);
  const sec3In = path.join(SCRIPTS_DIR, `pipeline_s3_${runId}.csv`);
  const sec2Out = path.join(SCRIPTS_DIR, `pipeline_s2_${runId}_output.csv`);
  const sec3Out = path.join(SCRIPTS_DIR, `pipeline_s3_${runId}_output.csv`);

  await writeSection2Csv(dbRows, sec2In);
  await writeSection3Csv(dbRows, sec3In);

  const judge2 = path.join(SCRIPTS_DIR, 'judge_section2.py');
  const judge3 = path.join(SCRIPTS_DIR, 'judge_section3.py');
  const nRows = String(dbRows.length);

  const cmd2 = [pythonCmd, judge2, '--input', sec2In, '--output', sec2Out, '--max-rows', nRows];
  const cmd3 = [pythonCmd, judge3, '--input', sec3In, '--output', sec3Out, '--max-rows', nRows];

  const onLine = (label, line) => {
    const m = line.match(COMPLETED_RE);
    if (m) send({ type: 'progress', section: label, current: parseInt(m[1], 10), total: parseInt(m[2], 10) });
    send({ type: 'log', message: `[${label.toUpperCase()}] ${line}` });
  };

  const [result2, result3] = await Promise.all([
    runJudgeStream(cmd2, SCRIPTS_DIR, process.env, 's2', onLine),
    runJudgeStream(cmd3, SCRIPTS_DIR, process.env, 's3', onLine),
  ]);

  if (result2.err) yield { type: 'error', message: `Judge s2 error: ${result2.err}` };
  else if (result2.code !== 0) yield { type: 'error', message: `Judge s2 exited with code ${result2.code}` };
  else yield { type: 'log', message: 'Judge s2 finished OK.' };

  if (result3.err) yield { type: 'error', message: `Judge s3 error: ${result3.err}` };
  else if (result3.code !== 0) yield { type: 'error', message: `Judge s3 exited with code ${result3.code}` };
  else yield { type: 'log', message: 'Judge s3 finished OK.' };

  if (result2.code !== 0 || result3.code !== 0) {
    yield { type: 'error', message: 'Pipeline stopped: one or both judges failed; Supabase not updated.' };
    return;
  }

  const fs = await import('fs');
  if (!fs.existsSync(sec2Out) || !fs.existsSync(sec3Out)) {
    yield { type: 'error', message: 'Missing judge output CSV.' };
    return;
  }

  yield {
    type: 'log',
    message:
      'Writing Section 2 scores to Supabase (CSV parsed with csv-parse; each row targets uniqueid+created_at+email)…',
  };
  try {
    const n2 = await applySection2Scores(sec2Out, dbRows);
    yield {
      type: 'log',
      message: `Section 2: updated ${n2} row(s); output CSV row count and uniqueids match the ${dbRows.length}-row batch.`,
    };
  } catch (e) {
    yield { type: 'error', message: `Section 2 DB update failed: ${e.message}` };
    return;
  }

  yield { type: 'log', message: 'Writing Section 3 scores to Supabase…' };
  try {
    const n3 = await applySection3Scores(sec3Out, dbRows);
    yield {
      type: 'log',
      message: `Section 3: updated ${n3} row(s); output CSV row count and uniqueids match the ${dbRows.length}-row batch.`,
    };
  } catch (e) {
    yield { type: 'error', message: `Section 3 DB update failed: ${e.message}` };
    return;
  }

  yield {
    type: 'log',
    message: `Computing final weighted score and post-eval status (final threshold: ${threshold}, section1 threshold: ${section1Threshold})…`,
  };
  try {
    const n = await applyFinalScoreAndPostEvalStatus(dateFrom, dateTo, threshold, section1Threshold);
    yield {
      type: 'log',
      message: `Final score/post-eval status updated for ${n} row(s).`,
    };
  } catch (e) {
    yield { type: 'error', message: `Final score computation failed: ${e.message}` };
    return;
  }

  let csv_download_token;
  if (downloadCsv) {
    let evalSummaryPath = null;
    let evalSummaryRowCount = 0;
    try {
      const summaryRows = await fetchEvaluatedSummaryRows(dateFrom, dateTo, maxRows);
      evalSummaryRowCount = summaryRows.length;
      evalSummaryPath = path.join(SCRIPTS_DIR, `pipeline_eval_summary_${runId}.csv`);
      await writeEvalSummaryCsv(summaryRows, evalSummaryPath);
      yield {
        type: 'log',
        message: `Eval summary CSV: ${evalSummaryRowCount} row(s) with Section 2+3 COMPLETED in range (pre-filled + scores + selection).`,
      };
    } catch (e) {
      yield { type: 'log', message: `Eval summary CSV: skipped (${e.message}).` };
    }
    const summary = JSON.stringify(
      {
        run_at: new Date().toISOString(),
        date_from_utc: dateFrom,
        date_to_utc: dateTo,
        rows_evaluated: dbRows.length,
        eval_summary_rows: evalSummaryRowCount,
        files: {
          section2_input: path.basename(sec2In),
          section3_input: path.basename(sec3In),
          section2_output: path.basename(sec2Out),
          section3_output: path.basename(sec3Out),
          eval_summary: evalSummaryPath ? path.basename(evalSummaryPath) : null,
        },
      },
      null,
      2
    );
    csv_download_token = registerPipelineExports(SCRIPTS_DIR, {
      sec2In,
      sec3In,
      sec2Out,
      sec3Out,
      evalSummary: evalSummaryPath,
      summary,
    });
  }

  yield {
    type: 'done',
    rows_evaluated: dbRows.length,
    sec2_output: sec2Out,
    sec3_output: sec3Out,
    ...(csv_download_token && { csv_download_token }),
  };
}

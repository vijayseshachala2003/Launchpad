import { spawn } from 'child_process';
import { mkdir, writeFile, readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { getPostgresConfig, fetchRowsForRange } from './db.js';
import { runIngest } from './ingest.js';
import pg from 'pg';

const { Client } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BACKEND_DIR = path.join(REPO_ROOT, 'backend');
const SCRIPTS_DIR = path.join(BACKEND_DIR, 'scripts');

const UPDATE_SEC2 = `
UPDATE new_evaluation_table SET
  sec_2_judge_model = $1, sec_2_evaluation_score = $2, sec_2_evaluation_justification = $3,
  sec_2_attention_to_detail_score = $4, sec_2_attention_to_detail_justification = $5,
  sec_2_articulation_score = $6, sec_2_articulation_justification = $7,
  sec_2_comprehension_score = $8, sec_2_comprehension_justification = $9
WHERE uniqueid = $10
`;

const UPDATE_SEC3 = `
UPDATE new_evaluation_table SET
  sec3_judge_model = $1, reasoning_score = $2, reasoning_justification = $3,
  sec3_evaluation_score = $4, sec3_evaluation_justification = $5,
  sec3_articulation_score = $6, sec3_articulation_justification = $7
WHERE uniqueid = $8
`;

function escapeCsv(val) {
  const s = String(val ?? '');
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function writeSection2Csv(rows, filePath) {
  const cols = [
    'email',
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
      cols.map((c) => escapeCsv(r[c])).join(',')
    )
    .join('\n');
  return writeFile(filePath, header + '\n' + body, 'utf8');
}

function writeSection3Csv(rows, filePath) {
  const cols = [
    'email',
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
        .map((c) => (c === 'sec_3_ans' ? escapeCsv(ans) : escapeCsv(r[c])))
        .join(',');
    })
    .join('\n');
  return writeFile(filePath, header + '\n' + body, 'utf8');
}

function parseCsv(content) {
  const lines = content.trim().split(/\r?\n/);
  if (!lines.length) return [];
  const parseRow = (line) => {
    const values = [];
    let cur = '';
    let inQuotes = false;
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      if (ch === '"') inQuotes = !inQuotes;
      else if (ch === ',' && !inQuotes) {
        values.push(cur.replace(/^"|"$/g, '').replace(/""/g, '"').trim());
        cur = '';
      } else cur += ch;
    }
    values.push(cur.replace(/^"|"$/g, '').replace(/""/g, '"').trim());
    return values;
  };
  const header = parseRow(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseRow(lines[i]);
    const row = {};
    header.forEach((h, idx) => (row[h] = values[idx] ?? ''));
    rows.push(row);
  }
  return rows;
}

async function applySection2Scores(csvPath) {
  const content = await readFile(csvPath, 'utf8');
  const rows = parseCsv(content.replace(/^\uFEFF/, ''));
  const client = new Client(getPostgresConfig());
  await client.connect();
  let n = 0;
  try {
    for (const r of rows) {
      const uid = (r.uniqueid || r.uniqueId || '').trim();
      if (!uid) continue;
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
        uid,
      ]);
      n += res.rowCount ?? 0;
    }
    return n;
  } finally {
    await client.end();
  }
}

async function applySection3Scores(csvPath) {
  const content = await readFile(csvPath, 'utf8');
  const rows = parseCsv(content.replace(/^\uFEFF/, ''));
  const client = new Client(getPostgresConfig());
  await client.connect();
  let n = 0;
  try {
    for (const r of rows) {
      const uid = (r.uniqueid || r.uniqueId || '').trim();
      if (!uid) continue;
      const res = await client.query(UPDATE_SEC3, [
        r.judge_model || '',
        String(r.reasoning_score ?? ''),
        r.reasoning_justification || '',
        String(r.evaluation_score ?? ''),
        r.evaluation_justification || '',
        String(r.articulation_score ?? ''),
        r.articulation_justification || '',
        uid,
      ]);
      n += res.rowCount ?? 0;
    }
    return n;
  } finally {
    await client.end();
  }
}

const COMPLETED_RE = /Completed\s+(\d+)\/(\d+)/;

/** Run one judge; onLine(label, line) called for each line; resolves with { code, err } when done */
function runJudgeStream(cmd, cwd, env, label, onLine) {
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
 * @param {(ev: object) => void} [send] - called for judge stdout (progress/log) so they can stream
 * @returns {AsyncGenerator<{ type: string; message?: string; section?: string; current?: number; total?: number; rows_evaluated?: number; sec2_output?: string; sec3_output?: string }>}
 */
export async function* runPipelineEvents(opts, send = () => {}) {
  const { dateFrom, dateTo, maxRows, pythonCmd, skipIngest } = opts;

  yield { type: 'log', message: 'Starting pipeline…' };

  if (!skipIngest) {
    yield {
      type: 'log',
      message: `Ingesting from API (GMT/UTC range: ${dateFrom} … ${dateTo})…`,
    };
    try {
      const n = await runIngest(dateFrom, dateTo);
      yield { type: 'log', message: `Ingest upserted ${n} rows into new_evaluation_table.` };
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
      const nFallback = await runIngest(dateFrom, dateTo);
      yield {
        type: 'log',
        message: `Read-only ingest complete: ${nFallback} row(s) upserted into Supabase.`,
      };
    } catch (e) {
      yield { type: 'error', message: `Read-only ingest failed: ${e.message}` };
      return;
    }
    if (nFallback === 0) {
      yield { type: 'error', message: 'Read-only API returned no rows for this date range.' };
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

  const { existsSync } = await import('fs');
  const fs = await import('fs');
  if (!fs.existsSync(sec2Out) || !fs.existsSync(sec3Out)) {
    yield { type: 'error', message: 'Missing judge output CSV.' };
    return;
  }

  yield { type: 'log', message: 'Writing Section 2 scores to Supabase…' };
  try {
    const n2 = await applySection2Scores(sec2Out);
    yield { type: 'log', message: `Updated ${n2} rows (Section 2 columns).` };
  } catch (e) {
    yield { type: 'error', message: `Section 2 DB update failed: ${e.message}` };
    return;
  }

  yield { type: 'log', message: 'Writing Section 3 scores to Supabase…' };
  try {
    const n3 = await applySection3Scores(sec3Out);
    yield { type: 'log', message: `Updated ${n3} rows (Section 3 columns).` };
  } catch (e) {
    yield { type: 'error', message: `Section 3 DB update failed: ${e.message}` };
    return;
  }

  yield {
    type: 'done',
    rows_evaluated: dbRows.length,
    sec2_output: sec2Out,
    sec3_output: sec3Out,
  };
}

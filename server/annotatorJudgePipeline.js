import { existsSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  fetchAnnotatorRowsWithGold,
  fetchGoldenRowsForSubtaskIds,
  GOLDEN_CSV_COLUMNS,
} from './annotatorJudgeDb.js';
import { ANNOTATOR_JUDGE_CSV_COLUMNS, runJudgeIngest } from './ingestJudge.js';
import { applyAnnotatorEvaluationResults } from './annotatorJudgeApplyResults.js';
import { registerAnnotatorJudgeExports } from './annotatorJudgeExportRegistry.js';
import { runJudgeStream } from './pipeline.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SCRIPTS_DIR = path.join(REPO_ROOT, 'backend', 'scripts');
const ANNOTATOR_JUDGE_DIR = path.join(REPO_ROOT, 'backend', 'annotator-judge');
const BATCH_EVAL = path.join(ANNOTATOR_JUDGE_DIR, 'batch_evaluate.py');
const DEFAULT_MAPPINGS = path.join(ANNOTATOR_JUDGE_DIR, 'config', 'ae_v1_mappings.json');

function escapeCsv(val) {
  const s = String(val ?? '');
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function cell(v) {
  if (v == null || v === '') return '';
  if (v instanceof Date) return v.toISOString();
  return v;
}

function writeCsvRows(rows, columns, filePath) {
  const header = columns.join(',');
  const body = rows.map((r) => columns.map((c) => escapeCsv(cell(r[c]))).join(',')).join('\n');
  return writeFile(filePath, `${header}\n${body}`, 'utf8');
}

function safeRubricPath(requested) {
  const p = (requested || '').trim();
  if (!p) return null;
  const abs = path.isAbsolute(p) ? path.normalize(p) : path.resolve(REPO_ROOT, p.replace(/^\//, ''));
  const aj = path.resolve(ANNOTATOR_JUDGE_DIR);
  if (!abs.startsWith(aj + path.sep) && abs !== aj) return null;
  if (!existsSync(abs)) return null;
  return abs;
}

/**
 * @param {object} opts
 * @param {string} opts.dateFrom
 * @param {string} opts.dateTo
 * @param {number} opts.maxRows
 * @param {string} opts.pythonCmd
 * @param {boolean} opts.skipIngest
 * @param {boolean} opts.useLlm
 * @param {number} opts.batchSize
 * @param {string} [opts.rubricPath] - path relative to repo root, must be under backend/annotator-judge/
 * @param {boolean} opts.downloadCsv
 */
export async function* runAnnotatorJudgePipelineEvents(opts, send = () => {}) {
  const {
    dateFrom,
    dateTo,
    maxRows,
    pythonCmd,
    skipIngest,
    useLlm,
    batchSize,
    rubricPath: rubricPathOpt,
    downloadCsv,
  } = opts;

  if (!existsSync(DEFAULT_MAPPINGS)) {
    yield { type: 'error', message: `Missing mappings: ${DEFAULT_MAPPINGS}` };
    return;
  }
  if (!existsSync(BATCH_EVAL)) {
    yield { type: 'error', message: `Missing ${BATCH_EVAL}` };
    return;
  }

  const rubricPath =
    safeRubricPath(rubricPathOpt) ||
    safeRubricPath(process.env.ANNOTATOR_RUBRIC_PATH || '');

  if (!skipIngest) {
    yield { type: 'log', message: 'Ingesting Soul → annotator_judge_table…' };
    try {
      const ing = await runJudgeIngest(dateFrom, dateTo);
      yield {
        type: 'log',
        message: `Ingest: ${ing.soul_rows_fetched} from Soul; ${ing.rows_inserted} inserted; ${ing.skipped_existing} already in DB (unchanged).`,
      };
    } catch (e) {
      yield { type: 'error', message: `Judge ingest failed: ${e.message}` };
      return;
    }
  } else {
    yield { type: 'log', message: 'Skipping judge ingest (using existing annotator_judge_table rows).' };
  }

  yield { type: 'log', message: 'Loading rows (annotator ∩ golden-mock-tasking on subtask_id)…' };
  let annRows;
  try {
    annRows = await fetchAnnotatorRowsWithGold(dateFrom, dateTo, maxRows);
  } catch (e) {
    yield { type: 'error', message: `DB error: ${e.message}` };
    return;
  }

  if (!annRows.length && !skipIngest) {
    yield { type: 'log', message: 'No joined rows; attempting Soul ingest again…' };
    try {
      const again = await runJudgeIngest(dateFrom, dateTo);
      yield {
        type: 'log',
        message: `Retry ingest: ${again.soul_rows_fetched} from Soul; ${again.rows_inserted} inserted; ${again.skipped_existing} already in DB.`,
      };
      annRows = await fetchAnnotatorRowsWithGold(dateFrom, dateTo, maxRows);
    } catch (e) {
      yield { type: 'error', message: e.message };
      return;
    }
  }

  if (!annRows.length) {
    yield {
      type: 'error',
      message:
        'No annotator rows with a matching gold row (trimmed subtask_id) in this date range. Align Soul uniqueId with golden-mock-tasking.subtask_id.',
    };
    return;
  }

  const ids = annRows.map((r) => r.subtask_id);
  let goldRows;
  try {
    goldRows = await fetchGoldenRowsForSubtaskIds(ids);
  } catch (e) {
    yield { type: 'error', message: `Gold fetch failed: ${e.message}` };
    return;
  }

  if (!goldRows.length) {
    yield { type: 'error', message: 'No gold rows returned for annotator subtask_ids.' };
    return;
  }

  await mkdir(SCRIPTS_DIR, { recursive: true });
  const runId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const annCsv = path.join(SCRIPTS_DIR, `aj_annotator_${runId}.csv`);
  const goldCsv = path.join(SCRIPTS_DIR, `aj_golden_${runId}.csv`);
  const outDir = path.join(SCRIPTS_DIR, `aj_eval_out_${runId}`);
  await mkdir(outDir, { recursive: true });

  await writeCsvRows(annRows, ANNOTATOR_JUDGE_CSV_COLUMNS, annCsv);
  await writeCsvRows(goldRows, GOLDEN_CSV_COLUMNS, goldCsv);

  yield {
    type: 'log',
    message: `Prepared ${annRows.length} annotator × ${goldRows.length} gold row(s). Running batch_evaluate.py (M1${useLlm ? ' + M2' : ''}${useLlm && rubricPath ? ' + M3' : ''})…`,
  };

  const cmd = [
    pythonCmd,
    BATCH_EVAL,
    '--annotator-csv',
    annCsv,
    '--golden-csv',
    goldCsv,
    '--mappings',
    DEFAULT_MAPPINGS,
    '-o',
    outDir,
    '--batch-size',
    String(Math.min(20, Math.max(1, batchSize || 5))),
  ];
  if (useLlm) cmd.push('--use-llm');
  if (useLlm && rubricPath) {
    cmd.push('--rubric', rubricPath);
    yield { type: 'log', message: `Using rubric: ${path.basename(rubricPath)}` };
  } else if (useLlm && rubricPathOpt && !rubricPath) {
    yield { type: 'log', message: 'Rubric path ignored (missing or not under backend/annotator-judge/).' };
  }

  const pyPath = [ANNOTATOR_JUDGE_DIR, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);

  const onLine = (_label, line) => {
    send({ type: 'log', message: line });
  };

  const result = await runJudgeStream(
    cmd,
    ANNOTATOR_JUDGE_DIR,
    { ...process.env, PYTHONPATH: pyPath },
    'aj',
    onLine
  );

  if (result.err) {
    yield { type: 'error', message: `Python: ${result.err}` };
    return;
  }
  if (result.code !== 0) {
    yield { type: 'error', message: `batch_evaluate.py exited with code ${result.code}` };
    return;
  }

  const resultsJson = path.join(outDir, 'evaluation_results.json');
  if (!existsSync(resultsJson)) {
    yield { type: 'error', message: `Missing output: ${resultsJson}` };
    return;
  }

  yield { type: 'log', message: 'Writing evaluation_results.json to annotator_judge_table (flat aj_m1/aj_m2/aj_m3 columns)…' };
  try {
    const apply = await applyAnnotatorEvaluationResults(resultsJson);
    yield {
      type: 'log',
      message: `Supabase: ${apply.updated} row(s) updated with judge output.${apply.not_found ? ` ${apply.not_found} result(s) had no matching subtask_id in DB.` : ''}${apply.skipped_no_id ? ` ${apply.skipped_no_id} skipped (empty subtask_id).` : ''}`,
    };
  } catch (e) {
    yield {
      type: 'error',
      message: `Failed to persist evaluation to Supabase: ${e.message}. Run server/sql/annotator_judge_eval_columns.sql if the table is missing flattened judge columns.`,
    };
    return;
  }
  const summaryTxt = path.join(outDir, 'summary_report.txt');
  const fullResults = path.join(outDir, 'full_results.csv');

  let csvToken;
  if (downloadCsv) {
    csvToken = registerAnnotatorJudgeExports(SCRIPTS_DIR, {
      annotatorCsv: annCsv,
      goldenCsv: goldCsv,
      resultsJson,
      summaryTxt,
      fullResultsCsv: existsSync(fullResults) ? fullResults : undefined,
    });
  }

  yield {
    type: 'done',
    message: 'Annotator judge run complete.',
    rows_evaluated: annRows.length,
    csv_download_token: csvToken,
    output_dir: outDir,
  };
}

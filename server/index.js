import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { wallToUtcIso, expandUtcEndInclusive } from './datetimeTz.js';
import { runJudgeIngest } from './ingestJudge.js';
import { runAnnotatorJudgePipelineEvents } from './annotatorJudgePipeline.js';
import { runPipelineEvents } from './pipeline.js';
import { serveExport } from './csvExportRegistry.js';
import { serveAnnotatorJudgeExport } from './annotatorJudgeExportRegistry.js';
import { verifyAnnotatorJudgeDbConnection } from './annotatorJudgeDb.js';
import { attachSseKeepalive, setupSseHeaders } from './sseStream.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const FRONTEND_DIST = path.join(REPO_ROOT, 'frontend', 'dist');
const FRONTEND_FALLBACK = path.join(REPO_ROOT, 'frontend');

dotenv.config({ path: path.join(REPO_ROOT, 'backend', '.env') });

// Production app URL (used for CORS). Override with APP_ORIGIN for multiple origins.
const APP_ORIGIN = process.env.APP_ORIGIN
  ? process.env.APP_ORIGIN.split(',').map((o) => o.trim())
  : ['http://localhost:5173', 'http://127.0.0.1:5173'];

const app = express();
app.use(
  cors({
    origin: APP_ORIGIN,
    credentials: true,
  })
);
app.use(express.json());

const staticDir = existsSync(path.join(FRONTEND_DIST, 'index.html'))
  ? FRONTEND_DIST
  : FRONTEND_FALLBACK;
app.use(express.static(staticDir));

app.get('/', (req, res) => {
  res.sendFile(path.join(staticDir, 'index.html'));
});

/** Short-lived downloads for pipeline CSVs + run summary JSON (token from SSE `done` event). */
app.get('/api/pipeline/export/:token/:which', async (req, res) => {
  const { token, which } = req.params;
  const result = await serveExport(token, which);
  if (result.error) {
    return res.status(result.status).json({ error: result.error });
  }
  res.setHeader('Content-Type', result.contentType);
  res.setHeader('Content-Disposition', result.disposition);
  res.send(result.body);
});

/** Confirms DATABASE_URL / SUPABASE_DB_* and counts rows on annotator + golden tables (join sanity check). */
app.get('/api/annotator-judge/db-status', async (_req, res) => {
  try {
    const result = await verifyAnnotatorJudgeDbConnection();
    res.status(result.ok ? 200 : 503).json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

/** Downloads after `POST /api/annotator-judge-pipeline` (`which` = annotator-input | golden-input | evaluation-results | summary-report | full-results). */
app.get('/api/annotator-judge/export/:token/:which', async (req, res) => {
  const { token, which } = req.params;
  const result = await serveAnnotatorJudgeExport(token, which);
  if (result.error) {
    return res.status(result.status).json({ error: result.error });
  }
  res.setHeader('Content-Type', result.contentType);
  res.setHeader('Content-Disposition', result.disposition);
  res.send(result.body);
});

app.post('/api/pipeline', async (req, res) => {
  const data = req.body || {};
  const rawFrom = (data.date_from || '').trim();
  const rawTo = (data.date_to || '').trim();
  if (!rawFrom || !rawTo) {
    return res.status(400).json({ error: 'date_from and date_to are required (ISO datetime).' });
  }

  let tzName = (data.timezone || process.env.PIPELINE_TIMEZONE || 'UTC').trim() || 'UTC';
  if (tzName.toUpperCase() === 'GMT') tzName = 'UTC';

  let dateFrom, dateTo;
  try {
    dateFrom = wallToUtcIso(rawFrom, tzName);
    dateTo = expandUtcEndInclusive(wallToUtcIso(rawTo, tzName));
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const df = new Date(dateFrom);
  const dt = new Date(dateTo);
  if (df > dt) {
    return res
      .status(400)
      .json({ error: 'date_from must be before or equal to date_to (in the selected timezone).' });
  }

  let maxRows = parseInt(data.max_rows, 10);
  if (Number.isNaN(maxRows)) maxRows = 0;
  const skipIngest = Boolean(data.skip_ingest);
  const downloadCsv = Boolean(data.download_csv);

  const pythonCmd = process.env.PIPELINE_PYTHON || 'python3';

  setupSseHeaders(res);
  res.flushHeaders?.();
  const stopKeepalive = attachSseKeepalive(res);

  const send = (ev) => {
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
    res.flush?.();
  };

  try {
    for await (const ev of runPipelineEvents(
      {
        dateFrom,
        dateTo,
        maxRows,
        pythonCmd,
        skipIngest,
        downloadCsv,
      },
      send
    )) {
      send(ev);
    }
  } catch (e) {
    send({ type: 'error', message: String(e.message) });
  } finally {
    stopKeepalive();
    res.end();
  }
});

/** Soul → Supabase ingest for annotator-judge stages (table `annotator_judge_table`). Same date semantics as `/api/pipeline`. */
app.post('/api/judge-ingest', async (req, res) => {
  const data = req.body || {};
  const rawFrom = (data.date_from || '').trim();
  const rawTo = (data.date_to || '').trim();
  if (!rawFrom || !rawTo) {
    return res.status(400).json({ error: 'date_from and date_to are required (ISO datetime).' });
  }

  let tzName = (data.timezone || process.env.PIPELINE_TIMEZONE || 'UTC').trim() || 'UTC';
  if (tzName.toUpperCase() === 'GMT') tzName = 'UTC';

  let dateFrom, dateTo;
  try {
    dateFrom = wallToUtcIso(rawFrom, tzName);
    dateTo = expandUtcEndInclusive(wallToUtcIso(rawTo, tzName));
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const df = new Date(dateFrom);
  const dt = new Date(dateTo);
  if (df > dt) {
    return res
      .status(400)
      .json({ error: 'date_from must be before or equal to date_to (in the selected timezone).' });
  }

  try {
    const ing = await runJudgeIngest(dateFrom, dateTo);
    return res.json({
      ok: true,
      soul_rows_fetched: ing.soul_rows_fetched,
      skipped_existing: ing.skipped_existing,
      rows_inserted: ing.rows_inserted,
    });
  } catch (e) {
    console.error('judge-ingest', e);
    return res.status(500).json({ error: String(e.message || e) });
  }
});

/**
 * Full annotator path: optional Soul ingest → join annotator_judge_table + golden-mock-tasking →
 * spawn backend/annotator-judge/batch_evaluate.py (M1; M2/M3 with --use-llm and optional rubric).
 */
app.post('/api/annotator-judge-pipeline', async (req, res) => {
  const data = req.body || {};
  const rawFrom = (data.date_from || '').trim();
  const rawTo = (data.date_to || '').trim();
  if (!rawFrom || !rawTo) {
    return res.status(400).json({ error: 'date_from and date_to are required (ISO datetime).' });
  }

  let tzName = (data.timezone || process.env.PIPELINE_TIMEZONE || 'UTC').trim() || 'UTC';
  if (tzName.toUpperCase() === 'GMT') tzName = 'UTC';

  let dateFrom, dateTo;
  try {
    dateFrom = wallToUtcIso(rawFrom, tzName);
    dateTo = expandUtcEndInclusive(wallToUtcIso(rawTo, tzName));
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const df = new Date(dateFrom);
  const dt = new Date(dateTo);
  if (df > dt) {
    return res
      .status(400)
      .json({ error: 'date_from must be before or equal to date_to (in the selected timezone).' });
  }

  let maxRows = parseInt(data.max_rows, 10);
  if (Number.isNaN(maxRows)) maxRows = 0;
  const skipIngest = Boolean(data.skip_ingest);
  const useLlm = Boolean(data.use_llm);
  let batchSize = parseInt(data.batch_size, 10);
  if (Number.isNaN(batchSize)) batchSize = 5;
  const downloadCsv = Boolean(data.download_csv);
  const rubricPath = (data.rubric_path || '').trim();
  const pythonCmd = process.env.PIPELINE_PYTHON || 'python3';

  setupSseHeaders(res);
  res.flushHeaders?.();
  const stopKeepalive = attachSseKeepalive(res);

  const send = (ev) => {
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
    res.flush?.();
  };

  try {
    for await (const ev of runAnnotatorJudgePipelineEvents(
      {
        dateFrom,
        dateTo,
        maxRows,
        pythonCmd,
        skipIngest,
        useLlm,
        batchSize,
        rubricPath,
        downloadCsv,
      },
      send
    )) {
      send(ev);
    }
  } catch (e) {
    send({ type: 'error', message: String(e.message) });
  } finally {
    stopKeepalive();
    res.end();
  }
});

const PORT = parseInt(process.env.PORT || '5050', 10);
const HOST = process.env.HOST || '0.0.0.0';

app.listen(PORT, HOST, () => {
  console.log(`Launchpad Eval server at http://${HOST}:${PORT}`);
});

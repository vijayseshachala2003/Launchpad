import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { wallToUtcIso, expandUtcEndInclusive } from './datetimeTz.js';
import { runPipelineEvents } from './pipeline.js';
import { serveExport } from './csvExportRegistry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const FRONTEND_DIST = path.join(REPO_ROOT, 'frontend', 'dist');
const FRONTEND_FALLBACK = path.join(REPO_ROOT, 'frontend');

dotenv.config({ path: path.join(REPO_ROOT, 'backend', '.env') });

// Production app URL (used for CORS). Override with APP_ORIGIN for multiple origins.
const APP_ORIGIN = process.env.APP_ORIGIN
  ? process.env.APP_ORIGIN.split(',').map((o) => o.trim())
  : ['https://teamdeccanrm.in', 'http://localhost:5173', 'http://127.0.0.1:5173'];

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

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

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
    res.end();
  }
});

const PORT = parseInt(process.env.PORT || '5050', 10);
const HOST = process.env.HOST || '0.0.0.0';

app.listen(PORT, HOST, () => {
  console.log(`Launchpad Eval API at http://${HOST}:${PORT}`);
});

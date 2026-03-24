# Launchpad Eval — `server/` (Node.js)

Full repo layout: **[../README.md](../README.md)** (`frontend/` vs `server/` vs `backend/`).

Express app: serves the React app and runs the pipeline (ingest from Soul API → Supabase, fetch rows, run Section 2 & 3 Python judges in parallel, write scores back).

- **`index.js`** — Express app, static files, `POST /api/pipeline` (SSE), `POST /api/judge-ingest`, `POST /api/annotator-judge-pipeline` (SSE), export GETs for Launchpad + annotator judge.
- **`csvExportRegistry.js`** — Short-lived tokens for pipeline file downloads.
- **`pipeline.js`** — Launchpad pipeline; spawns `judge_section2.py` / `judge_section3.py`; exports `runJudgeStream`.
- **`annotatorJudgePipeline.js`** — Join `annotator_judge_table` + `golden-mock-tasking`, run `backend/annotator-judge/batch_evaluate.py`, then write `evaluation_results.json` back to `annotator_judge_table` (`aj_eval_*` columns).
- **`annotatorJudgeApplyResults.js`** — Applies judge JSON to Supabase by `subtask_id`.
- **`annotatorJudgeDb.js`**, **`annotatorJudgeExportRegistry.js`** — DB queries + download tokens for annotator runs.
- **`ingest.js`** — Soul API client + Supabase upsert (with created_at+email guard).
- **`db.js`** — Postgres/Supabase config and `fetchRowsForRange`.
- **`datetimeTz.js`** — Wall time in IANA TZ → UTC ISO.

Loads **`backend/.env`** so `OPENAI_API_KEY` and DB config are available. Postgres: prefer **`DATABASE_URL`** or **`SUPABASE_DATABASE_URL`** (Supabase connection string); otherwise **`SUPABASE_DB_HOST`**, **`SUPABASE_DB_USER`**, **`SUPABASE_DB_PASSWORD`**, etc.

**Check DB + annotator tables:** `GET /api/annotator-judge/db-status` (row counts and join count).

**Annotator judge DB columns:** New installs use **`sql/annotator_judge_table.sql`**. Judge metrics are **flat columns** (`aj_m1_*` per dimension, `aj_m2_*`, `aj_m3_*`, scores, likert flags) — no JSONB results column. Existing DBs: run **`sql/annotator_judge_eval_columns.sql`** once (adds columns and drops legacy `aj_eval_results` if present).

**Gold labels (annotator-judge):** Create table with **`sql/golden-mock-tasking.sql`**, then load the bundled CSV:

```bash
cd server && npm install && npm run load-golden-mock
```

Override path with **`GOLDEN_MOCK_CSV`**. Table name in Postgres: **`"golden-mock-tasking"`** (quoted, hyphenated).

**CORS:** By default allows the Vite dev origins (`localhost` / `127.0.0.1` on port 5173). For production, set `APP_ORIGIN` (comma-separated list), e.g. `https://your-domain.com,http://localhost:5173`.

**Long SSE streams (`POST /api/pipeline`, `POST /api/annotator-judge-pipeline`):** The server sends periodic SSE comment pings so idle connections are not dropped by HTTP/2 or reverse proxies. If you still see `ERR_HTTP2_PROTOCOL_ERROR` in the browser, configure the proxy with long read timeouts and buffering off, for example:

```nginx
location /api/pipeline {
  proxy_pass http://127.0.0.1:5050;
  proxy_http_version 1.1;
  proxy_buffering off;
  proxy_read_timeout 3600s;
  chunked_transfer_encoding on;
}
```

Repeat for `/api/annotator-judge-pipeline` if exposed. Cloudflare “orange cloud” can also interrupt very long streams unless timeouts/proxy settings match.

Run from repo root:

```bash
cd server && npm install && npm start
```

Or `npm run dev` for watch mode. Default: `http://0.0.0.0:5050`.

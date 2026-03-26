# Launchpad Eval — `server/` (Node.js)

Full repo layout: **[../README.md](../README.md)** (`frontend/` vs `server/` vs `backend/`).

Express app: serves the React app and runs the pipeline (ingest from Soul API → Supabase, fetch rows, run Section 2 & 3 Python judges in parallel, write scores back).

- **`index.js`** — Express app, static files, `POST /api/pipeline` (SSE), `POST /api/judge-ingest`, `POST /api/annotator-judge-pipeline` (SSE), export GETs for Launchpad + annotator judge.
- **`csvExportRegistry.js`** — Short-lived tokens for pipeline file downloads.
- **`pipeline.js`** — Launchpad pipeline; spawns `judge_section2.py` / `judge_section3.py`; exports `runJudgeStream`. Judge **output** CSVs are read with **`csv-parse`** (quoted newlines/commas). **Do not** replace that with a line-splitting parser — it desyncs files from Supabase. After parse, row count and per-row **`uniqueid`** (vs the Supabase batch) are verified; each `UPDATE` must affect exactly **one** row.
- **`annotatorJudgePipeline.js`** — Join `annotator_judge_table` + `golden_datasets`, run `backend/annotator-judge/batch_evaluate.py`, then write `evaluation_results.json` back to `annotator_judge_table` (`aj_eval_*` columns).
- **`annotatorJudgeApplyResults.js`** — Applies judge JSON to Supabase by `subtask_id`.
- **`annotatorJudgeDb.js`**, **`annotatorJudgeExportRegistry.js`** — DB queries + download tokens for annotator runs.
- **`ingest.js`** — Soul API client + Supabase upsert (with created_at+email guard).
- **`db.js`** — Postgres/Supabase config and `fetchRowsForRange`.
- **`stageIdsDb.js`** — Reads/writes configurable Soul `stage_id` values from DB table `stage_ids`.
- **`datetimeTz.js`** — Wall time in IANA TZ → UTC ISO.

Loads **`backend/.env`** so `OPENAI_API_KEY` and DB config are available. Postgres: prefer **`DATABASE_URL`** or **`SUPABASE_DATABASE_URL`** (Supabase connection string); otherwise **`SUPABASE_DB_HOST`**, **`SUPABASE_DB_USER`**, **`SUPABASE_DB_PASSWORD`**, etc.

**Check DB + annotator tables:** `GET /api/annotator-judge/db-status` (row counts and join count).

**Stage IDs are DB-configured (not hardcoded):**
- Create/seed table with **`sql/stage_ids.sql`**
- List by tab purpose: `GET /api/stage-ids?purpose=launchpad_eval` or `purpose=annotator_judge`
- Add/update one: `POST /api/stage-ids` with JSON body `{ "id": "stc_...", "purpose": "launchpad_eval|annotator_judge" }`

**Section 1 deterministic scoring (Assessment Evaluation):**
- Before Section 2/3 judges, pipeline runs SQL comparison against active `golden_datasets_assessments`.
- Comparison uses ingested assessment answers `ans_1...ans_5` against gold labels `q1_label...q5_label`.
- Purpose defaults to `Launchpad - eval` (override with env `GOLDEN_PURPOSE_LAUNCHPAD_EVAL`).
- Assessment gold table default is `golden_datasets_assessments` (override with env `GOLDEN_ASSESSMENT_TABLE`).
- Required migrations:
  - `sql/new_evaluation_section1_columns.sql` (raw Sec 1 answer columns)
  - `sql/new_evaluation_section1_scores.sql` (sec1_q*_score + section1_total)
  - `sql/new_evaluation_final_score_status.sql` (`final_score`, `post_eval_status`)
  - `POST /api/pipeline` now requires:
    - `threshold_score` (number, overall/final score threshold)
    - `section1_threshold` (number, section1_total threshold)
  - Post-eval status is `SELECTED` only if both thresholds are met; else `REJECTED`.

**Annotator judge DB columns:** New installs use **`sql/annotator_judge_table.sql`**. Judge metrics are **flat columns** (`aj_m1_*` per dimension, `aj_m2_*`, `aj_m3_*`, scores, likert flags) — no JSONB results column. Existing DBs: run **`sql/annotator_judge_eval_columns.sql`** once (adds columns and drops legacy `aj_eval_results` if present).

**Gold labels (annotator-judge):** Use table **`golden_datasets`**, then load the bundled CSV:

```bash
cd server && npm install && npm run load-golden-mock
```

Override path with **`GOLDEN_MOCK_CSV`**. Default table name in Postgres is **`"golden_datasets"`** (override with `GOLDEN_MOCK_TABLE` if needed).

**Gold-label versioning/deprecation:** Run **`sql/golden_mock_metadata.sql`** once to add:
`purpose`, `gold_created_at`, `is_active`, `deprecated_at`.

- Annotator join queries now use only rows where `is_active = true` and `purpose = GOLDEN_PURPOSE` (default: `annotator_judge`).
- Loader (`loadGoldenMockTasking.js`) writes those metadata columns.
- By default, loading a new CSV deprecates the previous active set for the same purpose (`GOLDEN_DEPRECATE_OLD_ON_LOAD=1`).

**Table blueprints (split):**
- `sql/golden_datasets_schema.sql` for annotator judge (`subtask_id`, dimension labels/priorities)
- `sql/golden_datasets_assessments.sql` for Launchpad eval (`uniqueid`, `q1_label...q5_label`)

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

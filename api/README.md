# Launchpad Eval — `api/` (Node.js)

Express app: serves the React app and runs the pipeline (ingest from Soul API → Supabase, fetch rows, run Section 2 & 3 Python judges in parallel, write scores back).

- **`index.js`** — Express app, static files, `POST /api/pipeline` (SSE).
- **`pipeline.js`** — Pipeline flow; spawns `backend/scripts/judge_section2.py` and `judge_section3.py`.
- **`ingest.js`** — Soul API client + Supabase upsert (with created_at+email guard).
- **`db.js`** — Postgres/Supabase config and `fetchRowsForRange`.
- **`datetimeTz.js`** — Wall time in IANA TZ → UTC ISO.

Loads **`backend/.env`** so `OPENAI_API_KEY` and Supabase vars are available (for spawned Python judges and for Node DB/ingest).

**CORS:** By default allows `https://teamdeccanrm.in` and localhost. Override with `APP_ORIGIN` (comma-separated list) in env if needed.

Run from repo root:

```bash
cd api && npm install && npm start
```

Or `npm run dev` for watch mode. Default: `http://0.0.0.0:5050`.

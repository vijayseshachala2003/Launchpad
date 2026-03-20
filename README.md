# Launchpad Eval

Web app to run **LLM judges** (Section 2 and Section 3) on annotation data: pull data by date range, optionally ingest from a read-only Soul API into Supabase, run judges in parallel, and write scores back to Supabase. **React** UI in `frontend/`; **Node.js** API and pipeline in **`api/`**; **Python** judges and shared **`.env`** in **`backend/`**.

---

## How the system works

### Purpose

Users pick a **date range** and **timezone** in the UI and start a **pipeline**. The system:

1. **Ingests** data for that range from the read-only **Soul reporting API** into **Supabase** (table `new_evaluation_table`), if needed.
2. **Loads** rows from Supabase for that range.
3. **Runs** two **Python judge scripts** in parallel (Section 2 and Section 3), which call an LLM to score each row.
4. **Writes** the judge scores and justifications back to Supabase.

If no rows exist in Supabase for the range, the pipeline first pulls from the Soul API and upserts (with a guard so existing `(created_at, email)` pairs are not duplicated), then continues.

### High-level architecture

```
┌─────────────┐     ┌──────────────────────────────────────────────────────────┐     ┌─────────────────┐
│   Browser   │────▶│  Node API (Express, api/)                                  │────▶│  Soul API       │
│             │     │  • Serves React app (frontend/)                           │     │  (read-only)    │
│  React UI   │     │  • POST /api/pipeline → runs pipeline, streams SSE logs   │     └────────┬────────┘
│  (frontend/)│     │  • Ingest: fetch from Soul API → upsert into Supabase     │              │
└─────────────┘     │  • Load rows from Supabase, spawn Python judges           │     ┌────────▼────────┐
                    │  • Write judge output back to Supabase                    │────▶│  Supabase       │
                    └────────────────────────────┬─────────────────────────────┘     │  (read/write)    │
                                                 │                                    └─────────────────┘
                                                 │  spawns
                                                 ▼
                    ┌──────────────────────────────────────────────────────────┐
                    │  backend/                                                  │
                    │  • Python: judge_section2.py, judge_section3.py (LLM)      │
                    │  • .env: OPENAI_API_KEY, SUPABASE_*, etc. (shared by       │
                    │    Node and Python)                                         │
                    └──────────────────────────────────────────────────────────┘
```

- **frontend/** — React (Vite) UI: date/time inputs, timezone, “Run pipeline”, and live log stream (SSE).
- **api/** — Node.js HTTP API: static files, `POST /api/pipeline`, pipeline orchestration, ingest, DB access, and spawning the Python judges.
- **backend/** — Python judge scripts plus shared `.env` (no separate HTTP server). The Node process in **`api/`** loads `backend/.env` and runs `backend/scripts/*.py`.

Together, **`api/` + `backend/`** are the application backend (Node orchestration + Python judges + env).

### Pipeline flow (step by step)

1. User submits **date_from**, **date_to**, and **timezone** from the UI.
2. The **API** (`api/`) converts the range to UTC using the chosen timezone (e.g. GMT).
3. **Ingest (optional):**  
   - Call Soul reporting API with the UTC range and fixed stage IDs.  
   - Upsert results into Supabase `new_evaluation_table` (after removing rows that would duplicate existing `(created_at, email)`).
4. **Load rows:** Query Supabase for the UTC range. If no rows are found, run ingest again (fallback) and retry the Supabase query.
5. **Judge:**  
   - Write two CSVs (Section 2 and Section 3 inputs) under `backend/scripts/`.  
   - Spawn `judge_section2.py` and `judge_section3.py` in parallel.  
   - Each script reads its CSV, calls the LLM, and writes an output CSV with scores.
6. **Write back:** Parse the output CSVs and `UPDATE` the corresponding rows in Supabase (Section 2 and Section 3 columns).
7. **SSE:** The API streams progress and log lines to the browser so the user sees live status.

### Data and timezone

- **Soul API** and **Supabase** use **UTC** for `created_at`.
- The UI sends **wall-clock** from/to in the user’s chosen timezone (default **GMT**). The API converts to UTC for all Soul/Supabase queries so results align with tools like Metabase (GMT).

---

## Repository structure

```
Launchpad-eval/
├── frontend/                 # React (Vite) — UI only
│   ├── src/App.jsx           # Main app: date range, pipeline trigger, SSE log view
│   ├── package.json
│   └── .env                  # VITE_API_BASE_URL (e.g. https://teamdeccanrm.in)
├── api/                      # Node.js API + pipeline (Express)
│   ├── index.js              # Express app, static files, POST /api/pipeline, SSE
│   ├── pipeline.js           # Ingest → fetch rows → run judges → apply scores
│   ├── ingest.js             # Soul API client + Supabase upsert
│   ├── db.js                 # Postgres config + fetchRowsForRange
│   ├── datetimeTz.js         # Wall time → UTC conversion
│   └── package.json
├── backend/                  # Python judges + shared config (no HTTP server)
│   ├── .env                  # OPENAI_API_KEY, SUPABASE_*, PIPELINE_TIMEZONE, etc.
│   └── scripts/
│       ├── judge_section2.py
│       └── judge_section3.py
└── README.md
```

---

## Quick start

### 1. Backend env (required)

Create `backend/.env` with at least:

- `OPENAI_API_KEY` (or `ANTHROPIC_API_KEY` if the judges use it)
- `SUPABASE_DB_HOST`, `SUPABASE_DB_PORT`, `SUPABASE_DB_NAME`, `SUPABASE_DB_USER`, `SUPABASE_DB_PASSWORD`

Optional: `PIPELINE_TIMEZONE` (default UTC), Soul API key if required by the reporting API.

### 2. Node API (`api/`)

```bash
cd api && npm install && npm start
```

Runs at **http://0.0.0.0:5050** (or set `PORT` / `HOST` in env). Loads `backend/.env` and serves the React app from `frontend/dist` if present, otherwise from `frontend/`.

### 3. Frontend

- **Development:** In another terminal:
  ```bash
  cd frontend && npm install && npm run dev
  ```
  Open **http://127.0.0.1:5173**. Vite proxies `/api` to the Node API on 5050.

- **Production (single process):** Build the frontend, then run only the API:
  ```bash
  cd frontend && npm install && npm run build
  cd ../api && npm start
  ```
  Open **http://127.0.0.1:5050** (or your host).

---

## Production and hosting

- **Live URL:** The app is intended to be hosted at **https://teamdeccanrm.in**. Set `VITE_API_BASE_URL=https://teamdeccanrm.in` in `frontend/.env` so the built frontend calls the same origin for the API.
- **CORS:** The Node API allows `https://teamdeccanrm.in` and localhost by default. Override with `APP_ORIGIN` (comma-separated) in `backend/.env` if needed.
- **Render:** Use **Build:** `cd api && npm install && cd ../frontend && npm install && npm run build` and **Start:** `cd api && node index.js`. Add env vars (Supabase, OpenAI, etc.) in the Render dashboard. For Python judges, deploy with a **Docker** image that includes Node and Python, or use a Render native environment that supports both.

---

## Date range and timezone (GMT)

Data is stored in **GMT/UTC**. In the UI, keep timezone as **GMT (UTC)** (or set `PIPELINE_TIMEZONE=UTC` in `backend/.env`). From/to are interpreted as wall time in that zone; the API converts them to UTC for the Soul API and Supabase so filtering matches Metabase and other GMT-based reports.

---

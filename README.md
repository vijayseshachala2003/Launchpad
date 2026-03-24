# Launchpad Eval

Monorepo with **three top-level program areas**:

| Folder | Role |
|--------|------|
| **`frontend/`** | **Client** — React (Vite) UI in the browser. |
| **`server/`** | **Server** — Node.js + Express: HTTP API, static files, pipeline orchestration, Soul ingest, Postgres, spawns Python. |
| **`backend/`** | **Backend workers & data** — Python judge scripts for Launchpad, shared `backend/.env`, and an optional **annotator-judge** CLI subproject. |

Soul API → Supabase → Section 2 & 3 LLM judges; Assessment Evaluation uses **fixed GMT/UTC** for date ranges.

---

## Repository layout (tree)

```
Launchpad-eval/
├── frontend/                 # React app (browser)
├── server/                   # Node.js Express API + pipeline
├── backend/                  # Python: judges + env + optional annotator-judge toolkit
│   ├── .env                  # Shared secrets (Launchpad + paths server reads)
│   ├── requirements.txt
│   ├── README.md
│   ├── scripts/              # Launchpad Section 2 & 3 judges
│   │   ├── judge_section2.py
│   │   └── judge_section3.py
│   └── annotator-judge/      # Optional: M1/M2/M3 annotator-vs-golden CLI
│       ├── main.py
│       ├── batch_evaluate.py
│       ├── src/
│       ├── requirements.txt
│       └── README.md
├── README.md                 # This file
└── .gitignore
```

---

## File map by folder

### `frontend/` — client (browser)

| Path | Purpose |
|------|---------|
| `index.html` | Vite HTML entry |
| `package.json` | npm scripts: `dev`, `build` |
| `vite.config.js` | Dev server; proxies **`/api`** → `http://127.0.0.1:5050` (HTTP routes stay under `/api/...`; folder name `server/` is unrelated) |
| `.env` / `.env.example` | Optional `VITE_API_BASE_URL` |
| `src/main.jsx` | React bootstrap |
| `src/App.jsx` | Shell: tabs **Assessment Evaluation** vs **Annotator Judge** |
| `src/AssessmentEvaluation.jsx` | Launchpad pipeline UI (dates, run, SSE, CSV downloads) |
| `src/AnnotatorJudgePanel.jsx` | Annotator judge UI: Soul ingest, **full M1/M2/M3 pipeline** (SSE + downloads) |
| `src/index.css` | Styles |
| `README.md` | Frontend notes |

**Dev:** `cd frontend && npm install && npm run dev` — keep **`server/`** running on **5050** for API proxy.

---

### `server/` — Node.js server (Express)

Runs on the host; loads **`backend/.env`**. Serves **`frontend/dist`** when built.

| Path | Purpose |
|------|---------|
| `package.json` | `npm start` → `node index.js` |
| `index.js` | Express: static files, CORS, **`POST /api/pipeline`**, **`POST /api/judge-ingest`**, **`POST /api/annotator-judge-pipeline`**, export GETs |
| `pipeline.js` | Launchpad: ingest → rows → Section 2/3 judges → Supabase (**exports `runJudgeStream`**) |
| `annotatorJudgePipeline.js` | Annotator path: ingest → join gold → **`batch_evaluate.py`** → optional downloads |
| `annotatorJudgeDb.js` | Postgres: annotator rows ∩ **`golden-mock-tasking`** |
| `annotatorJudgeExportRegistry.js` | Short-lived tokens for annotator pipeline artifacts |
| `ingest.js` | Soul → **`new_evaluation_table`** (Assessment Evaluation) |
| `ingestJudge.js` | Soul → **`annotator_judge_table`** (annotator-judge stages) |
| `sql/annotator_judge_table.sql` | DDL for **`annotator_judge_table`** |
| `sql/golden-mock-tasking.sql` | DDL for gold labels table **`golden-mock-tasking`** |
| `loadGoldenMockTasking.js` | **`npm run load-golden-mock`** — CSV → Supabase gold table |
| `db.js` | Postgres (Supabase) client + range queries |
| `datetimeTz.js` | Timezone / UTC helpers |
| `csvExportRegistry.js` | Short-lived download tokens after a run |
| `README.md` | Server-only notes |

**Run:** `cd server && npm install && npm start` → default `http://0.0.0.0:5050`.

---

### `backend/` — Python backend & config

Not a standalone HTTP server. **`server/`** reads **`backend/.env`** and runs Python under **`backend/scripts/`**.

| Path | Purpose |
|------|---------|
| `.env` | `OPENAI_API_KEY`, `SUPABASE_DB_*`, optional `PIPELINE_PYTHON`, `APP_ORIGIN`, etc. |
| `requirements.txt` | Deps for **Launchpad** judge scripts |
| `scripts/judge_section2.py` | Section 2 judge (CSV in/out) |
| `scripts/judge_section3.py` | Section 3 judge (CSV in/out) |
| `annotator-judge/` | **Optional** separate CLI — M1/M2/M3 annotator evaluation ([annotator-judge/README.md](backend/annotator-judge/README.md)) |
| `README.md` | Backend overview |

Temporary pipeline CSVs are written under `backend/scripts/` during a run.

---

## How the system works

### Purpose

1. **Ingest** (optional) from Soul reporting API into Supabase `new_evaluation_table`.
2. **Load** rows for the selected UTC range.
3. **Run** `judge_section2.py` and `judge_section3.py` in parallel.
4. **Write** scores back to Supabase.

If Supabase has no rows, ingest runs as fallback (with `(created_at, email)` dedupe guard).

### Architecture

```
Browser (frontend/)  →  HTTP  →  server/ (Node)
                                      ↓
                    Soul API (read)    Supabase (read/write)
                                      ↓
                              spawn Python: backend/scripts/*.py
```

- **`annotator-judge/`** — Python **`batch_evaluate.py`** is spawned by **`POST /api/annotator-judge-pipeline`** (after Soul ingest + join to **`golden-mock-tasking`**). Static mappings: **`backend/annotator-judge/config/ae_v1_mappings.json`**. Gold CSV load: **`cd server && npm run load-golden-mock`**. M2/M3 need **`GOOGLE_API_KEY`** (or Together) in **`backend/.env`**. Prompt/ResponseA/B are not in the current gold CSV; M2/M3 see empty context unless you extend gold or Soul export.

### Pipeline steps

1. UI sends `date_from` / `date_to` (GMT/UTC).
2. **`server/`** converts to UTC for Soul and Postgres.
3. Ingest → load rows → write input CSVs → run judges → apply output CSVs to Supabase.
4. SSE streams logs; optional browser downloads via export token.

---

## Quick start

### 1. Configure `backend/.env`

`OPENAI_API_KEY`, and Postgres via **`DATABASE_URL`** or **`SUPABASE_DATABASE_URL`** (recommended), or discrete `SUPABASE_DB_HOST`, `SUPABASE_DB_USER`, `SUPABASE_DB_PASSWORD`, etc.

### 2. Start the server

```bash
cd server && npm install && npm start
```

### 3. Start the frontend (development)

```bash
cd frontend && npm install && npm run dev
```

Open **http://127.0.0.1:5173**.

### Production (single process)

```bash
cd frontend && npm install && npm run build
cd ../server && npm install && npm start
```

Open **http://127.0.0.1:5050** (or your host).

---

## Production & hosting

- **CORS:** `APP_ORIGIN` in `backend/.env` if needed.
- **Render (example):** Build `server` + `frontend` (`npm run build`), start `cd server && node index.js`. For Python judges, use an environment with **Node + Python** (e.g. Docker).

---

## Naming note: `/api` vs `server/`

- Folder **`server/`** = Node application directory.
- URL paths like **`/api/pipeline`** = HTTP routes (used by `fetch` from the frontend). Vite proxies **`/api`** to port 5050 in dev.

---

## Git cleanup

See **[docs/GIT_CLEANUP.md](docs/GIT_CLEANUP.md)** if present.

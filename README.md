# Launchpad Eval

React frontend + **Node.js** API. Pipeline (ingest, Supabase, judges) runs in Node; Section 2 & 3 judges are **Python** scripts invoked by the server.

```
Launchpad-eval/
├── frontend/                 # React (Vite) → see frontend/README.md
│   ├── src/App.jsx
│   └── package.json
├── server/                   # Node API (Express, /api/pipeline SSE)
│   ├── index.js
│   ├── pipeline.js
│   ├── ingest.js
│   ├── db.js
│   ├── datetimeTz.js
│   └── package.json
├── backend/                  # Python judge scripts + shared .env
│   ├── .env                  # OPENAI_API_KEY, SUPABASE_*, etc.
│   └── scripts/
│       ├── judge_section2.py
│       └── judge_section3.py
└── README.md
```

## Quick start

**1. Backend env (required for ingest + judges)**

Create `backend/.env` with at least:

- `OPENAI_API_KEY` (or `ANTHROPIC_API_KEY` if judges use it)
- `SUPABASE_DB_HOST`, `SUPABASE_DB_PORT`, `SUPABASE_DB_NAME`, `SUPABASE_DB_USER`, `SUPABASE_DB_PASSWORD`

**2. Node server (API + pipeline)**

```bash
cd server && npm install && npm start
```

Server runs at **http://0.0.0.0:5050** (or set `PORT` / `HOST` in env). It loads `backend/.env` and serves the React app from `frontend/dist` if built, else `frontend/`.

**3. Frontend (React)**

- **Development:** In another terminal, run the Vite dev server (proxies `/api` to the Node server):
  ```bash
  cd frontend && npm install && npm run dev
  ```
  Open **http://127.0.0.1:5173** (Node server must be running on 5050).

- **Production:** Build once, then the Node server serves it:
  ```bash
  cd frontend && npm install && npm run build
  cd ../server && npm start
  ```
  Open **http://127.0.0.1:5050**.

## Date range & timezone (GMT)

Data is in **GMT**. In the UI leave timezone as **GMT (UTC)** (or set `PIPELINE_TIMEZONE=UTC` in `backend/.env`). From/to are wall times in that zone; the server converts to UTC for Soul + Supabase.

## Git (uncommit / untrack)

See **[docs/GIT_CLEANUP.md](docs/GIT_CLEANUP.md)** for commands to uncommit or stop tracking files.

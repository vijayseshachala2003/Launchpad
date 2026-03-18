# Launchpad Eval

```
Launchpad-eval/
├── frontend/                 # Static UI only → see frontend/README.md
│   ├── index.html
│   └── README.md
├── backend/                  # API, pipeline, judges → see backend/README.md
│   ├── server.py
│   ├── ingest_api.py
│   ├── pipeline_runner.py
│   ├── config.json
│   ├── requirements.txt
│   ├── .env
│   └── scripts/
│       ├── judge_section2.py
│       ├── judge_section3.py
│       └── ingest_cli.py              # optional CLI ingest
└── README.md
```

## Quick start

```bash
cd backend
pip install -r requirements.txt
# Create .env with OPENAI_API_KEY and SUPABASE_DB_*
python server.py
```

Open **http://127.0.0.1:5050** for the pipeline UI.

## Date range & timezone (GMT)

Data is in **GMT**. Leave the timezone as **GMT (UTC)** in the UI (or set `PIPELINE_TIMEZONE=UTC` or `PIPELINE_TIMEZONE=GMT` in `.env`). From/to are wall times in that zone; the server converts to UTC for Soul + Supabase.

## Manual ingest (CLI)

```bash
cd backend
python scripts/ingest_cli.py --timezone GMT --from 2025-01-01T00:00:00 --to 2025-12-31T23:59:59
```

Omit `--from` / `--to` to pull all rows matching the base Soul query. `--timezone` defaults to `PIPELINE_TIMEZONE` or GMT/UTC.

## Git (uncommit / untrack)

See **[docs/GIT_CLEANUP.md](docs/GIT_CLEANUP.md)** for commands to uncommit or stop tracking files.

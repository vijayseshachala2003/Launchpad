# Backend (Python + config)

Full repo layout: **[../README.md](../README.md)** (`frontend/` vs `server/` vs `backend/`).

The **Node server** (`../server/`) runs the HTTP server and pipeline; it loads `.env` from **this directory** and invokes the judge scripts in `scripts/`.

| Path | Purpose |
|------|---------|
| `.env` | `OPENAI_API_KEY`, `SUPABASE_*`, optional `PIPELINE_TIMEZONE` (default GMT/UTC) |
| `requirements.txt` | Python deps for Launchpad judge scripts only (`openai`, `python-dotenv`) |
| **`scripts/`** | Section 2 & 3 judges (see below) |
| **`annotator-judge/`** | Optional **separate** Python CLI (M1/M2/M3 annotator vs golden); not invoked by `server/` yet |

## `scripts/`

| File | Purpose |
|------|---------|
| `judge_section2.py` | Section 2 LLM judge (invoked by Node pipeline) |
| `judge_section3.py` | Section 3 LLM judge (invoked by Node pipeline) |

Install deps only if you run the judges directly (e.g. for testing):

```bash
pip install -r requirements.txt
```

Otherwise the Node process in `server/` runs the pipeline and calls these scripts with the right env.

## `annotator-judge/`

Standalone **annotator evaluation** toolkit (M1/M2/M3). See **[annotator-judge/README.md](annotator-judge/README.md)**.

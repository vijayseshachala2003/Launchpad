# Backend (Python judge scripts + env)

The **Node server** (`../server/`) runs the API and pipeline; it loads `.env` from here and invokes the judge scripts in `scripts/`.

| Path | Purpose |
|------|---------|
| `.env` | `OPENAI_API_KEY`, `SUPABASE_*`, optional `PIPELINE_TIMEZONE` (default GMT/UTC) |
| `requirements.txt` | Python deps for judge scripts only (`openai`, `python-dotenv`) |
| **`scripts/`** | See below |

## `scripts/`

| File | Purpose |
|------|---------|
| `judge_section2.py` | Section 2 LLM judge (invoked by Node pipeline) |
| `judge_section3.py` | Section 3 LLM judge (invoked by Node pipeline) |

Install deps only if you run the judges directly (e.g. for testing):

```bash
pip install -r requirements.txt
```

Otherwise the Node server runs the pipeline and calls these scripts with the right env.

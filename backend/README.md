# Backend

| File / folder        | Purpose |
|---------------------|---------|
| `server.py`         | Flask app: `/`, `/api/pipeline`, `/api/run` |
| `ingest_api.py`     | Read-only Soul reporting API → Supabase upsert |
| `pipeline_runner.py`| Export CSVs → judges → write scores; sets `sec_2/3_evaluated_at`, `sec_2/3_eval_status` (PENDING \| IN_PROGRESS \| SUCCESS \| FAILED \| SKIPPED) |
| `config.json`       | Judge script paths, Python executable |
| `requirements.txt`  | Dependencies |
| `.env`              | Secrets + optional `PIPELINE_TIMEZONE` (default GMT/UTC; data is in GMT) |
| `datetime_tz.py`    | Wall time in selected TZ (default GMT) → UTC for Soul + Supabase |
| **`scripts/`**      | See below |

## `scripts/`

| File                     | Purpose |
|--------------------------|---------|
| `judge_section2.py`      | Section 2 LLM judge |
| `judge_section3.py`      | Section 3 LLM judge |
| `ingest_cli.py`          | CLI ingest (`python scripts/ingest_cli.py --from … --to …`) |

Run the server from **this directory**:

```bash
pip install -r requirements.txt
python server.py
```

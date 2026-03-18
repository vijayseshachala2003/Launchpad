#!/usr/bin/env python3
"""
CLI: Soul API → Supabase upsert (same as pipeline ingest step).
Run from repo root:  python backend/scripts/ingest_cli.py
Or from backend:     python scripts/ingest_cli.py
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))

from dotenv import load_dotenv

load_dotenv(BACKEND / ".env")

from datetime_tz import wall_to_utc_iso_optional  # noqa: E402
from ingest_api import run_ingest  # noqa: E402


def main() -> None:
    import os

    p = argparse.ArgumentParser(description="Ingest Soul API rows into new_evaluation_table.")
    p.add_argument("--from", dest="date_from", default=None, help="created_at lower bound (wall time in --timezone)")
    p.add_argument("--to", dest="date_to", default=None, help="created_at upper bound (wall time in --timezone)")
    p.add_argument(
        "--timezone",
        default=None,
        help="IANA TZ for from/to (default: PIPELINE_TIMEZONE or GMT/UTC). Data is in GMT.",
    )
    args = p.parse_args()
    tz = (args.timezone or os.environ.get("PIPELINE_TIMEZONE") or "UTC").strip() or "UTC"
    if tz.upper() == "GMT":
        tz = "UTC"
    df = wall_to_utc_iso_optional(args.date_from, tz)
    dt = wall_to_utc_iso_optional(args.date_to, tz)
    n = run_ingest(df, dt)
    print(f"Upserted {n} rows.")


if __name__ == "__main__":
    main()

"""
Pipeline: fetch from Supabase by date range; if empty, ingest from read-only Soul API then re-fetch.
Then judge Section 2 & 3 in parallel → write scores back to Supabase.
"""
from __future__ import annotations

import csv
import os
import queue
import re
import subprocess
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Generator, List, Optional

import psycopg2
from psycopg2.extras import RealDictCursor

from ingest_api import get_postgres_config

UPDATE_SEC2 = """
UPDATE new_evaluation_table SET
    sec_2_judge_model = %s,
    sec_2_evaluation_score = %s,
    sec_2_evaluation_justification = %s,
    sec_2_attention_to_detail_score = %s,
    sec_2_attention_to_detail_justification = %s,
    sec_2_articulation_score = %s,
    sec_2_articulation_justification = %s,
    sec_2_comprehension_score = %s,
    sec_2_comprehension_justification = %s
WHERE uniqueid = %s
"""

UPDATE_SEC3 = """
UPDATE new_evaluation_table SET
    sec3_judge_model = %s,
    reasoning_score = %s,
    reasoning_justification = %s,
    sec3_evaluation_score = %s,
    sec3_evaluation_justification = %s,
    sec3_articulation_score = %s,
    sec3_articulation_justification = %s
WHERE uniqueid = %s
"""


def fetch_rows_for_range(
    date_from: str,
    date_to: str,
    max_rows: int,
) -> List[Dict[str, Any]]:
    sql = """
    SELECT
        uniqueid,
        email,
        initialvalue_prompt,
        initialvalue_ai_response,
        section_2_instruction,
        task_1_response,
        task_2_response,
        task_3_response,
        initialvalue_scenario,
        initialvalue_sec_3_qn,
        section_3_instruction,
        sec_3_ans,
        task_3_response
    FROM new_evaluation_table
    WHERE created_at >= %s::timestamptz
      AND created_at <= %s::timestamptz
    ORDER BY created_at
    """
    args: List[Any] = [date_from, date_to]
    if max_rows and max_rows > 0:
        sql += " LIMIT %s"
        args.append(max_rows)
    conn = psycopg2.connect(**get_postgres_config(), cursor_factory=RealDictCursor)
    try:
        with conn.cursor() as cur:
            cur.execute(sql, args)
            return list(cur.fetchall())
    finally:
        conn.close()


def write_section2_csv(rows: List[Dict[str, Any]], path: Path) -> None:
    fieldnames = [
        "email",
        "initialvalue_prompt",
        "initialvalue_ai_response",
        "section_2_instruction",
        "task_1_response",
        "task_2_response",
        "task_3_response",
        "uniqueid",
    ]
    with open(path, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            w.writerow(
                {
                    "email": (r.get("email") or "") or "",
                    "initialvalue_prompt": (r.get("initialvalue_prompt") or "") or "",
                    "initialvalue_ai_response": (r.get("initialvalue_ai_response") or "") or "",
                    "section_2_instruction": (r.get("section_2_instruction") or "") or "",
                    "task_1_response": (r.get("task_1_response") or "") or "",
                    "task_2_response": (r.get("task_2_response") or "") or "",
                    "task_3_response": (r.get("task_3_response") or "") or "",
                    "uniqueid": (r.get("uniqueid") or "") or "",
                }
            )


def write_section3_csv(rows: List[Dict[str, Any]], path: Path) -> None:
    fieldnames = [
        "email",
        "initialvalue_scenario",
        "initialvalue_sec_3_qn",
        "section_3_instruction",
        "sec_3_ans",
        "uniqueid",
    ]
    with open(path, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            ans = (r.get("sec_3_ans") or "").strip() or (r.get("task_3_response") or "").strip()
            w.writerow(
                {
                    "email": (r.get("email") or "") or "",
                    "initialvalue_scenario": (r.get("initialvalue_scenario") or "") or "",
                    "initialvalue_sec_3_qn": (r.get("initialvalue_sec_3_qn") or "") or "",
                    "section_3_instruction": (r.get("section_3_instruction") or "") or "",
                    "sec_3_ans": ans,
                    "uniqueid": (r.get("uniqueid") or "") or "",
                }
            )


def _read_judged_csv(path: Path) -> List[Dict[str, str]]:
    with open(path, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def apply_section2_scores(csv_path: Path) -> int:
    rows = _read_judged_csv(csv_path)
    conn = psycopg2.connect(**get_postgres_config())
    n = 0
    try:
        with conn:
            with conn.cursor() as cur:
                for r in rows:
                    uid = (r.get("uniqueid") or r.get("uniqueId") or "").strip()
                    if not uid:
                        continue
                    cur.execute(
                        UPDATE_SEC2,
                        (
                            r.get("judge_model") or "",
                            str(r.get("evaluation_score") or ""),
                            r.get("evaluation_justification") or "",
                            str(r.get("attention_to_detail_score") or ""),
                            r.get("attention_to_detail_justification") or "",
                            str(r.get("articulation_score") or ""),
                            r.get("articulation_justification") or "",
                            str(r.get("comprehension_score") or ""),
                            r.get("comprehension_justification") or "",
                            uid,
                        ),
                    )
                    n += cur.rowcount
        return n
    finally:
        conn.close()


def apply_section3_scores(csv_path: Path) -> int:
    rows = _read_judged_csv(csv_path)
    conn = psycopg2.connect(**get_postgres_config())
    n = 0
    try:
        with conn:
            with conn.cursor() as cur:
                for r in rows:
                    uid = (r.get("uniqueid") or r.get("uniqueId") or "").strip()
                    if not uid:
                        continue
                    cur.execute(
                        UPDATE_SEC3,
                        (
                            r.get("judge_model") or "",
                            str(r.get("reasoning_score") or ""),
                            r.get("reasoning_justification") or "",
                            str(r.get("evaluation_score") or ""),
                            r.get("evaluation_justification") or "",
                            str(r.get("articulation_score") or ""),
                            r.get("articulation_justification") or "",
                            uid,
                        ),
                    )
                    n += cur.rowcount
        return n
    finally:
        conn.close()


def _run_subprocess_stream(
    cmd: List[str],
    cwd: str,
    env: dict,
    label: str,
    out_q: queue.Queue,
) -> None:
    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            cwd=cwd,
            env=env,
        )
        for line in iter(proc.stdout.readline, ""):
            out_q.put(("line", label, line))
        proc.wait(timeout=7200)
        out_q.put(("done", label, proc.returncode, None))
    except Exception as e:
        out_q.put(("done", label, -1, str(e)))


def run_pipeline_events(
    backend_dir: Path,
    date_from: str,
    date_to: str,
    max_rows: int,
    python_cmd: str,
    skip_ingest: bool,
) -> Generator[Dict[str, Any], None, None]:
    from ingest_api import run_ingest

    yield {"type": "log", "message": "Starting pipeline…"}

    if not skip_ingest:
        yield {
            "type": "log",
            "message": f"Ingesting from API (GMT/UTC range: {date_from} … {date_to})…",
        }
        try:
            n = run_ingest(date_from, date_to)
            yield {"type": "log", "message": f"Ingest upserted {n} rows into new_evaluation_table."}
        except Exception as e:
            yield {"type": "error", "message": f"Ingest failed: {e}"}
            return
    else:
        yield {"type": "log", "message": "Skipping ingest (using existing Supabase rows in range)."}

    yield {"type": "log", "message": "Loading rows from Supabase…"}
    try:
        db_rows = fetch_rows_for_range(date_from, date_to, max_rows)
    except Exception as e:
        yield {"type": "error", "message": f"DB fetch failed: {e}"}
        return

    if not db_rows:
        yield {
            "type": "log",
            "message": "No rows in Supabase for this range — querying read-only Soul API and ingesting…",
        }
        try:
            n_fallback = run_ingest(date_from, date_to)
            yield {
                "type": "log",
                "message": f"Read-only ingest complete: {n_fallback} row(s) upserted into Supabase.",
            }
        except Exception as e:
            yield {"type": "error", "message": f"Read-only ingest failed: {e}"}
            return
        if n_fallback == 0:
            yield {
                "type": "error",
                "message": "Read-only API returned no rows for this date range.",
            }
            return
        try:
            db_rows = fetch_rows_for_range(date_from, date_to, max_rows)
        except Exception as e:
            yield {"type": "error", "message": f"Supabase fetch after ingest failed: {e}"}
            return
        if not db_rows:
            yield {
                "type": "error",
                "message": "Supabase still empty after ingest (e.g. created_at mismatch vs Soul data).",
            }
            return

    yield {"type": "log", "message": f"Evaluating {len(db_rows)} rows (Section 2 + Section 3 in parallel)."}

    script_dir = backend_dir / "scripts"
    script_dir.mkdir(parents=True, exist_ok=True)
    run_id = __import__("datetime").datetime.now(__import__("datetime").timezone.utc).strftime("%Y-%m-%d_%H-%M-%S")
    sec2_in = script_dir / f"pipeline_s2_{run_id}.csv"
    sec3_in = script_dir / f"pipeline_s3_{run_id}.csv"
    sec2_out = script_dir / f"pipeline_s2_{run_id}_output.csv"
    sec3_out = script_dir / f"pipeline_s3_{run_id}_output.csv"

    write_section2_csv(db_rows, sec2_in)
    write_section3_csv(db_rows, sec3_in)

    judge2 = (backend_dir / "scripts" / "judge_section2.py").resolve()
    judge3 = (backend_dir / "scripts" / "judge_section3.py").resolve()
    env = os.environ.copy()
    n_rows = len(db_rows)
    mr = str(n_rows)

    cmd2 = [python_cmd, str(judge2), "--input", str(sec2_in), "--output", str(sec2_out), "--max-rows", mr]
    cmd3 = [python_cmd, str(judge3), "--input", str(sec3_in), "--output", str(sec3_out), "--max-rows", mr]

    out_q: queue.Queue = queue.Queue()
    t2 = threading.Thread(
        target=_run_subprocess_stream,
        args=(cmd2, str(script_dir), env, "s2", out_q),
        daemon=True,
    )
    t3 = threading.Thread(
        target=_run_subprocess_stream,
        args=(cmd3, str(script_dir), env, "s3", out_q),
        daemon=True,
    )
    t2.start()
    t3.start()

    pending = {"s2": True, "s3": True}
    exit_codes: Dict[str, int] = {}
    judge_errors: Dict[str, str] = {}
    prog_re = re.compile(r"Completed\s+(\d+)/(\d+)")

    while pending["s2"] or pending["s3"]:
        try:
            item = out_q.get(timeout=0.3)
        except queue.Empty:
            continue
        kind = item[0]
        if kind == "line":
            _, label, line = item
            m = prog_re.search(line)
            if m:
                yield {
                    "type": "progress",
                    "section": label,
                    "current": int(m.group(1)),
                    "total": int(m.group(2)),
                }
            yield {"type": "log", "message": f"[{label.upper()}] {line.rstrip()}"}
        elif kind == "done":
            _, label, code, err = item
            pending[label] = False
            exit_codes[label] = code if err is None else -1
            if err:
                judge_errors[label] = err
                yield {"type": "error", "message": f"Judge {label} error: {err}"}
            elif code != 0:
                yield {"type": "error", "message": f"Judge {label} exited with code {code}"}
            else:
                yield {"type": "log", "message": f"Judge {label} finished OK."}

    if exit_codes.get("s2", -1) != 0 or exit_codes.get("s3", -1) != 0:
        yield {"type": "error", "message": "Pipeline stopped: one or both judges failed; Supabase not updated."}
        return

    if not sec2_out.exists() or not sec3_out.exists():
        yield {"type": "error", "message": "Missing judge output CSV."}
        return

    yield {"type": "log", "message": "Writing Section 2 scores to Supabase…"}
    try:
        n2 = apply_section2_scores(sec2_out)
        yield {"type": "log", "message": f"Updated {n2} rows (Section 2 columns)."}
    except Exception as e:
        yield {"type": "error", "message": f"Section 2 DB update failed: {e}"}
        return

    yield {"type": "log", "message": "Writing Section 3 scores to Supabase…"}
    try:
        n3 = apply_section3_scores(sec3_out)
        yield {"type": "log", "message": f"Updated {n3} rows (Section 3 columns)."}
    except Exception as e:
        yield {"type": "error", "message": f"Section 3 DB update failed: {e}"}
        return

    yield {
        "type": "done",
        "rows_evaluated": len(db_rows),
        "sec2_output": str(sec2_out),
        "sec3_output": str(sec3_out),
    }

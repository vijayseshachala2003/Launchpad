"""
Read-only source: Soul reporting API (reporting.soulhq.ai). Upserts into Supabase new_evaluation_table.
Optional created_at range (ISO 8601).
Upsert: temp staging + UPDATE by uniqueid + INSERT new rows (no UNIQUE constraint required).
"""
from __future__ import annotations

import os
import re
from datetime import datetime

import psycopg2
import requests
from psycopg2.extras import execute_values

API_ENDPOINT = "https://reporting.soulhq.ai/read-query/execute"
SOURCE = "Python ETL"

# Same stages as Metabase; keep in sync everywhere (see test.py).
STAGE_IDS_SQL = """(
    'stc_260218173538143LSI2M',
    'stc_26020219454705910Z9Z',
    'stc_260226150737582HP0J1',
    'stc_2603051253374341APCA',
    'stc_260307170924816MJKG9',
    'stc_2603111315195612L5NS'
  )"""

BASE_QUERY = f"""
SELECT
  A.created_at,
  u.email,
  A.previous_data ->> 'uniqueId' AS "uniqueId",
  A.previous_data ->> 'initialValue_passage' AS "initialValue_passage",
  A.previous_data ->> 'initialValue_question_1' AS "initialValue_question_1",
  A.response_data ->> 'ans_1' AS ans_1,
  A.previous_data ->> 'initialValue_question_2' AS "initialValue_question_2",
  A.response_data ->> 'ans_2' AS ans_2,
  A.previous_data ->> 'initialValue_question_3' AS "initialValue_question_3",
  A.response_data ->> 'ans_3' AS ans_3,
  A.previous_data ->> 'initialValue_question_4' AS "initialValue_question_4",
  A.response_data ->> 'ans_4' AS ans_4,
  A.previous_data ->> 'initialValue_question_5' AS "initialValue_question_5",
  A.response_data ->> 'ans_5' AS ans_5,
  A.previous_data ->> 'initialValue_prompt' AS "initialValue_prompt",
  A.previous_data ->> 'initialValue_ai_response' AS "initialValue_ai_response",
  A.previous_data ->> 'section_2_instruction' AS section_2_instruction,
  A.previous_data ->> 'initialValue_task_1' AS task_1,
  A.response_data ->> 'task_1_response' AS task_1_response,
  A.previous_data ->> 'initialValue_task_2' AS task_2,
  A.response_data ->> 'task_2_response' AS task_2_response,
  A.previous_data ->> 'initialValue_task_3' AS task_3,
  A.response_data ->> 'task_3_response' AS task_3_response,
  A.previous_data ->> 'initialValue_scenario' AS "initialValue_scenario",
  A.previous_data ->> 'initialValue_sec_3_qn' AS "initialValue_sec_3_qn",
  A.previous_data ->> 'section_3_instruction' AS section_3_instruction,
  A.response_data ->> 'sec_3_ans' AS sec_3_ans
FROM annotation_task_response_data A
LEFT JOIN annotation_users u ON A.user_id = u.id
WHERE A.status = 'SUBMITTED'
  AND A.stage_id IN {STAGE_IDS_SQL}
"""

_INGEST_COLS = (
    "created_at, email, uniqueid, initialvalue_passage, initialvalue_question_1, ans_1, "
    "initialvalue_question_2, ans_2, initialvalue_question_3, ans_3, initialvalue_question_4, ans_4, "
    "initialvalue_question_5, ans_5, initialvalue_prompt, initialvalue_ai_response, section_2_instruction, "
    "task_1, task_1_response, task_2, task_2_response, task_3, task_3_response, initialvalue_scenario, "
    "initialvalue_sec_3_qn, section_3_instruction, sec_3_ans"
)

CREATE_STAGING_SQL = """
CREATE TEMP TABLE _launchpad_ingest (
    created_at timestamptz,
    email text,
    uniqueid text,
    initialvalue_passage text,
    initialvalue_question_1 text,
    ans_1 text,
    initialvalue_question_2 text,
    ans_2 text,
    initialvalue_question_3 text,
    ans_3 text,
    initialvalue_question_4 text,
    ans_4 text,
    initialvalue_question_5 text,
    ans_5 text,
    initialvalue_prompt text,
    initialvalue_ai_response text,
    section_2_instruction text,
    task_1 text,
    task_1_response text,
    task_2 text,
    task_2_response text,
    task_3 text,
    task_3_response text,
    initialvalue_scenario text,
    initialvalue_sec_3_qn text,
    section_3_instruction text,
    sec_3_ans text
) ON COMMIT DROP;
"""

INSERT_STAGING_SQL = f"INSERT INTO _launchpad_ingest ({_INGEST_COLS}) VALUES %s"

# Skip upsert when same created_at + email already exists (guard rail).
DELETE_STAGING_DUPLICATE_CREATED_EMAIL_SQL = """
DELETE FROM _launchpad_ingest AS i
WHERE EXISTS (
    SELECT 1 FROM new_evaluation_table AS t
    WHERE t.created_at IS NOT DISTINCT FROM i.created_at
      AND t.email IS NOT DISTINCT FROM i.email
);
"""

UPDATE_FROM_STAGING_SQL = """
UPDATE new_evaluation_table AS t SET
    created_at = i.created_at,
    email = i.email,
    initialvalue_passage = i.initialvalue_passage,
    initialvalue_question_1 = i.initialvalue_question_1,
    ans_1 = i.ans_1,
    initialvalue_question_2 = i.initialvalue_question_2,
    ans_2 = i.ans_2,
    initialvalue_question_3 = i.initialvalue_question_3,
    ans_3 = i.ans_3,
    initialvalue_question_4 = i.initialvalue_question_4,
    ans_4 = i.ans_4,
    initialvalue_question_5 = i.initialvalue_question_5,
    ans_5 = i.ans_5,
    initialvalue_prompt = i.initialvalue_prompt,
    initialvalue_ai_response = i.initialvalue_ai_response,
    section_2_instruction = i.section_2_instruction,
    task_1 = i.task_1,
    task_1_response = i.task_1_response,
    task_2 = i.task_2,
    task_2_response = i.task_2_response,
    task_3 = i.task_3,
    task_3_response = i.task_3_response,
    initialvalue_scenario = i.initialvalue_scenario,
    initialvalue_sec_3_qn = i.initialvalue_sec_3_qn,
    section_3_instruction = i.section_3_instruction,
    sec_3_ans = i.sec_3_ans,
    sec_2_eval_status = 'PENDING',
    sec_3_eval_status = 'PENDING'
FROM _launchpad_ingest AS i
WHERE t.uniqueid = i.uniqueid;
"""

INSERT_NEW_SQL = f"""
INSERT INTO new_evaluation_table ({_INGEST_COLS}, sec_2_eval_status, sec_3_eval_status)
SELECT {_INGEST_COLS}, 'PENDING', 'PENDING'
FROM _launchpad_ingest AS i
WHERE NOT EXISTS (SELECT 1 FROM new_evaluation_table AS t WHERE t.uniqueid = i.uniqueid);
"""

_ISO_PREFIX = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}")


def _escape_ts(s: str) -> str:
    if not _ISO_PREFIX.match(s):
        raise ValueError("Invalid timestamp format")
    return s.replace("'", "''")


def build_query(date_from: str | None, date_to: str | None) -> str:
    q = BASE_QUERY.strip()
    if date_from:
        q += f"\n  AND A.created_at >= '{_escape_ts(date_from)}'::timestamptz"
    if date_to:
        q += f"\n  AND A.created_at <= '{_escape_ts(date_to)}'::timestamptz"
    q += "\nORDER BY A.created_at;"
    return q


def get_postgres_config() -> dict:
    host = os.environ["SUPABASE_DB_HOST"].strip().rstrip("/")
    if host.startswith("http://") or host.startswith("https://"):
        from urllib.parse import urlparse

        host = urlparse(host).hostname or host
    # Supabase direct Postgres uses db.<project-ref>.supabase.co; API URL is <project-ref>.supabase.co
    if host.endswith(".supabase.co") and not host.startswith("db."):
        host = "db." + host
    return {
        "host": host,
        "port": int(os.environ.get("SUPABASE_DB_PORT", 5432)),
        "dbname": os.environ.get("SUPABASE_DB_NAME", "postgres"),
        "user": os.environ["SUPABASE_DB_USER"],
        "password": os.environ["SUPABASE_DB_PASSWORD"],
        "sslmode": "require",
    }


def fetch_api_rows(query: str) -> list:
    url = f"{API_ENDPOINT}?source={requests.utils.quote(SOURCE)}"
    response = requests.post(
        url,
        json={"query": query},
        headers={"Content-Type": "application/json"},
        timeout=300,
    )
    response.raise_for_status()
    data = response.json()
    if isinstance(data, list):
        return data
    if isinstance(data, dict) and isinstance(data.get("data"), list):
        return data["data"]
    if isinstance(data, dict) and isinstance(data.get("rows"), list):
        return data["rows"]
    raise ValueError(f"Unexpected response format: {data}")


def normalize_timestamp(value):
    if value in (None, ""):
        return None
    if isinstance(value, datetime):
        return value
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except Exception:
        return value


def to_row(row: dict) -> tuple:
    return (
        normalize_timestamp(row.get("created_at")),
        row.get("email"),
        row.get("uniqueId"),
        row.get("initialValue_passage"),
        row.get("initialValue_question_1"),
        row.get("ans_1"),
        row.get("initialValue_question_2"),
        row.get("ans_2"),
        row.get("initialValue_question_3"),
        row.get("ans_3"),
        row.get("initialValue_question_4"),
        row.get("ans_4"),
        row.get("initialValue_question_5"),
        row.get("ans_5"),
        row.get("initialValue_prompt"),
        row.get("initialValue_ai_response"),
        row.get("section_2_instruction"),
        row.get("task_1"),
        row.get("task_1_response"),
        row.get("task_2"),
        row.get("task_2_response"),
        row.get("task_3"),
        row.get("task_3_response"),
        row.get("initialValue_scenario"),
        row.get("initialValue_sec_3_qn"),
        row.get("section_3_instruction"),
        row.get("sec_3_ans"),
    )


def run_ingest(date_from: str | None, date_to: str | None) -> int:
    query = build_query(date_from, date_to)
    api_rows = fetch_api_rows(query)
    if not api_rows:
        return 0
    values = [to_row(r) for r in api_rows]
    conn = psycopg2.connect(**get_postgres_config())
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(CREATE_STAGING_SQL)
                execute_values(cur, INSERT_STAGING_SQL, values, page_size=200)
                cur.execute(DELETE_STAGING_DUPLICATE_CREATED_EMAIL_SQL)
                skipped = cur.rowcount
                cur.execute(UPDATE_FROM_STAGING_SQL)
                cur.execute(INSERT_NEW_SQL)
                cur.execute("SELECT COUNT(*) FROM _launchpad_ingest")
                n_applied = cur.fetchone()[0]
        # Rows that reached UPDATE/INSERT after removing (created_at, email) duplicates.
        return n_applied if skipped is not None else len(values)
    finally:
        conn.close()

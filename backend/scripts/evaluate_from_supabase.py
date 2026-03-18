"""
Reference / dev script: stub Section 2+3 scores into Supabase (not the real LLM judges).
Run from backend:  python scripts/evaluate_from_supabase.py
"""
from __future__ import annotations

import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))

from dotenv import load_dotenv

load_dotenv(BACKEND / ".env")

import psycopg2
from psycopg2.extras import RealDictCursor

from ingest_api import get_postgres_config

POSTGRES_CONFIG = get_postgres_config()

FETCH_SQL = """
SELECT
    uniqueid,
    section_2_instruction,
    task_1,
    task_1_response,
    task_2,
    task_2_response,
    task_3,
    task_3_response,
    initialvalue_scenario,
    initialvalue_sec_3_qn,
    section_3_instruction,
    sec_3_ans
FROM new_evaluation_table
WHERE
    sec_2_judge_model IS NULL
    OR sec3_judge_model IS NULL
ORDER BY created_at
LIMIT 100;
"""

UPDATE_SQL = """
UPDATE new_evaluation_table
SET
    sec_2_judge_model = %s,
    sec_2_evaluation_score = %s,
    sec_2_evaluation_justification = %s,
    sec_2_attention_to_detail_score = %s,
    sec_2_attention_to_detail_justification = %s,
    sec_2_articulation_score = %s,
    sec_2_articulation_justification = %s,
    sec_2_comprehension_score = %s,
    sec_2_comprehension_justification = %s,
    sec3_judge_model = %s,
    reasoning_score = %s,
    reasoning_justification = %s,
    sec3_evaluation_score = %s,
    sec3_evaluation_justification = %s,
    sec3_articulation_score = %s,
    sec3_articulation_justification = %s
WHERE uniqueid = %s;
"""


def run_sec2_model(row):
    return {
        "sec_2_judge_model": "gpt-evaluator-v1",
        "sec_2_evaluation_score": "4",
        "sec_2_evaluation_justification": "Overall section 2 response is relevant and fairly complete.",
        "sec_2_attention_to_detail_score": "4",
        "sec_2_attention_to_detail_justification": "Most task details are addressed.",
        "sec_2_articulation_score": "4",
        "sec_2_articulation_justification": "Response is clear and coherent.",
        "sec_2_comprehension_score": "5",
        "sec_2_comprehension_justification": "Shows strong understanding of the tasks.",
    }


def run_sec3_model(row):
    return {
        "sec3_judge_model": "gpt-evaluator-v1",
        "reasoning_score": "4",
        "reasoning_justification": "Reasoning is mostly sound and relevant.",
        "sec3_evaluation_score": "4",
        "sec3_evaluation_justification": "Section 3 answer is useful and aligned to the prompt.",
        "sec3_articulation_score": "4",
        "sec3_articulation_justification": "Answer is understandable and structured.",
    }


def main():
    conn = psycopg2.connect(**POSTGRES_CONFIG, cursor_factory=RealDictCursor)
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(FETCH_SQL)
                rows = cur.fetchall()

            print(f"Fetched {len(rows)} rows for evaluation")

            with conn.cursor() as cur:
                for row in rows:
                    sec2 = run_sec2_model(row)
                    sec3 = run_sec3_model(row)

                    cur.execute(
                        UPDATE_SQL,
                        (
                            sec2["sec_2_judge_model"],
                            sec2["sec_2_evaluation_score"],
                            sec2["sec_2_evaluation_justification"],
                            sec2["sec_2_attention_to_detail_score"],
                            sec2["sec_2_attention_to_detail_justification"],
                            sec2["sec_2_articulation_score"],
                            sec2["sec_2_articulation_justification"],
                            sec2["sec_2_comprehension_score"],
                            sec2["sec_2_comprehension_justification"],
                            sec3["sec3_judge_model"],
                            sec3["reasoning_score"],
                            sec3["reasoning_justification"],
                            sec3["sec3_evaluation_score"],
                            sec3["sec3_evaluation_justification"],
                            sec3["sec3_articulation_score"],
                            sec3["sec3_articulation_justification"],
                            row["uniqueid"],
                        ),
                    )

        print("Updated eval columns successfully")
    finally:
        conn.close()


if __name__ == "__main__":
    main()

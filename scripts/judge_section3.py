#!/usr/bin/env python3
# /// script
# requires-python = ">=3.9"
# dependencies = [
#   "openai",
#   "python-dotenv",
# ]
# ///
"""
Section 3: LLM-as-a-judge pipeline (GPT-5).

Reads the contractors CSV and scores each response on:
- Reasoning (1-5)
- Evaluation (1-5)
- Articulation (1-5)

Outputs a new CSV preserving all original columns and adding score + justification columns.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import random
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


MODEL_NAME = "gpt-5"
MAX_WORKERS = 20

# ---- EDIT THESE DEFAULTS (optional) ----
# Paths relative to this script's folder (same directory as judge_section3.py)
DEFAULT_INPUT_CSV = "/Users/vijaychalla/Downloads/compare_prompt/contractor_response_judge/section_3/LP Assessment Evaluation 17 March - Section 3 Responses.csv"
DEFAULT_OUTPUT_CSV = "//Users/vijaychalla/Downloads/compare_prompt/contractor_response_judge/section_3/LP Assessment Evaluation 17 March - Section 3_judged.csv"
# --------------------------------------
# 
# Column mapping for Section 3 CSVs (per-row format):
#   Email Id                  -> identifier (progress display)
#   initialvalue_scenario    -> SCENARIO (sent to judge as "scenario")
#   initialvalue_sec_3_qn   -> QUESTION (appended to scenario as "Question: ...")
#   section_3_instruction    -> optional directions (if column exists; included in judge prompt)
#   sec_3_ans OR task_3_response -> CONTRACTOR RESPONSE (sent to judge as "response")
# Judge receives: scenario = initialvalue_scenario + "\n\nQuestion: " + initialvalue_sec_3_qn; response = sec_3_ans or task_3_response; section_3_instruction if present.


SCENARIO_AND_QUESTION = """Scenario: While working on a project, you receive two conflicting instructions — one emphasizing speed to meet a release deadline and the other emphasizing accuracy and stability. The original goal and constraints of the project remain unchanged.

Question: Describe how you would approach this situation. How would you decide what to prioritize, and how would you explain your reasoning so that your decision can be applied consistently going forward?

Directions:
- Analyze the trade-offs: Briefly assess the conflict between speed and accuracy relative to the project goals.
- Explain your logic: Clearly justify your chosen priority and how it aligns with fixed constraints.
- Ensure consistency: Describe how this decision would be communicated so similar conflicts can be handled consistently in the future."""


def _parse_dotenv_line(line: str) -> Optional[Tuple[str, str]]:
    line = line.strip()
    if not line or line.startswith("#"):
        return None
    if "=" not in line:
        return None
    k, v = line.split("=", 1)
    k = k.strip()
    v = v.strip()
    if not k:
        return None
    if (len(v) >= 2) and ((v[0] == v[-1]) and v[0] in {"'", '"'}):
        v = v[1:-1]
    return k, v


def _load_env_file(env_path: Path) -> None:
    if not env_path.exists() or not env_path.is_file():
        return
    try:
        for raw in env_path.read_text(encoding="utf-8").splitlines():
            parsed = _parse_dotenv_line(raw)
            if not parsed:
                continue
            k, v = parsed
            os.environ.setdefault(k, v)
    except Exception:
        return


def load_env() -> None:
    try:
        from dotenv import load_dotenv  # type: ignore

        load_dotenv()
    except Exception:
        pass
    script_dir = Path(__file__).resolve().parent
    _load_env_file(Path.cwd() / ".env")
    _load_env_file(script_dir / ".env")


def load_csv_rows(path: str) -> Tuple[List[str], List[Dict[str, str]]]:
    with open(path, "r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        if reader.fieldnames is None:
            raise ValueError("CSV has no header row.")
        rows: List[Dict[str, str]] = []
        for r in reader:
            rows.append({k: (v if v is not None else "") for k, v in r.items()})
        return list(reader.fieldnames), rows


def write_csv_rows(path: str, headers: List[str], rows: List[Dict[str, Any]]) -> None:
    with open(path, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=headers, extrasaction="ignore")
        writer.writeheader()
        for r in rows:
            writer.writerow(r)


def write_json_rows(path: str, rows: List[Dict[str, Any]]) -> None:
    """Write scored rows as a JSON array (same data as CSV, for downstream use)."""
    with open(path, "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False, indent=2)


def stable_key(*parts: str) -> str:
    h = hashlib.sha256()
    for p in parts:
        h.update(p.encode("utf-8"))
        h.update(b"\n---\n")
    return h.hexdigest()


def _extract_json_object(text: str) -> Dict[str, Any]:
    text = (text or "").strip()
    if not text:
        raise ValueError("Empty response.")
    try:
        obj = json.loads(text)
        if isinstance(obj, dict):
            return obj
    except Exception:
        pass
    m = re.search(r"\{[\s\S]*\}", text)
    if not m:
        raise ValueError(f"Could not find JSON object in response: {text[:200]}...")
    obj = json.loads(m.group(0))
    if not isinstance(obj, dict):
        raise ValueError("Parsed JSON is not an object.")
    return obj


def _clamp_int(x: Any, lo: int, hi: int) -> int:
    try:
        v = int(x)
    except Exception:
        return lo
    return max(lo, min(hi, v))


def _get_score(obj: Dict[str, Any], *keys: str, lo: int = 1, hi: int = 5) -> int:
    """Get integer score from obj trying multiple key names (e.g. reasoning_score, reasoningScore)."""
    for k in keys:
        if k in obj and obj[k] is not None:
            return _clamp_int(obj[k], lo, hi)
    return lo


SYSTEM_PROMPT = """You are an LLM Judge evaluating a HUMAN CONTRACTOR response for:
Section 3 – First-Principles Decision-Making Assessment.

You MUST follow these rules:
- The scenario, question, and directions are provided per submission and may differ each time. Use ONLY the materials provided for THIS submission; do not assume or use any other scenario or question.
- Judge ONLY from the contractor's response and the provided scenario/question (and any directions) for this submission.
- Evaluate ONLY these competencies: Reasoning, Evaluation, Articulation.
- Do NOT infer skills that are not explicitly demonstrated.
- Score each competency independently.
- If evidence is mixed or borderline between two levels, choose the LOWER score.
- Provide brief, specific justifications for EVERY score referencing observable elements.
- Apply the rubric consistently across all contractors; do NOT adjust expectations based on writing style, response length, or confidence.

Scenario summary (for grounding):
Two conflicting instructions: (A) speed to meet a release deadline, (B) accuracy/stability.
Project goals and constraints remain unchanged.
The contractor should: analyze trade-offs, justify priority aligned to constraints, and explain how to communicate the decision for future consistency.

Scoring: integer 1-5 for each competency:
1 = Limited, 2 = Basic, 3 = Proficient, 4 = Advanced, 5 = Expert

Rubric:

1) Reasoning — analyzes conflict, structures thinking around constraints, defensible prioritization:
1 Limited: fails to recognize core conflict; reasoning absent/incorrect/contradictory; vague opinion with no logical structure tied to scenario.
2 Basic: acknowledges conflict but shallow/fragmented; prioritization stated without logical development; lacks clear steps; weak connection to constraints.
3 Proficient: clearly identifies conflict and gives logical prioritization; coherent structure but surface-level; mentions trade-offs without stress-testing.
4 Advanced: explicit, well-structured trade-off weighing; constraint-aware; logically sequenced; may rely on one dominant framework/assumption.
5 Expert: rigorous first-principles breakdown (goals, risks, constraints, reversibility); multiple decision lenses; prioritization robust and adaptable to similar scenarios.

2) Evaluation — assesses risks/impact/outcomes, aligns judgment to unchanged goals/constraints:
1 Limited: no meaningful evaluation of impact/risk; arbitrary/disconnected judgment.
2 Basic: minimal evaluation; generic consequences; weakly tied to goals.
3 Proficient: identifies primary risks/benefits; reasonable but narrow; misses secondary implications.
4 Advanced: weighs risks, impact, and alignment; explains why one priority is preferable; may miss edge cases/long-term.
5 Expert: nuanced short+long-term implications; deep trade-off assessment; foresight; aligns to fixed goals; generalizes across scenarios.

3) Articulation — clear, coherent, professional explanation reusable for consistency:
1 Limited: unclear/disorganized; decision/reasoning not communicated; unusable for consistent application.
2 Basic: partially understandable but fragmented; rationale hard to follow or inconsistent.
3 Proficient: clear and logically organized; generally professional; may lack polish/explicitness for reuse by others.
4 Advanced: well-structured, easy to follow; flows problem → decision → rationale → communication plan; professional; reusable with minimal clarification.
5 Expert: exceptionally clear/concise/precise; purpose-driven; communicates reusable decision logic without ambiguity.

Output requirements:
- Return JSON ONLY (no markdown, no extra keys).
- Keys:
  reasoning_score (1-5), reasoning_justification (string)
  evaluation_score (1-5), evaluation_justification (string)
  articulation_score (1-5), articulation_justification (string)
- Each justification must be 1-3 sentences and cite at least one concrete element (e.g., mentions trade-offs, defines a rule, identifies risks, aligns to constraints, or omits consistency plan).
"""


USER_TEMPLATE = """SCENARIO + QUESTION:
{scenario}
{instructions_block}
CONTRACTOR RESPONSE:
{response}

Score based ONLY on the Section 3 instruction document rubric. Use the scenario, question, and directions above as the context for THIS response only.
Return JSON only as specified."""


@dataclass
class JudgeResult:
    reasoning_score: int
    reasoning_justification: str
    evaluation_score: int
    evaluation_justification: str
    articulation_score: int
    articulation_justification: str
    model: str


def call_gpt5_judge(
    *,
    scenario: str,
    response: str,
    section_3_instruction: Optional[str] = None,
    max_retries: int = 6,
    min_backoff_s: float = 0.75,
    max_backoff_s: float = 12.0,
) -> JudgeResult:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is not set. Put it in .env or your environment.")

    from openai import OpenAI  # type: ignore

    client = OpenAI(api_key=api_key)
    instructions_block = ""
    if section_3_instruction and section_3_instruction.strip():
        instructions_block = "\nDIRECTIONS (for this scenario):\n" + section_3_instruction.strip() + "\n\n"
    user_text = USER_TEMPLATE.format(
        scenario=scenario,
        instructions_block=instructions_block,
        response=response,
    )

    last_err: Optional[BaseException] = None
    for attempt in range(1, max_retries + 1):
        try:
            resp = client.responses.create(
                model=MODEL_NAME,
                input=[
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": user_text},
                ],
            )
            text = getattr(resp, "output_text", None) or ""
            if not text:
                parts: List[str] = []
                for o in getattr(resp, "output", []) or []:
                    for c in getattr(o, "content", []) or []:
                        t = getattr(c, "text", None)
                        if t:
                            parts.append(t)
                text = "\n".join(parts).strip()

            obj = _extract_json_object(text)

            def _j(key: str, alt: str) -> str:
                return str(obj.get(key) or obj.get(alt) or "").strip()

            return JudgeResult(
                reasoning_score=_get_score(obj, "reasoning_score", "reasoningScore"),
                reasoning_justification=_j("reasoning_justification", "reasoningJustification"),
                evaluation_score=_get_score(obj, "evaluation_score", "evaluationScore"),
                evaluation_justification=_j("evaluation_justification", "evaluationJustification"),
                articulation_score=_get_score(obj, "articulation_score", "articulationScore"),
                articulation_justification=_j("articulation_justification", "articulationJustification"),
                model=MODEL_NAME,
            )
        except Exception as e:
            last_err = e
            if attempt >= max_retries:
                break
            backoff = min(max_backoff_s, max(min_backoff_s, (2 ** (attempt - 1)) * 0.5))
            backoff = backoff * (0.8 + 0.4 * random.random())
            time.sleep(backoff)

    raise RuntimeError(f"OpenAI judge call failed after {max_retries} attempts: {last_err}")


def _one_judge_call(
    *,
    row_idx: int,
    scenario: str,
    response: str,
    section_3_instruction: Optional[str] = None,
) -> Tuple[int, JudgeResult]:
    """Single judge API call; runs in a worker thread. Returns (row_idx, result)."""
    result = call_gpt5_judge(
        scenario=scenario,
        response=response,
        section_3_instruction=section_3_instruction,
    )
    return (row_idx, result)


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Section 3: Judge contractor responses with GPT-5.",
        epilog="If you get score 1 for every rubric, the contractor response may not match the scenario (e.g. columns swapped in CSV). Try --swap-scenario-response.",
    )
    p.add_argument("--input", "-i", default=DEFAULT_INPUT_CSV, help="Input CSV path.")
    p.add_argument("--output", "-o", default=DEFAULT_OUTPUT_CSV, help="Output CSV path.")
    p.add_argument("--sleep-s", type=float, default=0.0, help="Sleep between rows (seconds).")
    p.add_argument("--max-rows", type=int, default=0, help="If >0, only judge first N rows.")
    p.add_argument(
        "--swap-scenario-response",
        action="store_true",
        help="Use column labeled task_3_response/sec_3_ans as SCENARIO and initialvalue_scenario as CONTRACTOR RESPONSE. Try this if you get all 1s and your CSV may have columns swapped.",
    )
    return p.parse_args(argv)


def main(argv: Optional[List[str]] = None) -> int:
    args = parse_args(argv)
    load_env()

    script_dir = Path(__file__).resolve().parent
    in_path_p = Path(args.input)
    if not in_path_p.is_absolute():
        in_path_p = script_dir / in_path_p
    out_path_p = Path(args.output)
    if not out_path_p.is_absolute():
        out_path_p = script_dir / out_path_p

    in_path = str(in_path_p)
    out_path = str(out_path_p)

    if not os.path.exists(in_path):
        raise FileNotFoundError(
            f"Input CSV not found: {in_path}\n"
            "Put the file next to judge_section3.py, or pass an absolute path via --input."
        )

    headers, rows = load_csv_rows(in_path)
    if not rows:
        raise ValueError("Input CSV contains no data rows.")

    # Detect CSV format: per-row scenario/question vs single global scenario (legacy).
    # Supported per-row column names (Section 3 - 6th Feb - some Analysis.csv):
    #   Email Id | task_3_response | initialvalue_scenario | initialvalue_sec_3_qn
    #   (optional: section_3_instruction). Response column: task_3_response or sec_3_ans.
    use_per_row = "initialvalue_scenario" in headers and ("sec_3_ans" in headers or "task_3_response" in headers)
    if use_per_row:
        required = ["initialvalue_scenario", "initialvalue_sec_3_qn"]
        missing = [c for c in required if c not in headers]
        if missing:
            raise ValueError(f"Per-row format missing columns: {missing}\nFound: {headers}")
        response_col_per_row = "sec_3_ans" if "sec_3_ans" in headers else "task_3_response"
        col_email_display = "Email Id" if "Email Id" in headers else "email"
    else:
        col_email = "Email address"
        col_email_display = "Email address"
        response_col = next((h for h in headers if h != col_email), None)
        if response_col is None:
            raise ValueError(f"Could not identify response column. Headers: {headers}")
        missing = [c for c in [col_email, response_col] if c not in headers]
        if missing:
            raise ValueError(f"Legacy format missing columns: {missing}\nFound headers: {headers}")

    limit = len(rows) if not args.max_rows or args.max_rows <= 0 else min(len(rows), args.max_rows)

    # Build one task per row: (row_idx, scenario, response, section_3_instruction)
    tasks: List[Tuple[int, str, str, Optional[str]]] = []
    for i in range(limit):
        r = rows[i]
        if use_per_row:
            question_text = (r.get("initialvalue_sec_3_qn", "") or "").strip()
            section_3_instruction = (r.get("section_3_instruction", "") or "").strip() or None
            col_a = (r.get("initialvalue_scenario", "") or "").strip()
            col_b = (r.get(response_col_per_row, "") or "").strip()
            if getattr(args, "swap_scenario_response", False):
                # CSV has scenario in task_3_response column and response in initialvalue_scenario column
                scenario_text = col_b
                response_text = col_a
            else:
                scenario_text = col_a
                response_text = col_b
            if question_text:
                scenario_for_judge = scenario_text + "\n\nQuestion: " + question_text
            else:
                scenario_for_judge = scenario_text
            tasks.append((i, scenario_for_judge, response_text, section_3_instruction))
        else:
            response_text = (r.get(response_col, "") or "").strip()
            tasks.append((i, SCENARIO_AND_QUESTION, response_text, None))

    def run_task(t: Tuple[int, str, str, Optional[str]]) -> Tuple[int, JudgeResult]:
        idx, scenario, response, sec = t
        return _one_judge_call(
            row_idx=idx,
            scenario=scenario,
            response=response,
            section_3_instruction=sec,
        )

    results_by_idx: Dict[int, JudgeResult] = {}
    completed = 0
    print(f"Judging {len(tasks)} rows with {MAX_WORKERS} workers...")
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        future_to_task = {executor.submit(run_task, t): t for t in tasks}
        for future in as_completed(future_to_task):
            row_idx, result = future.result()
            results_by_idx[row_idx] = result
            completed += 1
            r = rows[row_idx]
            email = (r.get(col_email_display, "") or "").strip()
            print(
                f"Completed {completed}/{len(tasks)} (row {row_idx+1}) {email} -> reasoning={result.reasoning_score}, "
                f"evaluation={result.evaluation_score}, articulation={result.articulation_score}"
            )
            if args.sleep_s and args.sleep_s > 0:
                time.sleep(float(args.sleep_s))

    # Build output rows in original order
    out_rows = []
    for i in range(limit):
        r = dict(rows[i])
        result = results_by_idx[i]
        r["judge_model"] = result.model
        r["reasoning_score"] = result.reasoning_score
        r["reasoning_justification"] = result.reasoning_justification
        r["evaluation_score"] = result.evaluation_score
        r["evaluation_justification"] = result.evaluation_justification
        r["articulation_score"] = result.articulation_score
        r["articulation_justification"] = result.articulation_justification
        out_rows.append(r)

    if limit < len(rows):
        for i in range(limit, len(rows)):
            out_rows.append(dict(rows[i]))

    out_headers = list(headers)
    extras = [
        "judge_model",
        "reasoning_score",
        "reasoning_justification",
        "evaluation_score",
        "evaluation_justification",
        "articulation_score",
        "articulation_justification",
    ]
    for e in extras:
        if e not in out_headers:
            out_headers.append(e)

    write_csv_rows(out_path, out_headers, out_rows)
    out_json = str(Path(out_path).with_suffix(".json"))
    write_json_rows(out_json, out_rows)
    print(f"Done. Wrote CSV: {out_path}")
    print(f"Done. Wrote JSON: {out_json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


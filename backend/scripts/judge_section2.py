#!/usr/bin/env python3
# /// script
# requires-python = ">=3.9"
# dependencies = [
#   "openai",
#   "python-dotenv",
# ]
# ///
"""
Section 2: LLM-as-a-judge pipeline (GPT-5).

Reads the contractors CSV and scores each row on:
- Evaluation (Judgment Quality)
- Attention to Detail
- Articulation (Rewriting)
- Comprehension

Outputs a new CSV preserving all original columns and adding score + justification columns.

Edit the defaults below to point to your input/output files and to set the exact prompt/AI response.
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
MAX_WORKERS = 30

# ---- EDIT THESE DEFAULTS (paths are relative to this script's folder unless absolute) ----
DEFAULT_INPUT_CSV = "/Users/vijaychalla/Downloads/compare_prompt/contractor_response_judge/section_2/LP Assessment Evaluation 17 March - Section 2 Responses.csv"
DEFAULT_OUTPUT_CSV = "/Users/vijaychalla/Downloads/compare_prompt/contractor_response_judge/section_2/LP Assessment Evaluation 17 March - Section 2_judged.csv"

# If your Section 2 prompt/AI response differs, update these two constants.
SECTION2_USER_PROMPT = "Explain what role collaboration plays in problem solving."
SECTION2_AI_RESPONSE = (
    "Collaboration plays a key role in problem-solving by bringing together different ideas and perspectives. "
    "Collaborative teams can quickly find the best solution. "
    "Collaboration is essential for solving any problem. "
    "Working alone usually leads to poor outcomes."
)
# ----------------------------


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
    """
    Load environment variables from .env if present.
    """
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


SYSTEM_PROMPT = """You are an LLM Judge evaluating a HUMAN CONTRACTOR'S response for "Section 2: Skill Mapping".

TASK-TO-SKILL ATTRIBUTION (CRITICAL — follow exactly):
Each task measures ONE specific skill. You must assign each skill score ONLY from its corresponding task. Performance in one task must NOT influence the score for a skill mapped to a different task.

- Task 1 (Evaluation of the AI-generated response) → Score "Evaluation (Judgment Quality)" ONLY from Task 1. Do not use Task 2 or Task 3 for this score.
- Task 2 (Identification of specific issues) → Score "Attention to Detail" ONLY from Task 2. Do not use Task 1 or Task 3 for this score.
- Task 3 (Rewriting the response) → Score "Articulation (Rewriting Skills)" ONLY from Task 3. Do not use Task 1 or Task 2 for this score.
- Comprehension → Assessed as a baseline across all three tasks (overall understanding of the prompt, AI response, and instructions).

If a task is missing, incomplete, or not clearly separated, you may limit the score for the skill mapped to that task. Base all other scores strictly on the content of the relevant task only.

Evaluation principles:
- Each task is evaluated independently.
- Scores must be based ONLY on observable evidence from the RELEVANT task for that skill.
- Do NOT infer skills from unrelated sections of the response.
- If evidence for a skill is mixed or borderline, assign the LOWER score.
- For every score, provide a brief, specific justification that references observable elements from the RELEVANT task only (e.g., for Evaluation cite only Task 1; for Attention to Detail cite only Task 2; for Articulation cite only Task 3).

Expected response format: contractor answers should be clearly separated into Evaluation (Task 1), Issues Identified (Task 2), and Rewritten Response (Task 3).

Per-submission context: The prompt given to the AI, the AI-generated response, and the rewrite instructions (tone, word limit, etc.) can differ for each submission. Use ONLY the prompt, AI response, and any "INSTRUCTIONS FOR REWRITE" provided for this submission when judging; do not use any other row or generic context.

Scoring scale for each competency (integer 1-5):
1 = Limited
2 = Basic
3 = Proficient
4 = Advanced
5 = Expert

Rubric (use these descriptions exactly as standards):

1) Evaluation (Judgment Quality) — Score ONLY from Task 1.
Definition: Ability to critically assess the accuracy and balance of the AI response and identify specific issues as requested.
1 Limited: Provides little or no meaningful evaluation. Judgments are incorrect, irrelevant, or purely opinion-based. Does not meaningfully address accuracy or balance, indicating poor judgment or misunderstanding of the task.
2 Basic: Offers a superficial evaluation. Identifies a broad issue (e.g., "too strong" or "not accurate") but provides little or no supporting reasoning. Assessment lacks clarity, specificity, and depth.
3 Proficient: Correctly evaluates the response for accuracy and balance at a basic level. Identifies clear strengths or weaknesses with some explanation, but the assessment remains high-level and may miss secondary implications or nuance.
4 Advanced: Provides a clear, well-reasoned evaluation addressing both accuracy and balance. Explains why specific statements are problematic or appropriate and aligns judgment with training standards. However, the evaluation may stop short of fully exploring downstream implications or edge cases.
5 Expert: Demonstrates strong critical judgment with nuanced evaluation of accuracy, balance, and implications. Clearly explains the impact of overgeneralization or bias and tightly aligns the evaluation with training suitability, including potential consequences if left uncorrected.

2) Attention to Detail — identify/apply ALL relevant instructions/constraints accurately:
1 Limited: misses explicit instructions/constraints; fails to identify conclusive language; rewrite violates multiple core requirements.
2 Basic: partial/inconsistent; identifies only obvious absolutes; violates one or more key requirements.
3 Proficient: identifies majority of definitive language; follows explicit instructions incl. tone; minor misses but overall compliant.
4 Advanced: identifies explicit + implicit definitive language and most imbalance sources; applies instructions consistently; may miss one subtle detail without breaking compliance.
5 Expert: exceptional precision; identifies all relevant details including subtle conclusive phrasing/implicit imbalance; applies every instruction flawlessly.

3) Articulation (Rewriting Skills) — clarity, structure, grammar, professional/neutral tone:
1 Limited: rewrite unclear/confusing; weak/incorrect sentences; inappropriate tone; meaning distorted.
2 Basic: understandable but lacks flow; inconsistent/repetitive; tone uneven/informal.
3 Proficient: clear, logically structured; minor awkwardness; generally neutral/training-suitable.
4 Advanced: well-structured, easy to follow; controlled sentences; professional training tone; minor style inefficiencies.
5 Expert: excellent clarity/structure/tone control; concise purpose-driven; perfectly neutral and instructional.

4) Comprehension — understands prompt, AI response, and task intent:
1 Limited: no understanding; irrelevant/incorrect/disconnected.
2 Basic: surface topic grasp but misunderstands key intent/scope/purpose.
3 Proficient: understands main topic/intent; minor misunderstandings; shallow/literal.
4 Advanced: accurately understands explicit meaning and stated intent; aligned across tasks.
5 Expert: deep nuanced comprehension; recognizes implicit assumptions/framing; understands why task is framed that way.

Output requirements:
- Return JSON ONLY (no markdown, no extra keys).
- Include these keys:
  evaluation_score (1-5), evaluation_justification (string)
  attention_to_detail_score (1-5), attention_to_detail_justification (string)
  articulation_score (1-5), articulation_justification (string)
  comprehension_score (1-5), comprehension_justification (string)
- Each justification must be 1-3 sentences, specific, and cite at least one concrete element (phrase or omission) from the RELEVANT task for that score only.
"""


USER_TEMPLATE = """PROMPT (given to AI):
{user_prompt}

AI-GENERATED RESPONSE (to be evaluated):
{ai_response}
{section_2_block}
CONTRACTOR TASK 1 (Evaluation):
{t1}

CONTRACTOR TASK 2 (Issues Identified):
{t2}

CONTRACTOR TASK 3 (Rewritten Response):
{t3}

Score Task 1, Task 2, and Task 3 based ONLY on the Section 2 instruction document rubric. Use the prompt, AI response, and instructions above as the context for THIS response only; do not use any other row or generic context.
Return JSON only as specified."""


@dataclass
class JudgeResult:
    evaluation_score: int
    evaluation_justification: str
    attention_to_detail_score: int
    attention_to_detail_justification: str
    articulation_score: int
    articulation_justification: str
    comprehension_score: int
    comprehension_justification: str
    model: str


def call_gpt5_judge(
    *,
    user_prompt: str,
    ai_response: str,
    t1: str,
    t2: str,
    t3: str,
    section_2_instruction: Optional[str] = None,
    max_retries: int = 6,
    min_backoff_s: float = 0.75,
    max_backoff_s: float = 12.0,
) -> JudgeResult:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is not set. Put it in .env or your environment.")

    from openai import OpenAI  # type: ignore

    client = OpenAI(api_key=api_key)
    section_2_block = ""
    if section_2_instruction and section_2_instruction.strip():
        section_2_block = "\nINSTRUCTIONS FOR REWRITE (tone, constraints, word limit — apply when judging Task 2 and Task 3):\n" + section_2_instruction.strip() + "\n\n"
    user_text = USER_TEMPLATE.format(
        user_prompt=user_prompt,
        ai_response=ai_response,
        section_2_block=section_2_block,
        t1=t1,
        t2=t2,
        t3=t3,
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
            return JudgeResult(
                evaluation_score=_clamp_int(obj.get("evaluation_score"), 1, 5),
                evaluation_justification=str(obj.get("evaluation_justification") or "").strip(),
                attention_to_detail_score=_clamp_int(obj.get("attention_to_detail_score"), 1, 5),
                attention_to_detail_justification=str(obj.get("attention_to_detail_justification") or "").strip(),
                articulation_score=_clamp_int(obj.get("articulation_score"), 1, 5),
                articulation_justification=str(obj.get("articulation_justification") or "").strip(),
                comprehension_score=_clamp_int(obj.get("comprehension_score"), 1, 5),
                comprehension_justification=str(obj.get("comprehension_justification") or "").strip(),
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
    user_prompt: str,
    ai_response: str,
    t1: str,
    t2: str,
    t3: str,
    section_2_instruction: Optional[str] = None,
) -> Tuple[int, JudgeResult]:
    """Single judge API call; runs in a worker thread. Returns (row_idx, result)."""
    result = call_gpt5_judge(
        user_prompt=user_prompt,
        ai_response=ai_response,
        t1=t1,
        t2=t2,
        t3=t3,
        section_2_instruction=section_2_instruction,
    )
    return (row_idx, result)


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Section 2: Judge contractor responses with GPT-5.")
    p.add_argument("--input", "-i", default=DEFAULT_INPUT_CSV, help="Input CSV path.")
    p.add_argument("--output", "-o", default=DEFAULT_OUTPUT_CSV, help="Output CSV path.")
    p.add_argument("--sleep-s", type=float, default=0.0, help="Sleep between rows (seconds).")
    p.add_argument("--max-rows", type=int, default=0, help="If >0, only judge first N rows.")
    return p.parse_args(argv)


def main(argv: Optional[List[str]] = None) -> int:
    args = parse_args(argv)
    load_env()

    script_dir = Path(__file__).resolve().parent

    in_path = args.input
    out_path = args.output

    # If caller provided relative paths, resolve them relative to this script's folder.
    in_path_p = Path(in_path)
    if not in_path_p.is_absolute():
        in_path_p = script_dir / in_path_p
    out_path_p = Path(out_path)
    if not out_path_p.is_absolute():
        out_path_p = script_dir / out_path_p

    in_path = str(in_path_p)
    out_path = str(out_path_p)

    if not os.path.exists(in_path):
        raise FileNotFoundError(
            f"Input CSV not found: {in_path}\n"
            "Put the file next to judge_section2.py, or pass an absolute path via --input."
        )

    headers, rows = load_csv_rows(in_path)
    if not rows:
        raise ValueError("Input CSV contains no data rows.")

    # Detect CSV format: per-row prompt/AI response (3rd Feb style) vs single global prompt (legacy).
    use_per_row = "initialvalue_prompt" in headers and "task_1_response" in headers
    if use_per_row:
        required = ["initialvalue_prompt", "initialvalue_ai_response", "task_1_response", "task_2_response", "task_3_response"]
        missing = [c for c in required if c not in headers]
        if missing:
            raise ValueError(f"Per-row format missing columns: {missing}\nFound: {headers}")
        col_email_display = "Email Id" if "Email Id" in headers else "email"
    else:
        col_email = "Email address"
        col_email_display = "Email address"
        col_t1 = 'Task 1: Briefly evaluate the AI-generated response for accuracy and balance \n(e.g., Is it overly biased? Does it contain unsupported absolutes?).'
        col_t2 = 'Task 2: Identify specific issues in the AI-generated response \n(e.g., list 2-3 phrases that violate the instructions).'
        col_t3 = 'Task 3: Rewrite the response to meet the given instructions \n(neutral tone, avoid absolutes).'
        missing = [c for c in [col_email, col_t1, col_t2, col_t3] if c not in headers]
        if missing:
            raise ValueError(f"Legacy format missing columns: {missing}\nFound headers: {headers}")

    limit = len(rows) if not args.max_rows or args.max_rows <= 0 else min(len(rows), args.max_rows)

    # Build one task per row: (row_idx, user_prompt, ai_response, t1, t2, t3, section_2_instruction)
    tasks: List[Tuple[int, str, str, str, str, str, Optional[str]]] = []
    for i in range(limit):
        r = rows[i]
        if use_per_row:
            user_prompt = (r.get("initialvalue_prompt", "") or "").strip()
            ai_response = (r.get("initialvalue_ai_response", "") or "").strip()
            section_2_instruction = (r.get("section_2_instruction", "") or "").strip() or None
            t1 = (r.get("task_1_response", "") or "").strip()
            t2 = (r.get("task_2_response", "") or "").strip()
            t3 = (r.get("task_3_response", "") or "").strip()
        else:
            user_prompt = SECTION2_USER_PROMPT
            ai_response = SECTION2_AI_RESPONSE
            section_2_instruction = None
            t1 = (r.get(col_t1, "") or "").strip()
            t2 = (r.get(col_t2, "") or "").strip()
            t3 = (r.get(col_t3, "") or "").strip()
        tasks.append((i, user_prompt, ai_response, t1, t2, t3, section_2_instruction))

    def run_task(t: Tuple[int, str, str, str, str, str, Optional[str]]) -> Tuple[int, JudgeResult]:
        idx, up, ai, t1, t2, t3, sec = t
        return _one_judge_call(
            row_idx=idx,
            user_prompt=up,
            ai_response=ai,
            t1=t1,
            t2=t2,
            t3=t3,
            section_2_instruction=sec,
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
            print(f"Completed {completed}/{len(tasks)} (row {row_idx+1}) {email} -> eval={result.evaluation_score}, detail={result.attention_to_detail_score}, art={result.articulation_score}, comp={result.comprehension_score}")
            if args.sleep_s and args.sleep_s > 0:
                time.sleep(float(args.sleep_s))

    # Build output rows in original order
    out_rows = []
    for i in range(limit):
        r = dict(rows[i])
        result = results_by_idx[i]
        r["judge_model"] = result.model
        r["evaluation_score"] = result.evaluation_score
        r["evaluation_justification"] = result.evaluation_justification
        r["attention_to_detail_score"] = result.attention_to_detail_score
        r["attention_to_detail_justification"] = result.attention_to_detail_justification
        r["articulation_score"] = result.articulation_score
        r["articulation_justification"] = result.articulation_justification
        r["comprehension_score"] = result.comprehension_score
        r["comprehension_justification"] = result.comprehension_justification
        out_rows.append(r)

    # Append remaining rows untouched if max-rows used
    if limit < len(rows):
        for i in range(limit, len(rows)):
            out_rows.append(dict(rows[i]))

    out_headers = list(headers)
    extras = [
        "judge_model",
        "evaluation_score",
        "evaluation_justification",
        "attention_to_detail_score",
        "attention_to_detail_justification",
        "articulation_score",
        "articulation_justification",
        "comprehension_score",
        "comprehension_justification",
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


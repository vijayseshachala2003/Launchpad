# src/evaluator.py
"""
Core evaluation logic for annotator QA.
Implements P0/P1 scoring methodology.
"""

import json
import math
import os
import random
import time
from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Optional, Tuple

# from src.prompts import JUSTIFICATION_JUDGE_TEMPLATE
from src.prompts import (
    JUSTIFICATION_COHERENCE_TEMPLATE,
    JUSTIFICATION_JUDGE_TEMPLATE_LEGACY,
    RUBRIC_COMPLIANCE_TEMPLATE,
)

# Rate limiting settings (shared with generator)
DEFAULT_DELAY_SECONDS = 3.0
MAX_RETRIES = 5
INITIAL_BACKOFF = 10.0
MAX_BACKOFF = 120.0

_last_api_call_time = 0.0


def _rate_limit_delay():
    """Enforce minimum delay between API calls."""
    global _last_api_call_time

    now = time.time()
    elapsed = now - _last_api_call_time

    if elapsed < DEFAULT_DELAY_SECONDS:
        sleep_time = DEFAULT_DELAY_SECONDS - elapsed
        time.sleep(sleep_time)

    _last_api_call_time = time.time()


def _call_llm_with_retry(prompt: str, model_name: str, max_tokens: int = 800) -> str:
    """Call LLM API with exponential backoff retry."""
    backoff = INITIAL_BACKOFF

    for attempt in range(MAX_RETRIES):
        try:
            _rate_limit_delay()

            if "gemini" in model_name.lower():
                import google.generativeai as genai

                model = genai.GenerativeModel(model_name)
                response = model.generate_content(prompt)
                return response.text
            else:
                from together import Together

                client = Together(api_key=os.getenv("TOGETHER_API_KEY"))
                response = client.chat.completions.create(
                    model=model_name,
                    messages=[{"role": "user", "content": prompt}],
                    max_tokens=max_tokens,
                    temperature=0.1,
                )
                return response.choices[0].message.content

        except Exception as e:
            error_str = str(e).lower()

            is_quota_error = any(
                x in error_str
                for x in [
                    "quota",
                    "rate limit",
                    "resource exhausted",
                    "429",
                    "too many requests",
                    "retry",
                ]
            )

            if is_quota_error and attempt < MAX_RETRIES - 1:
                jitter = random.uniform(0, backoff * 0.1)
                wait_time = backoff + jitter
                print(f"  Rate limited. Waiting {wait_time:.1f}s...")
                time.sleep(wait_time)
                backoff = min(backoff * 2, MAX_BACKOFF)
            else:
                raise e

    raise Exception(f"Max retries exceeded for LLM call")


# ============ BATCHED EVALUATION ============

BATCH_JUSTIFICATION_TEMPLATE = """You are an expert annotation quality evaluator. Evaluate each annotator's justification below.

For each case, assess:
1. **Alignment**: Does justification support the ratings given?
2. **Factual Grounding**: Are claims based on actual response content?
3. **Reasoning Quality**: Is the logic sound?

{cases}

Return a JSON array with one object per case:
```json
[
  {{"case_id": 1, "alignment": "aligned|partially_aligned|misaligned", "factual_grounding": "strong|adequate|weak", "reasoning_quality": "strong|adequate|weak", "score": 0.0-1.0, "explanation": "brief explanation"}},
  {{"case_id": 2, ...}},
  ...
]
```

Return ONLY the JSON array, no other text.
"""

SINGLE_CASE_TEMPLATE = """
=== CASE {case_id} ===
PROMPT: {prompt}
RESPONSE A (truncated): {response_a}
RESPONSE B (truncated): {response_b}
ANNOTATOR LIKERT: {annotator_likert} | GOLDEN LIKERT: {golden_likert}
MISMATCHES: {mismatches}
JUSTIFICATION: {justification}
"""


def judge_justifications_batch(
    cases: List[Dict], model_name: str = "Qwen/Qwen3-32B", batch_size: int = 5
) -> List[Dict]:
    """
    Evaluate multiple justifications in a single LLM call.

    Args:
        cases: List of dicts with keys: prompt, response_a, response_b,
               annotator_likert, golden_likert, mismatches, justification
        model_name: LLM model to use
        batch_size: Max cases per LLM call

    Returns:
        List of evaluation results matching input order
    """
    from tqdm import tqdm

    results = []
    num_batches = (len(cases) + batch_size - 1) // batch_size

    for i in tqdm(
        range(0, len(cases), batch_size), total=num_batches, desc="LLM Batches"
    ):
        batch = cases[i : i + batch_size]

        # Build batch prompt
        case_texts = []
        for j, case in enumerate(batch):
            case_text = SINGLE_CASE_TEMPLATE.format(
                case_id=j + 1,
                prompt=case.get("prompt", "")[:500],
                response_a=case.get("response_a", "")[:800],
                response_b=case.get("response_b", "")[:800],
                annotator_likert=case.get("annotator_likert", ""),
                golden_likert=case.get("golden_likert", ""),
                mismatches=", ".join(case.get("mismatches", [])) or "None",
                justification=case.get("justification", "")[:1000],
            )
            case_texts.append(case_text)

        prompt = BATCH_JUSTIFICATION_TEMPLATE.format(cases="\n".join(case_texts))

        try:
            # Increase max_tokens for batch response
            response = _call_llm_with_retry(
                prompt, model_name, max_tokens=300 * len(batch)
            )

            # Parse response
            response = response.strip()
            if "```json" in response:
                response = response.split("```json")[1].split("```")[0]
            elif "```" in response:
                response = response.split("```")[1].split("```")[0]

            batch_results = json.loads(response.strip())

            # Match results to cases by case_id
            result_map = {
                r.get("case_id", j + 1): r for j, r in enumerate(batch_results)
            }
            for j in range(len(batch)):
                results.append(result_map.get(j + 1, _default_result()))

        except Exception as e:
            print(f"  Batch evaluation failed: {e}")
            # Return default results for failed batch
            for _ in batch:
                results.append(_default_result())

    return results


def _default_result() -> Dict:
    """Default result when evaluation fails."""
    return {
        "alignment": "cannot_assess",
        "factual_grounding": "cannot_assess",
        "reasoning_quality": "cannot_assess",
        "score": 0.5,
        "explanation": "Evaluation failed",
    }


# ============ DATA CLASSES ============


@dataclass
class DimensionScore:
    """Score for a single dimension evaluation."""

    dimension_id: str
    annotator_value: str
    golden_value: str
    priority: str  # P0 or P1
    penalty: float
    match: bool


@dataclass
class EvaluationResult:
    """Complete evaluation result for one annotator submission."""

    subtask_id: Any
    annotator_id: str
    annotator_name: str

    scores_a: List[DimensionScore] = field(default_factory=list)
    scores_b: List[DimensionScore] = field(default_factory=list)

    annotator_likert: str = ""
    golden_likert: str = ""
    likert_match: bool = False
    likert_penalty: float = 0.0

    justification: str = ""

    # M1: Golden Alignment (rule-based)
    dimension_score: float = 0.0  # Already exists

    # M2: Justification Coherence (LLM)
    justification_coherence: Optional[Dict] = None
    justification_coherence_score: float = 0.5

    # M3: Rubric Compliance (LLM, optional)
    rubric_compliance: Optional[Dict] = None
    rubric_compliance_score: Optional[float] = None  # None if no rubric

    # Final aggregated score
    final_score: float = 0.0

    flagged: bool = False
    flag_reasons: List[str] = field(default_factory=list)

    # Keep for backward compatibility (maps to M2)
    @property
    def justification_score(self) -> float:
        return self.justification_coherence_score

    @property
    def llm_judge_result(self) -> Optional[Dict]:
        return self.justification_coherence

    def to_dict(self) -> Dict:
        """Convert to dictionary for JSON serialization."""
        result = asdict(self)
        result["scores_a"] = [asdict(s) for s in self.scores_a]
        result["scores_b"] = [asdict(s) for s in self.scores_b]
        # Add backward-compatible fields
        result["justification_score"] = self.justification_coherence_score
        result["llm_judge_result"] = self.justification_coherence
        return result


# ============ VALUE NORMALIZATION ============


def normalize_value(value: Any) -> str:
    """Normalize judgement values to standard format."""
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return "na"

    value = str(value).strip().lower()

    mappings = {
        "no issues": "no_issues",
        "no issue": "no_issues",
        "minor issue(s)": "minor_issues",
        "minor issues": "minor_issues",
        "major issue(s)": "major_issues",
        "major issues": "major_issues",
        "n/a - not applicable": "na",
        "not applicable": "na",
        "n/a": "na",
        "na": "na",
        "cannot assess": "cannot_assess",
        "cannot be assessed": "cannot_assess",
        "cannot be improved": "cannot_be_improved",
        "minor room for improvement": "minor_room_for_improvement",
        "okay": "okay",
        "pretty bad": "pretty_bad",
        "unusable": "unusable",
    }

    return mappings.get(value, value.replace(" ", "_").replace("-", "_"))


def normalize_likert(value: Any) -> Tuple[int, str]:
    """Normalize Likert rating to (numeric, category)."""
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return (4, "about_the_same")

    value = str(value).strip().lower()

    # Parse format like "6 (B is better than A)"
    if "(" in value:
        try:
            numeric = int(value.split("(")[0].strip())
            return (numeric, _likert_category(numeric))
        except:
            pass

    # Parse text format
    text_mappings = {
        "a is much better than b": (1, "a_much_better"),
        "a is better than b": (2, "a_better"),
        "a is slightly better than b": (3, "a_slightly_better"),
        "about the same": (4, "about_the_same"),
        "a and b are about the same": (4, "about_the_same"),
        "b is slightly better than a": (5, "b_slightly_better"),
        "b is better than a": (6, "b_better"),
        "b is much better than a": (7, "b_much_better"),
    }

    return text_mappings.get(value, (4, "about_the_same"))


def _likert_category(score: int) -> str:
    """Convert numeric Likert to category."""
    categories = {
        1: "a_much_better",
        2: "a_better",
        3: "a_slightly_better",
        4: "about_the_same",
        5: "b_slightly_better",
        6: "b_better",
        7: "b_much_better",
    }
    return categories.get(score, "about_the_same")


# ============ P0/P1 SCORING ============


def calculate_p0_penalty(annotator: str, golden: str) -> float:
    """P0 (Objective): Binary match. 0 for match, 1 for mismatch."""
    return 0.0 if annotator == golden else 1.0


def calculate_p1_penalty(annotator: str, golden: str) -> float:
    """
    P1 (Subjective): Variable penalty based on variance.

    Penalty matrices based on RLHF Score Calculation document.
    """
    if annotator == golden:
        return 0.0

    # Standard dimension penalty matrices
    penalty_matrices = {
        "no_issues": {
            "major_issues": 0.6,
            "minor_issues": 0.4,
            "na": 0.4,
            "cannot_assess": 0.4,
        },
        "minor_issues": {
            "major_issues": 0.4,
            "no_issues": 0.4,
            "na": 0.6,
            "cannot_assess": 0.4,
        },
        "major_issues": {
            "no_issues": 0.6,
            "minor_issues": 0.4,
            "na": 0.8,
            "cannot_assess": 0.4,
        },
        "na": {
            "major_issues": 0.8,
            "minor_issues": 0.6,
            "no_issues": 0.4,
            "cannot_assess": 0.4,
        },
        "cannot_assess": {
            "major_issues": 0.4,
            "minor_issues": 0.4,
            "no_issues": 0.4,
            "na": 0.4,
        },
        # Overall quality ratings
        "cannot_be_improved": {
            "minor_room_for_improvement": 0.2,
            "okay": 0.4,
            "pretty_bad": 0.6,
            "unusable": 0.8,
        },
        "minor_room_for_improvement": {
            "cannot_be_improved": 0.2,
            "okay": 0.2,
            "pretty_bad": 0.4,
            "unusable": 0.6,
        },
        "okay": {
            "cannot_be_improved": 0.4,
            "minor_room_for_improvement": 0.2,
            "pretty_bad": 0.2,
            "unusable": 0.4,
        },
        "pretty_bad": {
            "cannot_be_improved": 0.6,
            "minor_room_for_improvement": 0.4,
            "okay": 0.2,
            "unusable": 0.2,
        },
        "unusable": {
            "cannot_be_improved": 0.8,
            "minor_room_for_improvement": 0.6,
            "okay": 0.4,
            "pretty_bad": 0.2,
        },
    }

    if golden in penalty_matrices:
        return penalty_matrices[golden].get(annotator, 0.5)

    return 0.5  # Default for unknown combinations


def calculate_likert_penalty(annotator_num: int, golden_num: int) -> float:
    """Calculate penalty for Likert scale mismatch."""
    distance = abs(annotator_num - golden_num)
    penalties = {0: 0.0, 1: 0.2, 2: 0.4, 3: 0.6, 4: 0.8, 5: 0.9, 6: 1.0}
    return penalties.get(distance, 1.0)


# ============ LLM-AS-JUDGE ============


def judge_justification_coherence(
    justification: str,
    original_prompt: str,
    response_a: str,
    response_b: str,
    annotator_likert: str,
    dimension_scores_a: Dict[str, str],
    dimension_scores_b: Dict[str, str],
    model_name: str = "gemini-2.5-flash",
) -> Dict:
    """
    M2: Evaluate internal consistency of annotator's justification.

    Checks if justification aligns with annotator's OWN ratings.
    No rubric or golden labels needed.

    Returns:
        Dict with keys: claim_verification, rating_alignment,
        likert_consistency, logical_flow, issues_found, score, explanation
    """
    if not justification or not justification.strip():
        return {
            "claim_verification": "cannot_assess",
            "rating_alignment": "cannot_assess",
            "likert_consistency": "cannot_assess",
            "logical_flow": "cannot_assess",
            "issues_found": [],
            "score": 0.5,
            "explanation": "No justification provided",
        }

    # Truncate responses if too long
    max_len = 2000
    response_a_trunc = (
        response_a[:max_len] + "..." if len(response_a) > max_len else response_a
    )
    response_b_trunc = (
        response_b[:max_len] + "..." if len(response_b) > max_len else response_b
    )

    prompt = JUSTIFICATION_COHERENCE_TEMPLATE.format(
        original_prompt=original_prompt,
        response_a=response_a_trunc,
        response_b=response_b_trunc,
        dimension_scores_a=json.dumps(dimension_scores_a),
        dimension_scores_b=json.dumps(dimension_scores_b),
        annotator_likert=annotator_likert,
        justification=justification,
    )

    try:
        result_text = _call_llm_with_retry(prompt, model_name, max_tokens=800)

        # Clean and parse JSON
        result_text = result_text.strip()
        if "```json" in result_text:
            result_text = result_text.split("```json")[1].split("```")[0]
        elif "```" in result_text:
            result_text = result_text.split("```")[1].split("```")[0]

        return json.loads(result_text.strip())

    except Exception as e:
        return {
            "claim_verification": "cannot_assess",
            "rating_alignment": "cannot_assess",
            "likert_consistency": "cannot_assess",
            "logical_flow": "cannot_assess",
            "issues_found": [],
            "score": 0.5,
            "explanation": f"LLM evaluation failed: {str(e)}",
        }


def judge_rubric_compliance(
    justification: str,
    rubric: Dict,
    original_prompt: str,
    response_a: str,
    response_b: str,
    annotator_likert: str,
    golden_likert: str,
    dimension_scores_a: Dict[str, str],
    dimension_scores_b: Dict[str, str],
    golden_scores_a: Dict[str, str],
    golden_scores_b: Dict[str, str],
    mismatches: List[str],
    context_info: str = "",
    model_name: str = "gemini-2.5-flash",
) -> Dict:
    """
    M3: Evaluate if annotator correctly applied the rubric definitions.

    Requires rubric. Assesses whether justification follows formal definitions.

    Returns:
        Dict with keys: dimension_assessments, overall_compliance,
        defensible_disagreements, clear_errors, score, explanation
    """
    if not justification or not justification.strip():
        return {
            "dimension_assessments": [],
            "overall_compliance": "cannot_assess",
            "defensible_disagreements": [],
            "clear_errors": [],
            "score": 0.5,
            "explanation": "No justification provided",
        }

    # Format rubric definitions for prompt
    rubric_definitions = _format_rubric_for_prompt(rubric)

    # Truncate responses if too long
    max_len = 1500  # Shorter since rubric takes space
    response_a_trunc = (
        response_a[:max_len] + "..." if len(response_a) > max_len else response_a
    )
    response_b_trunc = (
        response_b[:max_len] + "..." if len(response_b) > max_len else response_b
    )

    prompt = RUBRIC_COMPLIANCE_TEMPLATE.format(
        rubric_definitions=rubric_definitions,
        original_prompt=original_prompt,
        response_a=response_a_trunc,
        response_b=response_b_trunc,
        context_info=context_info or "None provided",
        dimension_scores_a=json.dumps(dimension_scores_a),
        dimension_scores_b=json.dumps(dimension_scores_b),
        annotator_likert=annotator_likert,
        golden_scores_a=json.dumps(golden_scores_a),
        golden_scores_b=json.dumps(golden_scores_b),
        golden_likert=golden_likert,
        mismatches="\n".join(mismatches) if mismatches else "None",
        justification=justification,
    )

    try:
        result_text = _call_llm_with_retry(prompt, model_name, max_tokens=1000)

        # Clean and parse JSON
        result_text = result_text.strip()
        if "```json" in result_text:
            result_text = result_text.split("```json")[1].split("```")[0]
        elif "```" in result_text:
            result_text = result_text.split("```")[1].split("```")[0]

        return json.loads(result_text.strip())

    except Exception as e:
        return {
            "dimension_assessments": [],
            "overall_compliance": "cannot_assess",
            "defensible_disagreements": [],
            "clear_errors": [],
            "score": 0.5,
            "explanation": f"LLM evaluation failed: {str(e)}",
        }


def _format_rubric_for_prompt(rubric: Dict) -> str:
    """Format rubric dict into readable string for LLM prompt."""
    rubric_data = rubric.get("rubric", rubric)

    lines = []
    for cat in rubric_data.get("categories", []):
        lines.append(f"### {cat.get('name', cat.get('id', 'Unknown'))}")
        lines.append(f"**Definition:** {cat.get('description', 'N/A')}")

        if "levels" in cat:
            lines.append("**Rating Levels:**")
            for level in cat["levels"]:
                lines.append(
                    f"  - {level.get('label', '?')}: {level.get('description', '')}"
                )
        lines.append("")

    return "\n".join(lines)


# ============ CORE EVALUATION ============


def evaluate_dimension(
    annotator_value: Any, golden_value: Any, priority: str, dimension_id: str
) -> DimensionScore:
    """Evaluate a single dimension."""
    ann_norm = normalize_value(annotator_value)
    gold_norm = normalize_value(golden_value)
    priority = str(priority).upper() if priority else "P1"

    if priority == "P0":
        penalty = calculate_p0_penalty(ann_norm, gold_norm)
    else:
        penalty = calculate_p1_penalty(ann_norm, gold_norm)

    return DimensionScore(
        dimension_id=dimension_id,
        annotator_value=str(annotator_value),
        golden_value=str(golden_value),
        priority=priority,
        penalty=penalty,
        match=(ann_norm == gold_norm),
    )


def evaluate_row(
    row: Dict,
    column_mappings: Dict,
    rubric: Optional[Dict] = None,
    use_llm_judge: bool = False,
    llm_model: str = "gemini-2.5-flash",
    prompt_context: Optional[Dict] = None,
) -> EvaluationResult:
    """
    Evaluate a single row from merged dataframe.

    Args:
        row: Dictionary containing merged annotator + golden data.
        column_mappings: Mappings from generator.
        use_llm_judge: Whether to use LLM for justification evaluation.
        llm_model: Model to use for LLM judge.
        prompt_context: Optional dict with original prompt and responses for entailment checking.

        Metrics computed:
        M1: dimension_score (rule-based golden alignment)
        M2: justification_coherence_score (LLM, if use_llm_judge=True)
        M3: rubric_compliance_score (LLM, if use_llm_judge=True AND rubric provided)

        Final Score = 0.8 * M1 + 0.2 * M2

    Returns:
        EvaluationResult object.
    """
    dims = column_mappings.get("dimensions", {})
    ids = column_mappings.get("identifiers", {})
    likert_cfg = column_mappings.get("likert", {})

    result = EvaluationResult(
        subtask_id=row.get(ids.get("subtask_id_annotator", "subtask_id")),
        annotator_id=str(row.get(ids.get("annotator_id", "user_id"), "unknown")),
        annotator_name=str(
            row.get(ids.get("annotator_name", "freelancer_name"), "unknown")
        ),
        justification=str(
            row.get(column_mappings.get("justification", "justification"), "")
        ),
    )

    scores_a = []
    scores_b = []
    total_penalty = 0.0
    dim_count = 0

    ann_scores_a = {}
    ann_scores_b = {}
    gold_scores_a = {}
    gold_scores_b = {}
    mismatches = []

    # ========== M1: Evaluate each dimension (rule-based) ==========
    for dim_id, dim_cols in dims.items():
        # Response A
        if dim_cols.get("annotator_a") and dim_cols.get("golden_a"):
            ann_val = row.get(dim_cols["annotator_a"])
            golden_col_a = dim_cols["golden_a"]
            gold_val = row.get(f"{golden_col_a}_golden") or row.get(golden_col_a)
            priority_col_a = dim_cols.get("priority_a", "")
            priority = (
                row.get(f"{priority_col_a}_golden") or row.get(priority_col_a) or "P1"
            )

            score = evaluate_dimension(ann_val, gold_val, priority, dim_id)
            scores_a.append(score)
            total_penalty += score.penalty
            dim_count += 1

            ann_scores_a[dim_id] = str(ann_val)
            gold_scores_a[dim_id] = str(gold_val)

            if not score.match:
                mismatches.append(f"{dim_id}_A: annotator={ann_val}, golden={gold_val}")

        # Response B
        if dim_cols.get("annotator_b") and dim_cols.get("golden_b"):
            ann_val = row.get(dim_cols["annotator_b"])
            golden_col_b = dim_cols["golden_b"]
            gold_val = row.get(f"{golden_col_b}_golden") or row.get(golden_col_b)
            priority_col_b = dim_cols.get("priority_b", "")
            priority = (
                row.get(f"{priority_col_b}_golden") or row.get(priority_col_b) or "P1"
            )

            score = evaluate_dimension(ann_val, gold_val, priority, dim_id)
            scores_b.append(score)
            total_penalty += score.penalty
            dim_count += 1

            ann_scores_b[dim_id] = str(ann_val)
            gold_scores_b[dim_id] = str(gold_val)

            if not score.match:
                mismatches.append(f"{dim_id}_B: annotator={ann_val}, golden={gold_val}")

    result.scores_a = scores_a
    result.scores_b = scores_b

    # Evaluate Likert
    ann_likert_raw = row.get(likert_cfg.get("annotator", "likert_rating"))
    golden_likert_col = likert_cfg.get("golden", "Likert Scale")
    gold_likert_raw = row.get(f"{golden_likert_col}_golden") or row.get(
        golden_likert_col
    )

    ann_likert_num, _ = normalize_likert(ann_likert_raw)
    gold_likert_num, _ = normalize_likert(gold_likert_raw)

    result.annotator_likert = str(ann_likert_raw)
    result.golden_likert = str(gold_likert_raw)
    result.likert_match = ann_likert_num == gold_likert_num
    result.likert_penalty = calculate_likert_penalty(ann_likert_num, gold_likert_num)

    # Calculate M1: dimension_score
    avg_penalty = total_penalty / max(dim_count, 1)
    combined_penalty = (avg_penalty + result.likert_penalty) / 2
    result.dimension_score = 1.0 - combined_penalty

    # ========== M2: Justification Coherence (LLM) ==========
    if use_llm_judge and result.justification.strip() and prompt_context:
        m2_result = judge_justification_coherence(
            justification=result.justification,
            original_prompt=prompt_context.get("prompt", ""),
            response_a=prompt_context.get("response_a", ""),
            response_b=prompt_context.get("response_b", ""),
            annotator_likert=result.annotator_likert,
            dimension_scores_a=ann_scores_a,
            dimension_scores_b=ann_scores_b,
            model_name=llm_model,
        )
        result.justification_coherence = m2_result
        result.justification_coherence_score = m2_result.get("score", 0.5)

    # ========== M3: Rubric Compliance (LLM, optional) ==========
    if use_llm_judge and result.justification.strip() and prompt_context and rubric:
        # Get context columns if available
        context_info = _build_context_info(row, column_mappings)

        m3_result = judge_rubric_compliance(
            justification=result.justification,
            rubric=rubric,
            original_prompt=prompt_context.get("prompt", ""),
            response_a=prompt_context.get("response_a", ""),
            response_b=prompt_context.get("response_b", ""),
            annotator_likert=result.annotator_likert,
            golden_likert=result.golden_likert,
            dimension_scores_a=ann_scores_a,
            dimension_scores_b=ann_scores_b,
            golden_scores_a=gold_scores_a,
            golden_scores_b=gold_scores_b,
            mismatches=mismatches,
            context_info=context_info,
            model_name=llm_model,
        )
        result.rubric_compliance = m3_result
        result.rubric_compliance_score = m3_result.get("score", 0.5)

    # Final score: 80% dimension + 20% justification
    result.final_score = 0.8 * result.dimension_score + 0.2 * result.justification_score

    # Determine flags
    p0_mismatches = sum(
        1 for s in scores_a + scores_b if s.priority == "P0" and not s.match
    )

    if p0_mismatches > 0:
        result.flag_reasons.append(f"P0 mismatches: {p0_mismatches}")
    if result.likert_penalty > 0.4:
        result.flag_reasons.append(
            f"Likert mismatch: {result.annotator_likert} vs {result.golden_likert}"
        )
    if (
        result.justification_coherence
        and result.justification_coherence.get("rating_alignment") == "misaligned"
    ):
        result.flag_reasons.append("Justification misaligned with ratings")
    if (
        result.rubric_compliance
        and result.rubric_compliance.get("overall_compliance") == "non_compliant"
    ):
        result.flag_reasons.append("Rubric non-compliant")
    if result.final_score < 0.6:
        result.flag_reasons.append(f"Low score: {result.final_score:.2f}")

    result.flagged = len(result.flag_reasons) > 0

    return result


def _build_context_info(row: Dict, column_mappings: Dict) -> str:
    """Build context info string from context_columns."""
    context_cols = column_mappings.get("context_columns", {})
    if not context_cols:
        return ""

    lines = []
    for semantic_key, col_name in context_cols.items():
        value = row.get(f"{col_name}_golden") or row.get(col_name)
        if value:
            lines.append(f"**{semantic_key}:** {value}")

    return "\n".join(lines) if lines else "None provided"

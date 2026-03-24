# batch_evaluate.py
"""
Standalone batch evaluation script with batched LLM calls.
Properly integrated with existing evaluator.py pipeline.

Evaluation Metrics:
- M1: Rule-based dimension scoring (always calculated)
- M2: Justification coherence - internal consistency (optional, requires --use-llm)
- M3: Rubric compliance - external validity (optional, requires --use-llm + --rubric)
"""

import argparse
import csv
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

from src.config import configure_api
from src.evaluator import (
    EvaluationResult,
    _call_llm_with_retry,
    _format_rubric_for_prompt,
    evaluate_row,
)
from src.reporter import (
    compute_annotator_rankings,
    compute_dimension_accuracy,
    compute_statistics,
    generate_plots,
    generate_summary_report,
    save_results_to_csv,
)

# =============================================================================
# BATCH TEMPLATES (M2 and M2+M3)
# =============================================================================

BATCH_M2_ONLY_TEMPLATE = """Evaluate each annotator's justification for internal coherence (M2).

M2 checks: Does the justification align with the annotator's OWN ratings?

{cases}

Return a JSON array with one object per case:
```json
[
  {{"case_id": 1, "claim_verification": "verified|partially_verified|unverified|fabricated", "rating_alignment": "aligned|partially_aligned|misaligned", "likert_consistency": "consistent|inconsistent", "logical_flow": "sound|minor_gaps|contradictory", "score": 0.0-1.0, "explanation": "brief"}},
  ...
]
```

SCORING: 1.0=perfect coherence, 0.5=partial issues, 0.0=incoherent
Return ONLY the JSON array.
"""

BATCH_M2_CASE_TEMPLATE = """
=== CASE {case_id} ===
PROMPT: {prompt}
RESPONSE A: {response_a}
RESPONSE B: {response_b}
ANNOTATOR RATINGS A: {ann_scores_a}
ANNOTATOR RATINGS B: {ann_scores_b}
ANNOTATOR LIKERT: {annotator_likert}
JUSTIFICATION: {justification}
"""

BATCH_COMBINED_M2_M3_TEMPLATE = """Evaluate each annotator case for M2 (internal coherence) and M3 (rubric compliance).

## RUBRIC DEFINITIONS:
{rubric_definitions}

{cases}

Return a JSON array with one object per case:
```json
[
  {{"case_id": 1, "m2": {{"claim_verification": "verified", "rating_alignment": "aligned", "likert_consistency": "consistent", "logical_flow": "sound", "score": 0.0-1.0, "explanation": "brief"}}, "m3": {{"overall_compliance": "compliant", "defensible_disagreements": [], "clear_errors": [], "score": 0.0-1.0, "explanation": "brief"}}}},
  ...
]
```

M2: Internal coherence - does justification match annotator's own ratings?
M3: Rubric compliance - does justification correctly apply rubric definitions?

Return ONLY the JSON array.
"""

BATCH_M2_M3_CASE_TEMPLATE = """
=== CASE {case_id} ===
PROMPT: {prompt}
RESPONSE A: {response_a}
RESPONSE B: {response_b}
ANNOTATOR RATINGS A: {ann_scores_a}
ANNOTATOR RATINGS B: {ann_scores_b}
ANNOTATOR LIKERT: {annotator_likert}
GOLDEN RATINGS A: {golden_scores_a}
GOLDEN RATINGS B: {golden_scores_b}
GOLDEN LIKERT: {golden_likert}
MISMATCHES: {mismatches}
JUSTIFICATION: {justification}
"""

# =============================================================================
# BATCH EVALUATION FUNCTIONS
# =============================================================================


def _default_m2_result() -> Dict:
    """Default M2 result when evaluation fails."""
    return {
        "claim_verification": "cannot_assess",
        "rating_alignment": "cannot_assess",
        "likert_consistency": "cannot_assess",
        "logical_flow": "cannot_assess",
        "score": 0.5,
        "explanation": "Evaluation failed",
    }


def _default_combined_result() -> Dict:
    """Default combined M2+M3 result when evaluation fails."""
    return {
        "m2": _default_m2_result(),
        "m3": {
            "overall_compliance": "cannot_assess",
            "defensible_disagreements": [],
            "clear_errors": [],
            "score": 0.5,
            "explanation": "Evaluation failed",
        },
    }


def judge_batch_m2_only(
    cases: List[Dict],
    model_name: str = "gemini-2.5-flash",
    batch_size: int = 15,
) -> List[Dict]:
    """
    Evaluate M2 only (no rubric needed).
    Uses batched LLM calls for efficiency.

    Returns:
        List of M2 result dicts
    """
    from tqdm import tqdm

    results = []
    num_batches = (len(cases) + batch_size - 1) // batch_size

    for i in tqdm(
        range(0, len(cases), batch_size), total=num_batches, desc="M2 Batches"
    ):
        batch = cases[i : i + batch_size]

        case_texts = []
        for j, case in enumerate(batch):
            case_text = BATCH_M2_CASE_TEMPLATE.format(
                case_id=j + 1,
                prompt=case.get("prompt", "")[:500],
                response_a=case.get("response_a", "")[:800],
                response_b=case.get("response_b", "")[:800],
                ann_scores_a=json.dumps(case.get("ann_scores_a", {})),
                ann_scores_b=json.dumps(case.get("ann_scores_b", {})),
                annotator_likert=case.get("annotator_likert", ""),
                justification=case.get("justification", "")[:1000],
            )
            case_texts.append(case_text)

        prompt = BATCH_M2_ONLY_TEMPLATE.format(cases="\n".join(case_texts))

        try:
            response = _call_llm_with_retry(
                prompt, model_name, max_tokens=300 * len(batch)
            )

            response = response.strip()
            if "```json" in response:
                response = response.split("```json")[1].split("```")[0]
            elif "```" in response:
                response = response.split("```")[1].split("```")[0]

            batch_results = json.loads(response.strip())

            result_map = {
                r.get("case_id", j + 1): r for j, r in enumerate(batch_results)
            }
            for j in range(len(batch)):
                results.append(result_map.get(j + 1, _default_m2_result()))

        except Exception as e:
            print(f"  M2 batch failed: {e}")
            for _ in batch:
                results.append(_default_m2_result())

    return results


def judge_batch_combined(
    cases: List[Dict],
    rubric: Dict,
    model_name: str = "gemini-2.5-flash",
    batch_size: int = 5,
) -> List[Dict]:
    """
    Evaluate combined M2+M3 (requires rubric).
    Uses batched LLM calls for efficiency.

    Returns:
        List of {"m2": {...}, "m3": {...}} result dicts
    """
    from tqdm import tqdm

    rubric_definitions = _format_rubric_for_prompt(rubric)

    results = []
    num_batches = (len(cases) + batch_size - 1) // batch_size

    for i in tqdm(
        range(0, len(cases), batch_size), total=num_batches, desc="M2+M3 Batches"
    ):
        batch = cases[i : i + batch_size]

        case_texts = []
        for j, case in enumerate(batch):
            case_text = BATCH_M2_M3_CASE_TEMPLATE.format(
                case_id=j + 1,
                prompt=case.get("prompt", "")[:500],
                response_a=case.get("response_a", "")[:800],
                response_b=case.get("response_b", "")[:800],
                ann_scores_a=json.dumps(case.get("ann_scores_a", {})),
                ann_scores_b=json.dumps(case.get("ann_scores_b", {})),
                annotator_likert=case.get("annotator_likert", ""),
                golden_scores_a=json.dumps(case.get("golden_scores_a", {})),
                golden_scores_b=json.dumps(case.get("golden_scores_b", {})),
                golden_likert=case.get("golden_likert", ""),
                mismatches=", ".join(case.get("mismatches", [])) or "None",
                justification=case.get("justification", "")[:1000],
            )
            case_texts.append(case_text)

        prompt = BATCH_COMBINED_M2_M3_TEMPLATE.format(
            rubric_definitions=rubric_definitions[:3000],
            cases="\n".join(case_texts),
        )

        try:
            response = _call_llm_with_retry(
                prompt, model_name, max_tokens=400 * len(batch)
            )

            response = response.strip()
            if "```json" in response:
                response = response.split("```json")[1].split("```")[0]
            elif "```" in response:
                response = response.split("```")[1].split("```")[0]

            batch_results = json.loads(response.strip())

            result_map = {
                r.get("case_id", j + 1): r for j, r in enumerate(batch_results)
            }
            for j in range(len(batch)):
                results.append(result_map.get(j + 1, _default_combined_result()))

        except Exception as e:
            print(f"  M2+M3 batch failed: {e}")
            for _ in batch:
                results.append(_default_combined_result())

    return results


# =============================================================================
# MAIN BATCH EVALUATION FUNCTION
# =============================================================================


def run_batch_evaluation(
    annotator_csv_path: str,
    golden_csv_path: str,
    rubric_path: Optional[str],
    mappings_path: str,
    output_dir: str,
    use_llm_judge: bool = False,
    llm_model: str = "gemini-2.5-flash",
    batch_size: int = 5,
    limit: Optional[int] = None,
) -> None:
    """
    Run batch evaluation on annotator data against golden labels.
    Uses batched LLM calls for faster processing.

    Evaluation Metrics:
    - M1: Rule-based dimension scoring (always calculated)
    - M2: Justification coherence (requires use_llm_judge=True)
    - M3: Rubric compliance (requires use_llm_judge=True AND rubric_path)

    Args:
        annotator_csv_path: Path to annotator responses CSV.
        golden_csv_path: Path to golden labels CSV.
        rubric_path: Optional path to rubric JSON file.
        mappings_path: Path to column mappings JSON file.
        output_dir: Directory for output files.
        use_llm_judge: Whether to use LLM for justification evaluation (M2/M3).
        llm_model: Model to use for LLM-as-judge.
        batch_size: Number of rows per LLM call.
        limit: Maximum number of rows to process.
    """
    print(f"{'=' * 80}")
    print(f"BATCH ANNOTATOR EVALUATION")
    print(f"{'=' * 80}")
    print(f"Model: {llm_model}")
    print(f"Batch Size: {batch_size} rows per LLM call")

    # Load rubric (optional)
    rubric = None
    if rubric_path and os.path.exists(rubric_path):
        print(f"\nLoading rubric from: {rubric_path}")
        with open(rubric_path, "r", encoding="utf-8") as f:
            rubric = json.load(f)
        print("✓ Rubric loaded")
    else:
        print("\n⚠ No rubric provided")

    # Determine evaluation mode
    print("\n--- Evaluation Mode ---")
    print(f"M1 (Dimension Scoring): ✓ Enabled (always)")
    if use_llm_judge:
        print(f"M2 (Justification Coherence): ✓ Enabled")
        if rubric:
            print(f"M3 (Rubric Compliance): ✓ Enabled")
        else:
            print(f"M3 (Rubric Compliance): ✗ Disabled (no rubric)")
    else:
        print(f"M2 (Justification Coherence): ✗ Disabled")
        print(f"M3 (Rubric Compliance): ✗ Disabled")

    # Load column mappings
    print(f"\nLoading column mappings from: {mappings_path}")
    with open(mappings_path, "r", encoding="utf-8") as f:
        column_mappings = json.load(f)

    # Load CSV data
    print(f"Loading annotator data from: {annotator_csv_path}")
    with open(annotator_csv_path, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        annotator_rows = list(reader)

    print(f"Loading golden labels from: {golden_csv_path}")
    with open(golden_csv_path, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        golden_rows = list(reader)

    # Create golden lookup
    ids_cfg = column_mappings.get("identifiers", {})
    prompt_cols = column_mappings.get("prompt_columns", {})

    golden_id_col = ids_cfg.get("subtask_id_golden", "subtask_id")
    ann_id_col = ids_cfg.get("subtask_id_annotator", "subtask_id")

    prompt_col = prompt_cols.get("prompt", "Prompt")
    response_a_col = prompt_cols.get("response_a", "ResponseA")
    response_b_col = prompt_cols.get("response_b", "ResponseB")

    # Create golden lookup (also serves as prompt context source)
    golden_lookup = {}
    for row in golden_rows:
        task_id = row.get(golden_id_col)
        if task_id:
            golden_lookup[str(task_id)] = row

    print(f"\nFound {len(annotator_rows)} annotator submissions")
    print(f"Found {len(golden_lookup)} golden labels")

    if limit:
        annotator_rows = annotator_rows[:limit]
        print(f"Limited to {limit} rows")

    # =========================================================================
    # PASS 1: Rule-based M1 evaluation (instant)
    # =========================================================================
    print(f"\n{'=' * 80}")
    print(f"PASS 1: M1 Scoring (Rule-Based Dimension Matching)")
    print(f"{'=' * 80}")

    from tqdm import tqdm

    results = []
    cases_for_llm = []
    skipped = 0
    empty_justifications = 0

    for ann_row in tqdm(annotator_rows, desc="M1 Scoring"):
        task_id = str(ann_row.get(ann_id_col, ""))

        if task_id not in golden_lookup:
            skipped += 1
            continue

        # Get golden row
        gold_row = golden_lookup[task_id]

        # Merge rows (add _golden suffix to golden columns)
        merged = {**ann_row}
        for k, v in gold_row.items():
            merged[f"{k}_golden"] = v

        # Build prompt context from golden row
        prompt_context = {
            "prompt": gold_row.get(prompt_col, ""),
            "response_a": gold_row.get(response_a_col, ""),
            "response_b": gold_row.get(response_b_col, ""),
        }

        # Evaluate M1 (rule-based only, no LLM)
        try:
            result = evaluate_row(
                merged,
                column_mappings,
                rubric=rubric,
                use_llm_judge=False,  # M1 only in Pass 1
                llm_model=llm_model,
                prompt_context=prompt_context,
            )
            results.append(result)

            # Collect for LLM batch if needed
            if use_llm_judge:
                justification_col = column_mappings.get(
                    "justification", "Justification"
                )
                justification = ann_row.get(justification_col, "").strip()

                # Only add to LLM queue if justification is not empty
                if justification:
                    # Build dimension scores for M2/M3
                    ann_scores_a = {}
                    ann_scores_b = {}
                    golden_scores_a = {}
                    golden_scores_b = {}

                    for score in result.scores_a:
                        ann_scores_a[score.dimension_id] = score.annotator_value
                        golden_scores_a[score.dimension_id] = score.golden_value

                    for score in result.scores_b:
                        ann_scores_b[score.dimension_id] = score.annotator_value
                        golden_scores_b[score.dimension_id] = score.golden_value

                    cases_for_llm.append(
                        {
                            "idx": len(results) - 1,
                            "task_id": task_id,
                            "prompt": prompt_context.get("prompt", ""),
                            "response_a": prompt_context.get("response_a", ""),
                            "response_b": prompt_context.get("response_b", ""),
                            "ann_scores_a": ann_scores_a,
                            "ann_scores_b": ann_scores_b,
                            "annotator_likert": str(result.annotator_likert),
                            "golden_scores_a": golden_scores_a,
                            "golden_scores_b": golden_scores_b,
                            "golden_likert": str(result.golden_likert),
                            "mismatches": [
                                f"{s.dimension_id}: {s.annotator_value} vs {s.golden_value}"
                                for s in result.scores_a + result.scores_b
                                if not s.match
                            ],
                            "justification": justification,
                        }
                    )
                else:
                    empty_justifications += 1

        except Exception as e:
            print(f"\nWarning: Error evaluating row {task_id}: {e}")
            continue

    print(f"\n✓ M1 Evaluation Complete")
    print(f"  Evaluated: {len(results)}")
    print(f"  Skipped (no golden): {skipped}")
    if use_llm_judge:
        print(f"  With justification: {len(cases_for_llm)}")
        print(f"  Empty justification: {empty_justifications}")

    # =========================================================================
    # PASS 2: Batched LLM evaluation for M2 (and M3 if rubric provided)
    # =========================================================================
    if use_llm_judge and cases_for_llm:
        print(f"\n{'=' * 80}")
        if rubric:
            print(f"PASS 2: M2 + M3 Scoring (Batched LLM with Rubric)")
            print(f"{'=' * 80}")
        else:
            print(f"PASS 2: M2 Scoring (Batched LLM, No Rubric)")
            print(f"{'=' * 80}")

        num_batches = (len(cases_for_llm) + batch_size - 1) // batch_size
        print(f"  Cases with justification: {len(cases_for_llm)}")
        print(f"  Batches: {num_batches} ({batch_size} per batch)")
        print(f"  Estimated API calls: ~{num_batches}")

        if rubric:
            # Combined M2+M3 evaluation
            llm_results = judge_batch_combined(
                cases_for_llm,
                rubric=rubric,
                model_name=llm_model,
                batch_size=batch_size,
            )

            # Update results with M2 and M3
            for case, llm_result in zip(cases_for_llm, llm_results):
                idx = case["idx"]

                # M2 - Justification Coherence
                results[idx].justification_coherence = llm_result.get("m2", {})
                results[idx].justification_coherence_score = llm_result.get(
                    "m2", {}
                ).get("score", 0.5)

                # M3 - Rubric Compliance
                results[idx].rubric_compliance = llm_result.get("m3", {})
                results[idx].rubric_compliance_score = llm_result.get("m3", {}).get(
                    "score", 0.5
                )

                # Recalculate final score: 80% M1 + 20% M2
                results[idx].final_score = (
                    0.8 * results[idx].dimension_score
                    + 0.2 * results[idx].justification_coherence_score
                )

        else:
            # M2 only (no rubric)
            llm_results = judge_batch_m2_only(
                cases_for_llm,
                model_name=llm_model,
                batch_size=batch_size,
            )

            # Update results with M2 only
            for case, llm_result in zip(cases_for_llm, llm_results):
                idx = case["idx"]

                # M2 - Justification Coherence
                results[idx].justification_coherence = llm_result
                results[idx].justification_coherence_score = llm_result.get(
                    "score", 0.5
                )

                # M3 stays None (no rubric)
                # results[idx].rubric_compliance = None  # Already None
                # results[idx].rubric_compliance_score = None  # Already None

                # Recalculate final score: 80% M1 + 20% M2
                results[idx].final_score = (
                    0.8 * results[idx].dimension_score
                    + 0.2 * results[idx].justification_coherence_score
                )

        print(f"\n✓ LLM Evaluation Complete")

    elif use_llm_judge and not cases_for_llm:
        print(f"\n⚠ Skipping LLM evaluation: No non-empty justifications found")

    # Convert results to dicts
    results_dicts = [r.to_dict() for r in results]

    # =========================================================================
    # Save and Report
    # =========================================================================
    print(f"\n{'=' * 80}")
    print(f"SAVING RESULTS")
    print(f"{'=' * 80}")

    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    results_path = output_path / "evaluation_results.json"
    with open(results_path, "w", encoding="utf-8") as f:
        json.dump(results_dicts, f, indent=2)
    print(f"Results saved to: {results_path}")

    # Generate reports
    print("\nGenerating reports...")
    stats = compute_statistics(results_dicts)
    rankings = compute_annotator_rankings(results_dicts)
    dim_accuracy = compute_dimension_accuracy(results_dicts)

    # Summary report
    report = generate_summary_report(stats, rankings, dim_accuracy, str(output_path))
    print(report)

    # CSV reports
    save_results_to_csv(results_dicts, str(output_path))

    # Plots
    try:
        generate_plots(results_dicts, str(output_path))
        print("✓ Plots generated")
    except Exception as e:
        print(f"⚠ Warning: Could not generate plots: {e}")

    print(f"\n{'=' * 80}")
    print(f"BATCH EVALUATION COMPLETE")
    print(f"{'=' * 80}")
    print(f"All outputs saved to: {output_path}")
    print(f"\nMetrics calculated:")
    print(f"  • M1 (Dimension Scoring): ✓")
    if use_llm_judge and cases_for_llm:
        print(f"  • M2 (Justification Coherence): ✓")
        if rubric:
            print(f"  • M3 (Rubric Compliance): ✓")
        else:
            print(f"  • M3 (Rubric Compliance): ✗ (no rubric)")
    else:
        print(f"  • M2/M3: ✗ (disabled or no justifications)")


# =============================================================================
# MAIN
# =============================================================================


def main():
    parser = argparse.ArgumentParser(
        description="Batch Annotator Evaluation - Evaluate annotator judgements with batched LLM calls for efficiency."
    )

    # Required arguments
    parser.add_argument(
        "--annotator-csv",
        type=str,
        required=True,
        help="Path to annotator responses CSV.",
    )
    parser.add_argument(
        "--golden-csv",
        type=str,
        required=True,
        help="Path to golden labels CSV.",
    )
    parser.add_argument(
        "--mappings",
        type=str,
        required=True,
        help="Path to column mappings JSON file.",
    )

    # Optional arguments
    parser.add_argument(
        "--rubric",
        type=str,
        default=None,
        help="Optional path to rubric JSON file. If not provided, M3 is skipped.",
    )
    parser.add_argument(
        "-o",
        "--output-dir",
        type=str,
        default="./output/evaluation_results",
        help="Output directory for evaluation results.",
    )
    parser.add_argument(
        "-m",
        "--model",
        type=str,
        default="gemini-2.5-flash",
        help="LLM model to use for M2/M3 evaluation.",
    )
    parser.add_argument(
        "--use-llm",
        action="store_true",
        help="Use LLM-as-judge for M2/M3 evaluation. If not set, only M1 is calculated.",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=5,
        help="Number of cases per LLM batch call (5-10 recommended).",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Limit number of rows to process (for testing).",
    )

    args = parser.parse_args()

    # Print configuration
    print("\n" + "=" * 80)
    print("BATCH EVALUATION CONFIGURATION")
    print("=" * 80)
    print(f"Annotator CSV: {args.annotator_csv}")
    print(f"Golden CSV: {args.golden_csv}")
    print(f"Rubric: {args.rubric if args.rubric else 'None'}")
    print(f"Mappings: {args.mappings}")
    print(f"Output Dir: {args.output_dir}")
    print(f"Use LLM Judge: {args.use_llm}")
    print(f"LLM Model: {args.model}")
    print(f"Batch Size: {args.batch_size}")
    print(f"Row Limit: {args.limit if args.limit else 'None (all rows)'}")

    try:
        configure_api()

        run_batch_evaluation(
            annotator_csv_path=args.annotator_csv,
            golden_csv_path=args.golden_csv,
            rubric_path=args.rubric,
            mappings_path=args.mappings,
            output_dir=args.output_dir,
            use_llm_judge=args.use_llm,
            llm_model=args.model,
            batch_size=args.batch_size,
            limit=args.limit,
        )
    except FileNotFoundError as e:
        print(f"\nError: File not found - {e}")
        sys.exit(1)
    except Exception as e:
        print(f"\nAn unexpected error occurred: {e}")
        import traceback

        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()

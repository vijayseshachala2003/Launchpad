# main.py
"""
Annotator Evaluation Pipeline - Main Entry Point

Commands:
    generate  - Extract rubric and column mappings from instruction document
    evaluate  - Run evaluation on annotator data against golden labels
    report    - Generate statistics and visualizations from results
"""

import argparse
import csv
import json
import os
import pdb
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

from src.config import configure_api
from src.document_parser import read_document
from src.evaluator import EvaluationResult, evaluate_row
from src.generator import (
    generate_column_mappings,
    generate_rubric_from_document,
)
from src.reporter import (
    compute_annotator_rankings,
    compute_dimension_accuracy,
    compute_statistics,
    generate_plots,
    generate_summary_report,
    save_results_to_csv,
)

# ============ GENERATE COMMAND ============


def handle_generate(args):
    """
    Generate rubric and column mappings from instruction document and/or CSVs.
    - If instruction doc provided: extracts rubric, uses it for dimension naming
    - If only CSVs provided: generates mappings by inferring from headers
    """
    rubric = None
    base_name = None

    # Generate rubric from instruction doc (if provided)
    if args.instruction_doc:
        print(f"\nReading instruction document: {args.instruction_doc}")
        instruction_text = read_document(args.instruction_doc)
        print("Document read successfully.")

        rubric = generate_rubric_from_document(instruction_text, model_name=args.model)

        if rubric is None:
            print("\n--- RUBRIC GENERATION FAILED ---")
            print("Continuing with mappings generation without rubric...")
        else:
            base_name = Path(args.instruction_doc).stem
    else:
        print("\nNo instruction document provided. Skipping rubric generation.")

    # Generate column mappings if CSVs provided
    column_mappings = None
    if args.annotator_csv and args.golden_csv:
        print("\nDetecting column mappings from CSVs...")

        with open(args.annotator_csv, "r", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            annotator_headers = list(reader.fieldnames) if reader.fieldnames else []

        with open(args.golden_csv, "r", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            golden_headers = list(reader.fieldnames) if reader.fieldnames else []

        column_mappings = generate_column_mappings(
            annotator_headers=annotator_headers,
            golden_headers=golden_headers,
            rubric=rubric,
            model_name=args.model,
        )

        # Use golden CSV filename if no instruction doc
        if base_name is None:
            base_name = Path(args.golden_csv).stem
    else:
        print(
            "\nWarning: Both --annotator-csv and --golden-csv required for mappings generation."
        )

    # Determine output base name
    if base_name is None:
        base_name = "project"

    # Save artifacts
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    if rubric:
        rubric_path = output_dir / f"{base_name}_rubric.json"
        with open(rubric_path, "w", encoding="utf-8") as f:
            json.dump(rubric, f, indent=2)
        print(f"\nRubric saved to: {rubric_path}")

    if column_mappings:
        mappings_path = output_dir / f"{base_name}_mappings.json"
        with open(mappings_path, "w", encoding="utf-8") as f:
            json.dump(column_mappings, f, indent=2)
        print(f"Column mappings saved to: {mappings_path}")

    print("\n--- GENERATION COMPLETE ---")


# ============ EVALUATE COMMAND ============


def handle_evaluate(args):
    """
    Run evaluation on annotator data against golden labels.
    """
    print("\n--- Starting Annotator Evaluation ---")

    # Load rubric (optional)
    rubric = None
    if args.rubric:
        print(f"Loading rubric from: {args.rubric}")
        with open(args.rubric, "r", encoding="utf-8") as f:
            rubric = json.load(f)
    else:
        print("No rubric provided. Proceeding with P0 scoring only.")

    # Load column mappings
    print(f"Loading column mappings from: {args.mappings}")
    with open(args.mappings, "r", encoding="utf-8") as f:
        column_mappings = json.load(f)

    # # Load prompts CSV (CSV1) for context
    # print(f"Loading prompts/responses from: {args.prompts_csv}")
    # with open(args.prompts_csv, "r", encoding="utf-8") as f:
    #     reader = csv.DictReader(f)
    #     prompts_rows = list(reader)

    # # Create prompts lookup by uniqueId or subtask_id
    # prompts_id_col = column_mappings.get("identifiers", {}).get("prompt_id", "uniqueId")
    # prompt_col = column_mappings.get("prompt_columns", {}).get("prompt", "Prompt")
    # response_a_col = column_mappings.get("prompt_columns", {}).get(
    #     "response_a", "ResponseA"
    # )
    # response_b_col = column_mappings.get("prompt_columns", {}).get(
    #     "response_b", "ResponseB"
    # )

    # prompts_lookup = {}
    # for row in prompts_rows:
    #     task_id = (
    #         row.get(prompts_id_col) or row.get("uniqueId") or row.get("subtask_id")
    #     )
    #     if task_id:
    #         prompts_lookup[str(task_id)] = {
    #             "prompt": row.get(prompt_col, row.get("Prompt", "")),
    #             "response_a": row.get(response_a_col, row.get("ResponseA", "")),
    #             "response_b": row.get(response_b_col, row.get("ResponseB", "")),
    #         }

    # print(f"Loaded {len(prompts_lookup)} prompt contexts")

    # Load annotator CSV
    print(f"Loading annotator data from: {args.annotator_csv}")
    with open(args.annotator_csv, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        annotator_rows = list(reader)

    # Load golden CSV
    print(f"Loading golden labels from: {args.golden_csv}")
    with open(args.golden_csv, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        golden_rows = list(reader)

    # Apply limit before processing
    if args.limit:
        annotator_rows = annotator_rows[: args.limit]
        print(f"Limited to {args.limit} rows")

    # Get column name configurations
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

    # Merge and evaluate
    results = []
    skipped = 0

    try:
        from tqdm import tqdm

        iterator = tqdm(annotator_rows, desc="Evaluating")
    except ImportError:
        iterator = annotator_rows
        print("Processing annotations...")

    for ann_row in iterator:
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

        # Evaluate
        try:
            result = evaluate_row(
                merged,
                column_mappings,
                rubric=rubric,
                use_llm_judge=args.use_llm,
                llm_model=args.model,
                prompt_context=prompt_context,
            )
            results.append(result.to_dict())
        except Exception as e:
            print(f"Warning: Error evaluating row {task_id}: {e}")
            continue

    print(
        f"\nEvaluated {len(results)} annotations (skipped {skipped} without golden labels)"
    )

    # Save results
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    results_path = output_dir / "evaluation_results.json"
    with open(results_path, "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2)
    print(f"\nResults saved to: {results_path}")

    # Generate basic stats
    stats = compute_statistics(results)
    print(f"\n--- EVALUATION SUMMARY ---")
    print(f"Total: {stats.get('total_annotations', 0)}")
    print(
        f"Flagged: {stats.get('flagged_count', 0)} ({stats.get('flag_rate', 0) * 100:.1f}%)"
    )
    print(f"Avg Final Score: {stats.get('final_score', {}).get('mean', 0):.3f}")
    print(f"Likert Match Rate: {stats.get('likert_match_rate', 0) * 100:.1f}%")

    print("\n--- EVALUATION COMPLETE ---")


# ============ REPORT COMMAND ============


def handle_report(args):
    """
    Generate statistics and visualizations from evaluation results.
    """
    print("\n--- Generating Reports ---")

    print(f"Loading results from: {args.results}")
    with open(args.results, "r", encoding="utf-8") as f:
        results = json.load(f)

    print(f"Loaded {len(results)} evaluation results")

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Compute statistics
    stats = compute_statistics(results)
    rankings = compute_annotator_rankings(results)
    dim_accuracy = compute_dimension_accuracy(results)

    # Generate summary report
    print("\nGenerating summary report...")
    report_text = generate_summary_report(
        stats, rankings, dim_accuracy, str(output_dir)
    )
    print(report_text)

    # Save CSVs
    print("\nSaving CSV reports...")
    save_results_to_csv(results, str(output_dir))

    # Generate plots
    if not args.no_plots:
        print("\nGenerating plots...")
        generate_plots(results, str(output_dir))

    print(f"\n--- REPORTS SAVED TO: {output_dir} ---")


# ============ MAIN ============


def main():
    parser = argparse.ArgumentParser(
        description="Annotator Evaluation Pipeline - Evaluate annotator judgements against golden labels."
    )
    parser.add_argument(
        "-o",
        "--output-dir",
        type=str,
        default="./output",
        help="Output directory for generated files.",
    )
    parser.add_argument(
        "-m",
        "--model",
        type=str,
        default="gemini-2.5-flash",
        help="LLM model to use for generation/evaluation.",
    )

    subparsers = parser.add_subparsers(
        dest="command", required=True, help="Available commands"
    )

    # --- GENERATE command ---
    parser_gen = subparsers.add_parser(
        "generate",
        help="Generate rubric and column mappings from instruction document and/or CSVs.",
    )
    parser_gen.add_argument(
        "--instruction_doc",
        type=str,
        default=None,
        help="Optional path to instruction document (.pdf, .docx, or .txt). If provided, rubric is extracted and used for dimension naming.",
    )
    parser_gen.add_argument(
        "--annotator-csv",
        type=str,
        required=True,
        help="Path to annotator CSV (for auto-detecting column mappings).",
    )
    parser_gen.add_argument(
        "--golden-csv",
        type=str,
        required=True,
        help="Path to golden labels CSV (for auto-detecting column mappings).",
    )
    parser_gen.set_defaults(func=handle_generate)

    # --- EVALUATE command ---
    parser_eval = subparsers.add_parser(
        "evaluate", help="Run evaluation on annotator data against golden labels."
    )
    parser_eval.add_argument(
        "--rubric",
        type=str,
        default=None,
        help="Optional path to rubric JSON file. If not provided, P0 scoring only.",
    )
    parser_eval.add_argument(
        "--mappings",
        type=str,
        required=True,
        help="Path to column mappings JSON file.",
    )
    parser_eval.add_argument(
        "--annotator-csv",
        type=str,
        required=True,
        help="Path to annotator responses CSV.",
    )
    parser_eval.add_argument(
        "--golden-csv",
        type=str,
        required=True,
        help="Path to golden labels CSV.",
    )
    parser_eval.add_argument(
        "--use-llm",
        action="store_true",
        help="Use LLM-as-judge for justification evaluation.",
    )
    parser_eval.add_argument(
        "--limit",
        type=int,
        help="Limit number of rows to process.",
    )
    parser_eval.set_defaults(func=handle_evaluate)

    # --- REPORT command ---
    parser_report = subparsers.add_parser(
        "report", help="Generate statistics and visualizations from results."
    )
    parser_report.add_argument(
        "--results",
        type=str,
        required=True,
        help="Path to evaluation_results.json file.",
    )
    parser_report.add_argument(
        "--no-plots",
        action="store_true",
        help="Skip plot generation.",
    )
    parser_report.set_defaults(func=handle_report)

    args = parser.parse_args()

    try:
        configure_api()
        args.func(args)
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

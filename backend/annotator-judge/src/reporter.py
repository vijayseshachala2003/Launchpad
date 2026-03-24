# src/reporter.py
"""
Statistics and visualization for annotator evaluation results.
Handles optional M2/M3 fields gracefully.
"""

import os
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional


def _safe_get_score(result: Dict, *keys, default=None):
    """Safely get nested score, returning default if None or missing."""
    value = result
    for key in keys:
        if value is None:
            return default
        value = value.get(key)
    return value if value is not None else default


def compute_statistics(results: List[Dict]) -> Dict:
    """Compute basic statistics from evaluation results."""
    if not results:
        return {}

    import statistics

    def _stats(arr):
        # Filter out None values
        arr = [x for x in arr if x is not None]
        if not arr:
            return {"mean": 0, "std": 0, "min": 0, "max": 0, "median": 0, "count": 0}
        return {
            "mean": statistics.mean(arr),
            "std": statistics.stdev(arr) if len(arr) > 1 else 0,
            "min": min(arr),
            "max": max(arr),
            "median": statistics.median(arr),
            "count": len(arr),
        }

    final_scores = [r.get("final_score") for r in results]
    m1_scores = [r.get("dimension_score") for r in results]

    # M2: May be None if no LLM or no justification
    m2_scores = [
        r.get("justification_coherence_score") or r.get("justification_score")
        for r in results
    ]

    # M3: May be None if no rubric or no LLM
    m3_scores = [r.get("rubric_compliance_score") for r in results]

    flagged = [r.get("flagged", False) for r in results]
    likert_match = [r.get("likert_match", False) for r in results]

    stats = {
        "total_annotations": len(results),
        "unique_annotators": len(set(r.get("annotator_id", "") for r in results)),
        "unique_tasks": len(set(str(r.get("subtask_id", "")) for r in results)),
        "final_score": _stats(final_scores),
        "m1_dimension_score": _stats(m1_scores),
        "m2_coherence_score": _stats(m2_scores),
        "flagged_count": sum(1 for f in flagged if f),
        "flag_rate": sum(1 for f in flagged if f) / len(flagged) if flagged else 0,
        "likert_match_rate": sum(1 for m in likert_match if m) / len(likert_match)
        if likert_match
        else 0,
        # Backward compatibility
        "dimension_score": _stats(m1_scores),
        "justification_score": _stats(m2_scores),
    }

    # M3 only if any results have it
    m3_valid = [s for s in m3_scores if s is not None]
    if m3_valid:
        stats["m3_compliance_score"] = _stats(m3_valid)

    return stats


def compute_annotator_rankings(results: List[Dict]) -> List[Dict]:
    """Rank annotators by performance."""
    import statistics
    from collections import defaultdict

    by_annotator = defaultdict(list)
    for r in results:
        key = (r.get("annotator_id", ""), r.get("annotator_name", ""))
        by_annotator[key].append(r)

    rankings = []
    for (ann_id, ann_name), ann_results in by_annotator.items():
        final_scores = [
            r.get("final_score")
            for r in ann_results
            if r.get("final_score") is not None
        ]
        m1_scores = [
            r.get("dimension_score")
            for r in ann_results
            if r.get("dimension_score") is not None
        ]
        m2_scores = [
            r.get("justification_coherence_score") or r.get("justification_score")
            for r in ann_results
            if (r.get("justification_coherence_score") or r.get("justification_score"))
            is not None
        ]
        m3_scores = [
            r.get("rubric_compliance_score")
            for r in ann_results
            if r.get("rubric_compliance_score") is not None
        ]
        flags = [r.get("flagged", False) for r in ann_results]
        likert = [r.get("likert_match", False) for r in ann_results]

        ranking = {
            "annotator_id": ann_id,
            "annotator_name": ann_name,
            "num_annotations": len(ann_results),
            "avg_final_score": statistics.mean(final_scores) if final_scores else None,
            "std_final_score": statistics.stdev(final_scores)
            if len(final_scores) > 1
            else 0,
            "avg_m1_score": statistics.mean(m1_scores) if m1_scores else None,
            "avg_m2_score": statistics.mean(m2_scores) if m2_scores else None,
            "num_flagged": sum(1 for f in flags if f),
            "flag_rate": sum(1 for f in flags if f) / len(flags) if flags else 0,
            "likert_accuracy": sum(1 for m in likert if m) / len(likert)
            if likert
            else 0,
            # Backward compatibility
            "avg_dimension_score": statistics.mean(m1_scores) if m1_scores else None,
        }

        # M3 only if available
        if m3_scores:
            ranking["avg_m3_score"] = statistics.mean(m3_scores)

        rankings.append(ranking)

    # Sort by final score (None values go to end)
    return sorted(rankings, key=lambda x: x.get("avg_final_score") or 0, reverse=True)


def compute_dimension_accuracy(results: List[Dict]) -> List[Dict]:
    """Compute accuracy per dimension."""
    from collections import defaultdict

    dim_stats = defaultdict(lambda: {"match": 0, "total": 0, "penalty_sum": 0})

    for r in results:
        for score in r.get("scores_a", []):
            key = (score["dimension_id"], "A")
            dim_stats[key]["total"] += 1
            dim_stats[key]["match"] += 1 if score.get("match") else 0
            dim_stats[key]["penalty_sum"] += score.get("penalty", 0)

        for score in r.get("scores_b", []):
            key = (score["dimension_id"], "B")
            dim_stats[key]["total"] += 1
            dim_stats[key]["match"] += 1 if score.get("match") else 0
            dim_stats[key]["penalty_sum"] += score.get("penalty", 0)

    accuracy_list = []
    for (dim_id, response), stats in dim_stats.items():
        if stats["total"] > 0:
            accuracy_list.append(
                {
                    "dimension": dim_id,
                    "response": response,
                    "accuracy": stats["match"] / stats["total"],
                    "avg_penalty": stats["penalty_sum"] / stats["total"],
                    "total_count": stats["total"],
                }
            )

    return sorted(accuracy_list, key=lambda x: x["accuracy"])


def generate_summary_report(
    stats: Dict, rankings: List[Dict], dim_accuracy: List[Dict], output_dir: str
) -> str:
    """Generate text summary report."""

    def _fmt(val, fmt=".4f"):
        return f"{val:{fmt}}" if val is not None else "N/A"

    lines = [
        "=" * 70,
        "ANNOTATOR EVALUATION SUMMARY REPORT",
        f"Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        "=" * 70,
        "",
        "## OVERVIEW",
        f"Total Annotations: {stats.get('total_annotations', 0)}",
        f"Unique Annotators: {stats.get('unique_annotators', 0)}",
        f"Unique Tasks: {stats.get('unique_tasks', 0)}",
        "",
        "## SCORE STATISTICS",
        "",
        "### Final Score (80% M1 + 20% M2)",
    ]

    fs = stats.get("final_score", {})
    lines.extend(
        [
            f"  Mean:   {_fmt(fs.get('mean'))}",
            f"  Std:    {_fmt(fs.get('std'))}",
            f"  Median: {_fmt(fs.get('median'))}",
            f"  Min:    {_fmt(fs.get('min'))}",
            f"  Max:    {_fmt(fs.get('max'))}",
            "",
        ]
    )

    # M1
    lines.append("### M1: Dimension Score (Golden Alignment)")
    m1 = stats.get("m1_dimension_score", stats.get("dimension_score", {}))
    lines.extend(
        [
            f"  Mean: {_fmt(m1.get('mean'))}  |  Count: {m1.get('count', 'N/A')}",
            "",
        ]
    )

    # M2
    lines.append("### M2: Justification Coherence (Internal Consistency)")
    m2 = stats.get("m2_coherence_score", stats.get("justification_score", {}))
    m2_count = m2.get("count", 0)
    if m2_count > 0:
        lines.append(f"  Mean: {_fmt(m2.get('mean'))}  |  Count: {m2_count}")
    else:
        lines.append("  Not evaluated (no LLM or no justifications)")
    lines.append("")

    # M3 (only if present)
    if "m3_compliance_score" in stats:
        lines.append("### M3: Rubric Compliance (External Validity)")
        m3 = stats.get("m3_compliance_score", {})
        lines.extend(
            [
                f"  Mean: {_fmt(m3.get('mean'))}  |  Count: {m3.get('count', 'N/A')}",
                "",
            ]
        )

    lines.extend(
        [
            "## QUALITY FLAGS",
            f"Flagged Annotations: {stats.get('flagged_count', 0)} ({stats.get('flag_rate', 0) * 100:.1f}%)",
            "",
            "## LIKERT ACCURACY",
            f"Exact Match Rate: {stats.get('likert_match_rate', 0) * 100:.1f}%",
            "",
            "## TOP ANNOTATORS",
            "-" * 70,
        ]
    )

    for r in rankings[:10]:
        m1_str = f"M1:{_fmt(r.get('avg_m1_score'), '.2f')}"
        m2_str = (
            f"M2:{_fmt(r.get('avg_m2_score'), '.2f')}"
            if r.get("avg_m2_score") is not None
            else ""
        )
        m3_str = (
            f"M3:{_fmt(r.get('avg_m3_score'), '.2f')}"
            if r.get("avg_m3_score") is not None
            else ""
        )

        score_parts = [s for s in [m1_str, m2_str, m3_str] if s]

        lines.append(
            f"  {r['annotator_name'][:20]:<20} | "
            f"Final:{_fmt(r.get('avg_final_score'), '.2f')} | "
            f"{' | '.join(score_parts)} | "
            f"N={r['num_annotations']}"
        )

    lines.extend(["", "## DIMENSION ACCURACY (M1 Breakdown)", "-" * 70])

    from collections import defaultdict

    dim_grouped = defaultdict(list)
    for d in dim_accuracy:
        dim_grouped[d["dimension"]].append(d)

    for dim, items in sorted(dim_grouped.items()):
        avg_acc = sum(i["accuracy"] for i in items) / len(items)
        status = "✓" if avg_acc > 0.7 else "⚠" if avg_acc > 0.5 else "✗"
        lines.append(f"  {status} {dim:<35}: {avg_acc * 100:.1f}%")

    lines.extend(["", "=" * 70, "END OF REPORT", "=" * 70])

    report_text = "\n".join(lines)

    os.makedirs(output_dir, exist_ok=True)
    with open(f"{output_dir}/summary_report.txt", "w", encoding="utf-8") as f:
        f.write(report_text)

    return report_text


def save_results_to_csv(results: List[Dict], output_dir: str):
    """Save results to CSV files with optional M2/M3 handling."""
    import csv

    os.makedirs(output_dir, exist_ok=True)

    if not results:
        return

    # Check which fields are available
    has_m2 = any(r.get("justification_coherence") is not None for r in results)
    has_m3 = any(r.get("rubric_compliance") is not None for r in results)

    flat_results = []
    for r in results:
        flat = {
            "subtask_id": r.get("subtask_id"),
            "annotator_id": r.get("annotator_id"),
            "annotator_name": r.get("annotator_name"),
            "final_score": r.get("final_score"),
            "m1_dimension_score": r.get("dimension_score"),
        }

        # M2 fields (if available)
        if has_m2:
            flat["m2_coherence_score"] = r.get(
                "justification_coherence_score"
            ) or r.get("justification_score")
            m2_data = r.get("justification_coherence") or {}
            flat["m2_claim_verification"] = m2_data.get("claim_verification")
            flat["m2_rating_alignment"] = m2_data.get("rating_alignment")
            flat["m2_likert_consistency"] = m2_data.get("likert_consistency")

        # M3 fields (if available)
        if has_m3:
            flat["m3_compliance_score"] = r.get("rubric_compliance_score")
            m3_data = r.get("rubric_compliance") or {}
            flat["m3_overall_compliance"] = m3_data.get("overall_compliance")
            flat["m3_defensible_disagreements"] = "; ".join(
                m3_data.get("defensible_disagreements", [])
            )
            flat["m3_clear_errors"] = "; ".join(m3_data.get("clear_errors", []))

        # Common fields
        flat.update(
            {
                "likert_match": r.get("likert_match"),
                "likert_penalty": r.get("likert_penalty"),
                "annotator_likert": r.get("annotator_likert"),
                "golden_likert": r.get("golden_likert"),
                "flagged": r.get("flagged"),
                "flag_reasons": "; ".join(r.get("flag_reasons", [])),
            }
        )

        # Dimension scores
        for s in r.get("scores_a", []):
            flat[f"{s['dimension_id']}_a_match"] = s.get("match")
            flat[f"{s['dimension_id']}_a_penalty"] = s.get("penalty")
        for s in r.get("scores_b", []):
            flat[f"{s['dimension_id']}_b_match"] = s.get("match")
            flat[f"{s['dimension_id']}_b_penalty"] = s.get("penalty")

        flat_results.append(flat)

    if flat_results:
        # Get all keys
        all_keys = set()
        for fr in flat_results:
            all_keys.update(fr.keys())

        # Order keys logically
        base_keys = [
            "subtask_id",
            "annotator_id",
            "annotator_name",
            "final_score",
            "m1_dimension_score",
        ]
        if has_m2:
            base_keys.extend(
                [
                    "m2_coherence_score",
                    "m2_claim_verification",
                    "m2_rating_alignment",
                    "m2_likert_consistency",
                ]
            )
        if has_m3:
            base_keys.extend(
                [
                    "m3_compliance_score",
                    "m3_overall_compliance",
                    "m3_defensible_disagreements",
                    "m3_clear_errors",
                ]
            )
        base_keys.extend(
            [
                "likert_match",
                "likert_penalty",
                "annotator_likert",
                "golden_likert",
                "flagged",
                "flag_reasons",
            ]
        )

        dim_keys = sorted([k for k in all_keys if k not in base_keys])
        ordered_keys = base_keys + dim_keys

        with open(
            f"{output_dir}/full_results.csv", "w", newline="", encoding="utf-8"
        ) as f:
            writer = csv.DictWriter(f, fieldnames=ordered_keys, extrasaction="ignore")
            writer.writeheader()
            writer.writerows(flat_results)

        flagged_results = [r for r in flat_results if r.get("flagged")]
        if flagged_results:
            with open(
                f"{output_dir}/flagged.csv", "w", newline="", encoding="utf-8"
            ) as f:
                writer = csv.DictWriter(
                    f, fieldnames=ordered_keys, extrasaction="ignore"
                )
                writer.writeheader()
                writer.writerows(flagged_results)

    # Annotator rankings
    rankings = compute_annotator_rankings(results)
    if rankings:
        with open(
            f"{output_dir}/annotator_rankings.csv", "w", newline="", encoding="utf-8"
        ) as f:
            writer = csv.DictWriter(f, fieldnames=rankings[0].keys())
            writer.writeheader()
            writer.writerows(rankings)

    print(f"CSV results saved to {output_dir}/")


def generate_plots(results: List[Dict], output_dir: str):
    """Generate visualization plots with optional M2/M3 handling."""
    try:
        import matplotlib
        import matplotlib.pyplot as plt

        matplotlib.use("Agg")
    except ImportError:
        print("Warning: matplotlib not installed. Skipping plot generation.")
        return

    os.makedirs(output_dir, exist_ok=True)

    # Collect scores (filter None)
    final_scores = [
        r["final_score"] for r in results if r.get("final_score") is not None
    ]
    m1_scores = [
        r["dimension_score"] for r in results if r.get("dimension_score") is not None
    ]
    m2_scores = [
        r.get("justification_coherence_score") or r.get("justification_score")
        for r in results
        if (r.get("justification_coherence_score") or r.get("justification_score"))
        is not None
    ]
    m3_scores = [
        r["rubric_compliance_score"]
        for r in results
        if r.get("rubric_compliance_score") is not None
    ]

    # Determine layout
    num_plots = 2  # Final + M1 always
    if m2_scores:
        num_plots += 1
    if m3_scores:
        num_plots += 1

    fig, axes = plt.subplots(1, num_plots, figsize=(5 * num_plots, 5))
    if num_plots == 1:
        axes = [axes]

    plot_idx = 0

    # Final Score
    if final_scores:
        axes[plot_idx].hist(
            final_scores, bins=20, edgecolor="black", alpha=0.7, color="blue"
        )
        axes[plot_idx].set_xlabel("Final Score")
        axes[plot_idx].set_ylabel("Count")
        axes[plot_idx].set_title(f"Final Score (n={len(final_scores)})")
        axes[plot_idx].axvline(
            x=sum(final_scores) / len(final_scores),
            color="red",
            linestyle="--",
            label="Mean",
        )
        axes[plot_idx].legend()
        plot_idx += 1

    # M1
    if m1_scores:
        axes[plot_idx].hist(
            m1_scores, bins=20, edgecolor="black", alpha=0.7, color="green"
        )
        axes[plot_idx].set_xlabel("M1: Dimension Score")
        axes[plot_idx].set_ylabel("Count")
        axes[plot_idx].set_title(f"M1: Golden Alignment (n={len(m1_scores)})")
        axes[plot_idx].axvline(
            x=sum(m1_scores) / len(m1_scores), color="red", linestyle="--", label="Mean"
        )
        axes[plot_idx].legend()
        plot_idx += 1

    # M2
    if m2_scores:
        axes[plot_idx].hist(
            m2_scores, bins=20, edgecolor="black", alpha=0.7, color="orange"
        )
        axes[plot_idx].set_xlabel("M2: Coherence Score")
        axes[plot_idx].set_ylabel("Count")
        axes[plot_idx].set_title(f"M2: Justification Coherence (n={len(m2_scores)})")
        axes[plot_idx].axvline(
            x=sum(m2_scores) / len(m2_scores), color="red", linestyle="--", label="Mean"
        )
        axes[plot_idx].legend()
        plot_idx += 1

    # M3
    if m3_scores:
        axes[plot_idx].hist(
            m3_scores, bins=20, edgecolor="black", alpha=0.7, color="purple"
        )
        axes[plot_idx].set_xlabel("M3: Compliance Score")
        axes[plot_idx].set_ylabel("Count")
        axes[plot_idx].set_title(f"M3: Rubric Compliance (n={len(m3_scores)})")
        axes[plot_idx].axvline(
            x=sum(m3_scores) / len(m3_scores), color="red", linestyle="--", label="Mean"
        )
        axes[plot_idx].legend()

    plt.tight_layout()
    plt.savefig(f"{output_dir}/score_distributions.png", dpi=150, bbox_inches="tight")
    plt.close()

    # Dimension accuracy heatmap
    dim_accuracy = compute_dimension_accuracy(results)
    if dim_accuracy:
        try:
            import pandas as pd
            import seaborn as sns

            df = pd.DataFrame(dim_accuracy)
            pivot = df.pivot(index="dimension", columns="response", values="accuracy")

            fig, ax = plt.subplots(figsize=(8, max(6, len(pivot) * 0.5)))
            sns.heatmap(
                pivot, annot=True, fmt=".2%", cmap="RdYlGn", ax=ax, vmin=0, vmax=1
            )
            ax.set_title("M1: Dimension-wise Accuracy")
            plt.tight_layout()
            plt.savefig(
                f"{output_dir}/dimension_accuracy_heatmap.png",
                dpi=150,
                bbox_inches="tight",
            )
            plt.close()
        except Exception as e:
            print(f"Warning: Could not generate heatmap: {e}")

    print(f"Plots saved to {output_dir}/")

# 🎯 Annotator Evaluation Pipeline

A generic pipeline for evaluating annotator judgements against golden labels using **M1/M2/M3 scoring methodology**. Dynamically extracts evaluation dimensions from instruction documents and performs multi-level quality assessment.

> **Inside Launchpad-eval:** The monorepo layout (`frontend/`, `server/`, `backend/`) is in the **[repo root README.md](../../README.md)**. This subfolder is **`backend/annotator-judge/`** — a **Python CLI** toolkit separate from Launchpad’s Node `server/` and the Section 2/3 judges in `backend/scripts/`.

---

## ✨ Key Features

- **📜 Dynamic Rubric Extraction** — Automatically extracts evaluation dimensions from instruction documents (`.pdf`, `.docx`, `.txt`)
- **🔗 Auto Column Mapping** — Uses LLM to intelligently map CSV column headers to rubric dimensions
- **📊 Three-Level Evaluation System**:
  - **M1**: Rule-based dimension scoring (golden label alignment)
  - **M2**: LLM-based justification coherence (internal consistency)
  - **M3**: LLM-based rubric compliance (external validity)
- **⚡ Batch Processing** — Efficient batched LLM calls (5-10x faster)
- **📈 Comprehensive Reporting** — Statistics, rankings, CSVs, and visualizations
- **🔌 Model Flexibility** — Supports Google Gemini and Together AI models

---

## Where things live (compartments)

This folder is a **standalone Python CLI app** (not the Launchpad `server/` pipeline). Files group as follows:

| Compartment | What it is |
|-------------|------------|
| **CLI entrypoints** | Top-level `.py` you run from a terminal (`main.py`, `batch_evaluate.py`, helpers). |
| **`src/` package** | Importable modules: config, prompts, rubric generation, evaluation, reporting, document parsing. |
| **Configuration** | `.env` in this directory (API keys — create locally; do not commit). |
| **Dependencies** | `requirements.txt` + optional local `.venv`. |
| **Inputs / outputs** | You create `data/` and `output/` (or any paths you pass on the CLI); not shipped in repo. |
| **Reference / misc** | Terms doc, scratch scripts — optional for operators. |

### File map by program area

#### CLI entrypoints (run these)

| Path | Purpose |
|------|---------|
| `main.py` | Primary CLI: `generate`, `evaluate`, `report` subcommands. |
| `batch_evaluate.py` | Faster batched M1/M2/M3 evaluation for production-sized CSVs. |
| `debug_columns.py` | Utility to inspect CSV columns (debugging mappings). |
| `scratch.py` | Ad-hoc experiments (not part of the documented workflow). |

#### Core library — `src/`

| Path | Purpose |
|------|---------|
| `src/config.py` | API keys, model selection (Gemini / Together), `configure_api()`. |
| `src/document_parser.py` | Load instruction text from `.pdf`, `.docx`, `.txt`. |
| `src/prompts.py` | LLM prompt strings for rubric extraction, mapping, M2/M3. |
| `src/generator.py` | Generate rubric JSON from document + column mappings from CSV headers. |
| `src/evaluator.py` | M1/M2/M3 scoring logic per row / batch. |
| `src/reporter.py` | Summaries, CSV exports, plots, rankings after evaluation. |

#### Project metadata & tooling

| Path | Purpose |
|------|---------|
| `requirements.txt` | Pip dependencies for this project. |
| `.gitignore` | Ignores `.env`, `__pycache__`, venvs, etc. |
| `LLM_Judge_Terms.docx` | Reference glossary / terms (human-readable). |

#### Conventional directories (create as needed)

| Path | Purpose |
|------|---------|
| `data/` | Put annotator CSV, golden CSV, instruction PDFs here (example paths in commands below). |
| `output/` | Default destination for `*_rubric.json`, `*_mappings.json`, `evaluation_results.json`, reports, plots. |

---

## 📁 Required Input Files

| File | Description | Required |
|------|-------------|----------|
| **Annotator CSV** | Annotator responses: dimension ratings, Likert ratings, justifications | ✅ Yes |
| **Golden CSV** | Golden labels + original prompts + ResponseA + ResponseB | ✅ Yes |
| **Instruction Doc** | PDF/DOCX with evaluation rubric (for rubric extraction) | ⚠️ Optional |

> **Key Point**: The Golden CSV must contain the original prompt and both LLM responses. This enables proper entailment checking for M2/M3 evaluation.

---

## 🏗️ Project structure (tree)

Paths below are relative to this folder: **`backend/annotator-judge/`** at the repo root.

```
.
├── main.py                 # CLI: generate | evaluate | report
├── batch_evaluate.py       # Batched evaluation
├── debug_columns.py        # CSV column debugging
├── scratch.py              # Optional scratch
├── requirements.txt
├── .env                    # Create locally (API keys)
├── LLM_Judge_Terms.docx    # Reference doc
├── src/
│   ├── config.py
│   ├── document_parser.py
│   ├── prompts.py
│   ├── generator.py
│   ├── evaluator.py
│   └── reporter.py
├── data/                   # Optional: your input CSVs / PDFs
└── output/                 # Optional: rubric, mappings, results, plots
```

> **Note:** There is no `src/__init__.py` in the current tree; imports use `from src.module import ...` when `PYTHONPATH` includes this directory or you run from the project root (as in the commands below).

---

## ⚙️ Setup & Installation

### Prerequisites
- Python **3.10+** (check: `python --version`)
- Google Gemini API key ([Get one here](https://aistudio.google.com/app/apikey))
- Or Together AI key ([Sign up here](https://www.together.ai/))

### Installation Steps

```bash
# 1. Create virtual environment
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate

# 2. Install dependencies
pip install -r requirements.txt

# 3. Configure API keys
cat > .env << EOF
GOOGLE_API_KEY="your_google_api_key_here"
# TOGETHER_API_KEY="your_together_key"  # Alternative
EOF

# 4. Verify setup
python -c "from src.config import configure_api; configure_api(); print('✓ Setup complete')"
```

**Core Dependencies:** `google-generativeai`, `python-dotenv`, `pandas`, `tqdm`, `matplotlib`, `seaborn`

---

## 🚀 Usage Workflows

### Workflow 1: Generate Rubric & Mappings

Extract evaluation dimensions from an instruction document and auto-map CSV columns.

```bash
python main.py generate \
    --instruction_doc "path/to/instructions.pdf" \
    --annotator-csv "data/annotator_responses.csv" \
    --golden-csv "data/golden_labels.csv" \
    -o output
```

**Outputs:**
- `output/instructions_rubric.json` — Extracted evaluation rubric
- `output/instructions_mappings.json` — Column mappings

**Notes:**
- If no instruction doc, mappings are still generated by inferring from CSV headers
- Rubric enables M3 evaluation; without it, only M1+M2 are available

---

### Workflow 2: Run Evaluation (main.py)

Evaluate annotator submissions using generated artifacts.

**M1 Only (No LLM):**
```bash
python main.py evaluate \
    --mappings "output/instructions_mappings.json" \
    --annotator-csv "data/annotator_responses.csv" \
    --golden-csv "data/golden_labels.csv" \
    -o output/results
```

**M1 + M2 (No Rubric):**
```bash
python main.py evaluate \
    --mappings "output/instructions_mappings.json" \
    --annotator-csv "data/annotator_responses.csv" \
    --golden-csv "data/golden_labels.csv" \
    --use-llm \
    -o output/results
```

**M1 + M2 + M3 (Full Evaluation):**
```bash
python main.py evaluate \
    --rubric "output/instructions_rubric.json" \
    --mappings "output/instructions_mappings.json" \
    --annotator-csv "data/annotator_responses.csv" \
    --golden-csv "data/golden_labels.csv" \
    --use-llm \
    -o output/results
```

**Options:**
- `--use-llm` — Enable M2/M3 evaluation
- `--limit N` — Process only first N rows (for testing)
- `-m MODEL` — LLM model (default: `gemini-2.5-flash`)

---

### Workflow 3: Batch Evaluation (Faster)

For production workloads, use `batch_evaluate.py` with batched LLM calls.

**M1 Only:**
```bash
python batch_evaluate.py \
    --annotator-csv "data/annotator_responses.csv" \
    --golden-csv "data/golden_labels.csv" \
    --mappings "output/instructions_mappings.json" \
    -o output/batch_results
```

**M1 + M2 + M3 (Batched):**
```bash
python batch_evaluate.py \
    --annotator-csv "data/annotator_responses.csv" \
    --golden-csv "data/golden_labels.csv" \
    --mappings "output/instructions_mappings.json" \
    --rubric "output/instructions_rubric.json" \
    --use-llm \
    --batch-size 5 \
    -o output/batch_results
```

**Batch Options:**
- `--batch-size N` — Cases per LLM call (default: 5, recommended: 5-10)
- `--limit N` — Limit rows for testing
- `-m MODEL` — LLM model name

**Performance:**
- Batch size 5: ~5x faster than individual calls
- Batch size 10: ~10x faster (may hit token limits on long justifications)

---

### Workflow 4: Generate Reports

Create detailed reports and visualizations from evaluation results.

```bash
python main.py report \
    --results "output/results/evaluation_results.json" \
    -o output/reports
```

**Outputs:**
- `summary_report.txt` — Human-readable summary
- `full_results.csv` — Complete per-annotation results
- `flagged.csv` — Annotations flagged for review
- `annotator_rankings.csv` — Annotator performance rankings
- `score_distributions.png` — Score histograms (M1/M2/M3)
- `dimension_accuracy_heatmap.png` — Per-dimension accuracy

---

## 📊 Evaluation Metrics Explained

### M1: Dimension Score (Rule-Based)

**What it measures:** Agreement with golden labels on dimension ratings

**How it works:**
- P0 (Objective): Binary penalty — 0 if match, 1 if mismatch
- P1 (Subjective): Variable penalty based on severity difference

**Penalty Matrix (P1 Example):**

| Golden Label | Annotator: No Issues | Minor Issues | Major Issues | N/A |
|--------------|---------------------|--------------|--------------|-----|
| No Issues | 0.0 | 0.4 | 0.6 | 0.4 |
| Minor Issues | 0.4 | 0.0 | 0.4 | 0.6 |
| Major Issues | 0.6 | 0.4 | 0.0 | 0.8 |
| N/A | 0.4 | 0.6 | 0.8 | 0.0 |

**Formula:**
```
M1 = 1.0 - ((avg_dimension_penalty + likert_penalty) / 2)
```

**Always calculated:** Yes, no LLM needed

---

### M2: Justification Coherence (LLM-Based)

**What it measures:** Internal consistency of annotator's reasoning

**Checks:**
1. **Claim Verification** — Are claims in justification present in responses?
2. **Rating Alignment** — Do issues mentioned match dimension ratings given?
3. **Likert Consistency** — Does reasoning support A vs B preference?
4. **Logical Flow** — Is the reasoning internally sound?

**Example:**
- Annotator rates "Major Issue" for Truthfulness
- Justification must mention factual errors
- If justification is vague or contradictory → low M2 score

**Requires:** `--use-llm` flag

**Output:** Score 0.0-1.0 (1.0 = perfect coherence)

---

### M3: Rubric Compliance (LLM-Based)

**What it measures:** Correct application of rubric definitions

**Checks:**
1. Does annotator understand dimension definitions?
2. Do observations fit rubric criteria for their rating?
3. Are disagreements with golden labels defensible per rubric?

**Example:**
- Rubric defines "Truthfulness: Major Issue" as "factually incorrect claims"
- Annotator flags response for this but cites stylistic preference
- M3 identifies this as misapplication of rubric

**Requires:** `--use-llm` + `--rubric`

**Output:** 
- Score 0.0-1.0
- Lists of defensible disagreements vs clear errors

---

### Final Score Formula

```
Final Score = 0.8 × M1 + 0.2 × M2
```

> **Note:** M3 is logged separately for rubric compliance analysis but doesn't affect final score.

---

## 🎚️ Evaluation Modes (Decision Table)

| Flags | M1 | M2 | M3 | Use Case |
|-------|----|----|----| ---------|
| (none) | ✅ | ❌ | ❌ | Quick dimension accuracy check |
| `--use-llm` | ✅ | ✅ | ❌ | No rubric available |
| `--use-llm --rubric` | ✅ | ✅ | ✅ | Full evaluation with rubric compliance |

**Empty Justifications:** M2/M3 automatically skipped for rows with empty justification fields.

---

## 🗂️ Column Mappings Format

The `mappings.json` file defines CSV-to-rubric mappings:

```json
{
    "dimensions": {
        "instruction_following": {
            "annotator_a": "instruction_a",
            "annotator_b": "instruction_b",
            "golden_a": "Instruction Following A",
            "golden_b": "Instruction Following B",
            "priority_a": "Instruction Following Priority A",
            "priority_b": "Instruction Following Priority B"
        }
    },
    "likert": {
        "annotator": "likert_rating",
        "golden": "Likert Scale",
        "priority": "Likert Priority"
    },
    "justification": "justification",
    "prompt_columns": {
        "prompt": "Prompt",
        "response_a": "ResponseA",
        "response_b": "ResponseB"
    },
    "identifiers": {
        "subtask_id_annotator": "subtask_id",
        "subtask_id_golden": "subtask_id",
        "annotator_id": "user_id",
        "annotator_name": "freelancer_name"
    }
}
```

**Manual Editing:** You can edit this file if auto-generated mappings need adjustment.

---

## 🔍 Interpreting Results

### Score Ranges

| Final Score | Quality | Action |
|-------------|---------|--------|
| 0.8 - 1.0 | Excellent | No action needed |
| 0.6 - 0.8 | Good | Minor review recommended |
| 0.4 - 0.6 | Needs Improvement | Detailed review required |
| 0.0 - 0.4 | Poor | Retraining needed |

### Flag Reasons

Annotations are automatically flagged for:
- **P0 Mismatch** — Objective dimension disagreement
- **Likert Mismatch >2 points** — Significant rating difference
- **M2: Justification Misaligned** — Reasoning inconsistent with ratings
- **M3: Non-Compliant** — Misapplication of rubric definitions
- **Low Score** — Final score < 0.6

---

## 📋 Common Workflows

### Quick Test (50 rows, M1 only)
```bash
python batch_evaluate.py \
    --annotator-csv data/annotator.csv \
    --golden-csv data/golden.csv \
    --mappings output/mappings.json \
    --limit 50
```

### Production Run (Full M1+M2+M3)
```bash
python batch_evaluate.py \
    --annotator-csv data/annotator.csv \
    --golden-csv data/golden.csv \
    --mappings output/mappings.json \
    --rubric output/rubric.json \
    --use-llm \
    --batch-size 5
```

### Using Together AI Instead of Gemini
```bash
python batch_evaluate.py \
    --annotator-csv data/annotator.csv \
    --golden-csv data/golden.csv \
    --mappings output/mappings.json \
    --rubric output/rubric.json \
    --use-llm \
    -m "Qwen/Qwen3-32B"
```

---

## 🎬 Complete Example: End-to-End

**Scenario:** You have 1000 annotator evaluations to quality-check.

### Step 1: Generate Rubric & Mappings

```bash
python main.py generate \
    --instruction_doc "data/RLHF_Instructions.pdf" \
    --annotator-csv "data/Annotator_Responses.csv" \
    --golden-csv "data/Golden_Labels.csv" \
    -o output
```

**Output:**
```
Loading rubric from: data/RLHF_Instructions.pdf
✓ Rubric extracted successfully
✓ Column mappings generated

Saved:
  output/RLHF_Instructions_rubric.json
  output/RLHF_Instructions_mappings.json
```

**What happened:** LLM read the PDF, extracted 6 evaluation dimensions (Instruction Following, Truthfulness, etc.), and mapped CSV columns automatically.

---

### Step 2: Test Run (50 rows)

```bash
python batch_evaluate.py \
    --annotator-csv "data/Annotator_Responses.csv" \
    --golden-csv "data/Golden_Labels.csv" \
    --mappings "output/RLHF_Instructions_mappings.json" \
    --rubric "output/RLHF_Instructions_rubric.json" \
    --use-llm \
    --limit 50 \
    -o output/test_run
```

**Output:**
```
================================================================================
BATCH ANNOTATOR EVALUATION
================================================================================
Model: gemini-2.5-flash
Batch Size: 5 rows per LLM call

--- Evaluation Mode ---
M1 (Dimension Scoring): ✓ Enabled (always)
M2 (Justification Coherence): ✓ Enabled
M3 (Rubric Compliance): ✓ Enabled

Found 50 annotator submissions
Found 50 golden labels
Limited to 50 rows

================================================================================
PASS 1: M1 Scoring (Rule-Based Dimension Matching)
================================================================================
M1 Scoring: 100%|████████████████████| 50/50

✓ M1 Evaluation Complete
  Evaluated: 50
  With justification: 48
  Empty justification: 2

================================================================================
PASS 2: M2 + M3 Scoring (Batched LLM with Rubric)
================================================================================
  Cases with justification: 48
  Batches: 10 (5 per batch)
  Estimated API calls: ~10

M2+M3 Batches: 100%|████████████████| 10/10

✓ LLM Evaluation Complete

--- EVALUATION SUMMARY ---
Total: 50
Flagged: 8 (16.0%)
Avg Final Score: 0.847
Likert Match Rate: 78.0%

✓ Results saved to: output/test_run/evaluation_results.json
✓ Plots generated
```

**What happened:** Evaluated 50 rows with all three metrics. 8 annotations flagged for review. Average score is strong (0.847).

---

### Step 3: Review Test Results

```bash
# Check flagged annotations
cat output/test_run/flagged.csv | head -5
```

**Example flagged row:**
```csv
subtask_id,annotator_name,final_score,m2_coherence_score,m3_compliance_score,flag_reasons
task_042,annotator_5,0.52,0.35,0.41,"P0 mismatches: 2; M2: Justification misaligned; Low score: 0.52"
```

**Decision:** Scores look reasonable. Proceed with full dataset.

---

### Step 4: Production Run (All 1000 rows)

```bash
python batch_evaluate.py \
    --annotator-csv "data/Annotator_Responses.csv" \
    --golden-csv "data/Golden_Labels.csv" \
    --mappings "output/RLHF_Instructions_mappings.json" \
    --rubric "output/RLHF_Instructions_rubric.json" \
    --use-llm \
    --batch-size 5 \
    -o output/production
```

**Output:**
```
M1 Scoring: 100%|████████████████████| 1000/1000
M2+M3 Batches: 100%|████████████████| 195/195

✓ Evaluation Complete
  Time: ~8 minutes
  API calls: 195
  Estimated cost: $0.35

All outputs saved to: output/production/
  • evaluation_results.json
  • full_results.csv (1000 rows)
  • flagged.csv (142 rows)
  • annotator_rankings.csv (23 annotators)
  • score_distributions.png
  • dimension_accuracy_heatmap.png
```

---

### Step 5: Analyze Results

**Check annotator rankings:**
```bash
head -10 output/production/annotator_rankings.csv
```

```csv
annotator_name,total_annotations,avg_final_score,avg_m1_score,avg_m2_score,avg_m3_score,flagged_count,flag_rate
annotator_12,87,0.912,0.934,0.889,0.923,3,0.034
annotator_7,64,0.891,0.901,0.867,0.908,5,0.078
annotator_3,52,0.876,0.888,0.841,0.892,7,0.135
annotator_19,71,0.743,0.801,0.512,0.634,19,0.268
...
```

**Insights:**
- Annotator 12: Excellent (0.912 avg score, 3% flag rate)
- Annotator 19: Needs review (0.743 avg score, 27% flag rate)

**Check dimension accuracy:**
```bash
cat output/production/dimension_accuracy_heatmap.png  # View in image viewer
```

**Insight:** "Truthfulness" dimension has 65% accuracy → may need clearer rubric definition.

---

## 🎯 Next Steps After Evaluation

### 1. Review Flagged Annotations

```bash
# Export flagged for manual review
cat output/production/flagged.csv > flagged_for_review.csv
```

**Focus on:**
- P0 mismatches (objective errors)
- Low M2 scores (incoherent justifications)
- M3 non-compliance (rubric misapplication)

---

### 2. Identify Annotators for Retraining

**Low performers (Final Score < 0.6):**
```bash
# Filter from annotator_rankings.csv
awk -F',' '$3 < 0.6 {print $1, $3}' output/production/annotator_rankings.csv
```

**Action:** Provide targeted feedback + rubric clarification.

---

### 3. Improve Rubric Clarity

**Dimensions with low accuracy (<70%):**
- Check `dimension_accuracy_heatmap.png`
- Review mismatches in `full_results.csv`
- Refine dimension definitions in rubric
- Re-run evaluation to measure improvement

---

### 4. Export for External Analysis

**Load results in Python/R:**
```python
import pandas as pd
results = pd.read_csv('output/production/full_results.csv')

# Analyze M2 vs M3 correlation
results[['m2_coherence_score', 'm3_compliance_score']].corr()

# Find annotators with high M1 but low M2
problematic = results[(results['m1_dimension_score'] > 0.8) & 
                      (results['m2_coherence_score'] < 0.5)]
```

---

### 5. Monitor Over Time

**Re-run monthly:**
```bash
# Same command, different output dir
python batch_evaluate.py ... -o output/2025-02
```

**Track improvement:**
- Average final score trending up?
- Flag rate decreasing?
- Specific annotators improving?

---

## ⚡ Performance Tips

1. **Start with M1 only** on full dataset to verify mappings
2. **Test with --limit 50** when using `--use-llm` to estimate costs
3. **Use batch_evaluate.py** for production (5-10x faster)
4. **Batch size 5-7** balances speed vs token limits
5. **Monitor API quotas** — 1000 rows with batch_size=5 ≈ 200 LLM calls

**Cost Estimate (Gemini 2.5 Flash):**
- 1000 rows, M1+M2+M3, batch_size=5: ~$0.30-0.50

---

## 🐛 Troubleshooting

### "No rubric provided" but M3 expected
Set `--rubric` path to enable M3.

### "No justifications found"
Check that justification column name is correctly mapped in `mappings.json`.

### API quota exceeded
Wait for quota reset or reduce batch size. Script auto-retries with exponential backoff.

### Empty em-dash error (Mac)
Mac autocorrect may convert `--` to `—`. Type two hyphens carefully or disable autocorrect.

---

## 📄 License

MIT License

---

## 🙏 Acknowledgments

Pipeline architecture inspired by best practices in LLM-as-Judge evaluation systems.
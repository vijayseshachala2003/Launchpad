# src/prompts.py

# Meta-prompt to extract evaluation dimensions/rubric from instruction document
RUBRIC_EXTRACTION_TEMPLATE = """
You are an expert evaluation designer. Your task is to analyze an instruction document and extract the evaluation rubric/dimensions that annotators use to judge AI model responses.

Analyze the provided instruction document to identify:
1. All evaluation dimensions/categories (e.g., "Instruction Following", "Truthfulness", "Groundedness")
2. The possible values/levels for each dimension (e.g., "No Issues", "Minor Issue(s)", "Major Issue(s)", "N/A"). These descriptions can be in paragraph, numbered/bullet points or tabular form.
3. The possible levels for different dimensions can be different.
4. Any definitions or guidelines for each dimension

Create a structured JSON object with this schema:
{{
    "rubric": {{
        "name": "Name of the evaluation task",
        "task": "Brief description of the type of task the prompt intends LLMs to perform.\n
        Also explain any extra contextual information available along with or within the prompt.\n
        Explain the type and format of contextual information if it is available.\n
        Also include any constraints on intended response format if any such information is provided.
        "description": "Brief description of what is being evaluated. \n
        The description should state the total number of dimensions/categories across which prompt responses are to be evaluated.\n
        The assessed intention of the prompt poser should also be included in the description as that would be used later for evaluating subjective or objective alignments and entailments.",
        "categories": [
            {{
                "id": "snake_case_id",
                "name": "Human Readable Name",
                "description": "Definition from the document",
                "type": "categorical",
                "levels": [
                    {{"label": "No Issues", "value": 0, "description": "..."}},
                    {{"label": "Minor Issue(s)", "value": 1, "description": "..."}},
                    {{"label": "Major Issue(s)", "value": 2, "description": "..."}}
                    {{"label": "N/A", "value": 3, "description": "..."}}
                ]
            }}
        ],
        "final_rating": {{
            "type": "likert",
            "scale": 7,
            "description": "Description of the final comparative rating",
            "levels": [
                {{"value": 1, "label": "A is much better than B"}},
                {{"value": 2, "label": "A is better than B"}},
                {{"value": 3, "label": "A is slightly better than B"}},
                {{"value": 4, "label": "About the same"}},
                {{"value": 5, "label": "B is slightly better than A"}},
                {{"value": 6, "label": "B is better than A"}},
                {{"value": 7, "label": "B is much better than A"}}
            ]
        }}
    }}
}}

IMPORTANT:
- Extract ALL dimensions mentioned in the document
- Use snake_case for IDs
- Include ALL possible values/levels for each dimension **mandatorily**. 
- The labels seen may differ in name or number from the ones shown in the schema. 
- The labels may be different for each category. Do not miss any label. 
- If the document mentions evaluating two responses (A and B), note that dimensions apply to both
- Include any special values like "N/A - Not Applicable" or "Cannot Assess" or "Refusal to assess", if such special cases are provided.
- Do not add any label from your side. 
- Do not add any extra label/level description information from your side.
- Be faithful in copying the label names.

Return ONLY the raw JSON object, without any markdown formatting or explanations.

---
INSTRUCTION DOCUMENT:
{instruction_document_text}
---
"""

# Meta-prompt to generate column mappings from rubric and CSV headers
COLUMN_MAPPING_TEMPLATE = """
You are a data mapping expert. Your task is to create mappings between CSV column headers and evaluation rubric dimensions.

Given:
1. Possibly a rubric with evaluation dimensions. This rubric optionally may not be available.
2. CSV column headers from golden labels (contains golden ratings, priorities, AND original prompt/responses)
3. CSV column headers from annotator responses (contains annotator's ratings and justification to original prompt/responses)


Create a JSON mapping that links each rubric dimension to its corresponding columns in both CSVs.
If the rubric is not provided, infer the dimension names from the CSV headers. Don't repeat any name and don't miss any dimension.

The annotator CSV likely has columns like:
- "dimension_name_a" or "dimension_name_A" for Response A evaluations
- "dimension_name_b" or "dimension_name_B" for Response B evaluations

The golden label CSV likely has columns like:
- "Dimension Name A" or "Dimension_A" or "Dimension_a" for Response A
- "Dimension Name B" or "Dimension_B" or "Dimension_b" for Response B
- "Dimension Name Priority A" for P0/P1 priority of Response A
- "Dimension Name Priority B" for P0/P1 priority of Response B

The golden label CSV also contains:
- Original prompt text column
- Response A text column
- Response B text column
- A unique identifier (e.g., subtask_id) linking to annotator CSV

The golden label CSV may contain supplementary context columns beyond ratings.
Identify these by examining column names and inferring their purpose from naming patterns within the CSV itself.

Examples of context columns:
- Screenshot or visual reference links
- Instructions specific to LLM A or LLM B
- Previous conversation or multi-turn context
- Task metadata or category tags

Map any identified context columns using descriptive semantic keys.
Only include columns you can reasonably infer purpose for based on the header names.

Output a JSON object with this structure:
{{
    "dimensions": {{
        "dimension_id": {{
            "annotator_a": "column_in_annotator_csv_for_response_A_rating",
            "annotator_b": "column_in_annotator_csv_for_response_B_rating",
            "golden_a": "column_in_golden_csv_for_response_A_rating",
            "golden_b": "column_in_golden_csv_for_response_B_rating",
            "priority_a": "column_in_golden_csv_for_response_A_priority",
            "priority_b": "column_in_golden_csv_for_response_B_priority"
        }}
    }},
    "likert": {{
        "annotator": "column_for_annotator_likert_rating",
        "golden": "column_for_golden_likert_rating",
        "priority": "column_for_likert_priority_if_exists"
    }},
    "justification": "column_for_annotator_justification",
    "prompt_columns": {{
        "prompt": "column_in_golden_csv_containing_original_prompt_text",
        "response_a": "column_in_golden_csv_containing_llm_a_response",
        "response_b": "column_in_golden_csv_containing_llm_b_response"
    }},
    "identifiers": {{
        "subtask_id_annotator": "column_in_annotator_csv_for_task_id_linking_to_golden_csv",
        "subtask_id_golden": "column_in_golden_csv_for_unique_task_id",
        "annotator_id": "column_for_annotator_identifier",
        "annotator_name": "column_for_annotator_name"
    }},
    "context_columns": {{
        "semantic_key": "column_name_in_golden_csv"
    }}
}}

RUBRIC:
{rubric_json}

ANNOTATOR CSV HEADERS:
{annotator_headers}

GOLDEN LABEL CSV HEADERS:
{golden_headers}

Return ONLY the JSON mapping, no explanations.
"""

# M2: Justification Coherence - Internal consistency check
# Does the annotator's justification align with their OWN dimension ratings?
# No rubric needed - purely checks internal consistency
JUSTIFICATION_COHERENCE_TEMPLATE = """
You are evaluating whether an annotator's justification is internally consistent with their own ratings.

## ORIGINAL PROMPT:
{original_prompt}

## RESPONSE A:
{response_a}

## RESPONSE B:
{response_b}

## ANNOTATOR'S DIMENSION RATINGS:
Response A: {dimension_scores_a}
Response B: {dimension_scores_b}
Likert Rating: {annotator_likert}

## ANNOTATOR'S JUSTIFICATION:
{justification}

## EVALUATE:
1. **Claim Verification**: Are specific claims in the justification actually present in Response A/B?
2. **Rating-Justification Alignment**: Do issues mentioned match the ratings given? (e.g., if rated "Major Issue" for Truthfulness, does justification mention factual errors?)
3. **Likert Consistency**: Does the reasoning support the A vs B preference expressed in Likert rating?
4. **Logical Flow**: Is the reasoning logically sound (no contradictions)?

## OUTPUT (JSON only):
{{
    "claim_verification": "<verified|partially_verified|unverified|fabricated>",
    "rating_alignment": "<aligned|partially_aligned|misaligned>",
    "likert_consistency": "<consistent|inconsistent>",
    "logical_flow": "<sound|minor_gaps|contradictory>",
    "issues_found": ["list of specific issues if any"],
    "score": <0.0 to 1.0>,
    "explanation": "<brief explanation with specific examples>"
}}

SCORING GUIDE:
- 1.0: All claims verified, fully aligned, consistent, sound logic
- 0.8: Minor gaps in one area
- 0.6: Significant gap in one area OR minor gaps in multiple
- 0.4: Multiple significant issues
- 0.2: Major contradictions or fabrications
- 0.0: Completely incoherent or fabricated
"""

# M3: Rubric Compliance - External validity check
# Is the annotator's justification valid according to rubric definitions?
# Requires rubric - assesses against formal dimension definitions
RUBRIC_COMPLIANCE_TEMPLATE = """
You are evaluating whether an annotator correctly applied the evaluation rubric.


## RUBRIC DEFINITIONS:
{rubric_definitions}

## ORIGINAL PROMPT:
{original_prompt}

## RESPONSE A:
{response_a}

## RESPONSE B:
{response_b}

## ADDITIONAL CONTEXT (if available):
{context_info}

## ANNOTATOR'S RATINGS:
Response A: {dimension_scores_a}
Response B: {dimension_scores_b}
Likert: {annotator_likert}

## GOLDEN LABEL RATINGS (Reference):
Response A: {golden_scores_a}
Response B: {golden_scores_b}
Likert: {golden_likert}


## DIMENSIONS WHERE ANNOTATOR DIFFERS FROM GOLDEN:
{mismatches}

## ANNOTATOR'S JUSTIFICATION:
{justification}

## EVALUATE:
For each dimension where annotator differs from golden:
1. Does the annotator correctly understand the dimension definition from the rubric?
2. Does the annotator's observation fit the rubric's criteria for their chosen rating?
3. Could a reasonable evaluator reach the annotator's conclusion given the rubric?

## OUTPUT (JSON only):
{{
    "dimension_assessments": [
        {{
            "dimension": "<dimension_id>",
            "annotator_rating": "<rating>",
            "golden_rating": "<rating>",
            "rubric_understanding": "<correct|partial|incorrect>",
            "rating_justified": true/false,
            "explanation": "<brief explanation>"
        }}
    ],
    "overall_compliance": "<compliant|partially_compliant|non_compliant>",
    "defensible_disagreements": ["dimensions where annotator's view is defensible"],
    "clear_errors": ["dimensions where annotator clearly misapplied rubric"],
    "score": <0.0 to 1.0>,
    "explanation": "<summary>"
}}

SCORING GUIDE:
- 1.0: Perfect rubric application, all ratings justified
- 0.8: Minor misunderstanding, mostly correct application
- 0.6: Some defensible disagreements, some errors
- 0.4: Multiple rubric misapplications
- 0.2: Fundamental misunderstanding of rubric
- 0.0: Complete disregard for rubric definitions
"""

# ============ LEGACY / BATCH PROCESSING ============

# Legacy template for batch processing (no context)
# Used by: batch_evaluate.py
# Meta-prompt for LLM-as-judge to evaluate justification quality
JUSTIFICATION_JUDGE_TEMPLATE_LEGACY = """
You are an expert annotation quality evaluator. Your task is to assess whether an annotator's written justification is coherent with their evaluation ratings.

CONTEXT:
- Annotator rated two AI responses (A and B) across multiple dimensions
- Annotator provided a Likert rating comparing the responses
- Annotator wrote a justification explaining their ratings

ANNOTATOR'S RATINGS:
- Likert Rating: {annotator_likert}
- Dimension Scores for Response A: {dimension_scores_a}
- Dimension Scores for Response B: {dimension_scores_b}

GOLDEN LABEL RATINGS (Reference):
- Likert Rating: {golden_likert}
- Dimension Scores for Response A: {golden_scores_a}
- Dimension Scores for Response B: {golden_scores_b}

DIMENSIONS WHERE ANNOTATOR DIFFERS FROM GOLDEN:
{mismatches}

ANNOTATOR'S JUSTIFICATION:
{justification}

EVALUATION CRITERIA:
1. Does the justification provide clear reasoning for the Likert rating?
2. Are the issues mentioned consistent with the dimension ratings given?
3. Is the reasoning logical and well-supported by specific observations?
4. Even if annotator disagrees with golden label, is their reasoning valid?

OUTPUT (JSON only):
{{
    "alignment": "<aligned|partially_aligned|misaligned|cannot_assess>",
    "coherence_with_ratings": true/false,
    "reasoning_quality": "<strong|adequate|weak|missing>",
    "confidence": <0.0 to 1.0>,
    "explanation": "<brief explanation>",
    "score": <0.0 to 1.0 where 1.0 is excellent justification>
}}
"""

# # Enhanced template WITH original prompt and responses for proper entailment checking
# JUSTIFICATION_JUDGE_TEMPLATE_WITH_CONTEXT = """
# You are an expert annotation quality evaluator. Your task is to assess whether an annotator's written justification is:
# 1. **Grounded** in the actual content of Response A and Response B
# 2. **Coherent** with their dimension ratings
# 3. **Logically sound** in supporting their Likert rating

# ## ORIGINAL PROMPT (What the user asked):
# {original_prompt}

# ## RESPONSE A (First AI response):
# {response_a}

# ## RESPONSE B (Second AI response):
# {response_b}

# ## ANNOTATOR'S RATINGS:
# - Likert Rating: {annotator_likert}
# - Dimension Scores for Response A: {dimension_scores_a}
# - Dimension Scores for Response B: {dimension_scores_b}

# ## GOLDEN LABEL RATINGS (Reference):
# - Likert Rating: {golden_likert}
# - Dimension Scores for Response A: {golden_scores_a}
# - Dimension Scores for Response B: {golden_scores_b}

# ## DIMENSIONS WHERE ANNOTATOR DIFFERS FROM GOLDEN:
# {mismatches}

# ## ANNOTATOR'S JUSTIFICATION:
# {justification}

# ## EVALUATION CRITERIA:
# 1. **Factual Grounding**: Are claims in the justification actually present in Response A/B?
# 2. **Entailment**: Does the justification logically follow from the response content?
# 3. **Rating Coherence**: Do the identified issues match the dimension ratings given?
# 4. **Likert Support**: Does the reasoning support choosing A over B (or vice versa)?
# 5. **Validity**: Even if disagreeing with golden, is the annotator's reasoning valid based on actual content?

# OUTPUT (JSON only):
# {{
#     "alignment": "<aligned|partially_aligned|misaligned|cannot_assess>",
#     "factual_grounding": "<strong|adequate|weak|fabricated>",
#     "entailment_valid": true/false,
#     "coherence_with_ratings": true/false,
#     "reasoning_quality": "<strong|adequate|weak|missing>",
#     "confidence": <0.0 to 1.0>,
#     "explanation": "<specific explanation citing text from responses>",
#     "score": <0.0 to 1.0 where 1.0 is excellent justification>
# }}
# """

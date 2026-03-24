JUSTIFICATION_COHERENCE_TEMPLATE = """
You are evaluating whether an annotator's justification is internally consistent with their ratings.

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


## ANNOTATOR'S JUSTIFICATION:
{justification}

## EVALUATE FOR EACH DIMENSION WHERE ANNOTATOR DIFFERS FROM GOLDEN:
{mismatches}

For each mismatch, assess:
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
            "rating_justified": <true|false>,
            "explanation": "<brief explanation>"
        }}
    ],
    "overall_rubric_compliance": "<compliant|partially_compliant|non_compliant>",
    "defensible_disagreements": ["list of dimensions where annotator's view is defensible"],
    "clear_errors": ["list of dimensions where annotator clearly misapplied rubric"],
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

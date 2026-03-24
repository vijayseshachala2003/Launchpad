# src/generator.py
import json
import time
from typing import Any, Dict, List, Optional, Tuple

from src.prompts import COLUMN_MAPPING_TEMPLATE, RUBRIC_EXTRACTION_TEMPLATE

# Rate limiting settings
API_DELAY_SECONDS = 3.0  # Delay between API calls
MAX_RETRIES = 3
RETRY_WAIT_SECONDS = 60.0  # Wait time on quota error


def _call_gemini(prompt: str, model_name: str = "gemini-2.5-flash") -> str:
    """Call Google Gemini API with retry on quota errors."""
    import google.generativeai as genai

    for attempt in range(MAX_RETRIES):
        try:
            if attempt > 0:
                print(f"  Retry {attempt + 1}/{MAX_RETRIES}...")

            time.sleep(API_DELAY_SECONDS)  # Rate limiting
            model = genai.GenerativeModel(model_name)
            response = model.generate_content(prompt)
            return response.text

        except Exception as e:
            print(e)
            print(60 * "=")
            if "quota" in str(e).lower() and attempt < MAX_RETRIES - 1:
                print(f"  Quota exceeded. Waiting {RETRY_WAIT_SECONDS}s...")
                time.sleep(RETRY_WAIT_SECONDS)
            else:
                raise e

    raise Exception("Max retries exceeded")


def _call_together(prompt: str, model_name: str = "Qwen/Qwen3-32B") -> str:
    """Call Together API with retry on quota errors."""
    import os

    from together import Together

    for attempt in range(MAX_RETRIES):
        try:
            if attempt > 0:
                print(f"  Retry {attempt + 1}/{MAX_RETRIES}...")

            time.sleep(API_DELAY_SECONDS)  # Rate limiting
            client = Together(api_key=os.getenv("TOGETHER_API_KEY"))
            response = client.chat.completions.create(
                model=model_name,
                messages=[{"role": "user", "content": prompt}],
                max_tokens=4000,
                temperature=0.1,
            )
            return response.choices[0].message.content

        except Exception as e:
            if "quota" in str(e).lower() and attempt < MAX_RETRIES - 1:
                print(f"  Quota exceeded. Waiting {RETRY_WAIT_SECONDS}s...")
                time.sleep(RETRY_WAIT_SECONDS)
            else:
                raise e

    raise Exception("Max retries exceeded")


def _clean_json_response(text: str) -> str:
    """Clean LLM response to extract valid JSON."""
    text = text.strip()
    if "```json" in text:
        text = text.split("```json")[1].split("```")[0]
    elif "```" in text:
        text = text.split("```")[1].split("```")[0]
    return text.strip()


def generate_rubric_from_document(
    instruction_document: str, model_name: str = "gemini-2.5-flash"
) -> Optional[Dict]:
    """
    Extracts evaluation rubric/dimensions from an instruction document.

    Args:
        instruction_document (str):  Full text of the instruction document.
        model_name (str):  LLM model to use for extraction.

    Returns:
        Rubric dictionary or None on failure.
    """
    print(f"\n--- Extracting Rubric using {model_name} ---")

    try:
        prompt = RUBRIC_EXTRACTION_TEMPLATE.format(
            instruction_document_text=instruction_document
        )

        if "gemini" in model_name.lower():
            response_text = _call_gemini(prompt, model_name)
        else:
            response_text = _call_together(prompt, model_name)

        cleaned = _clean_json_response(response_text)
        rubric = json.loads(cleaned)

        print("Rubric extracted successfully.")
        return rubric

    except Exception as e:
        print(f"Error extracting rubric: {e}")
        return None


def generate_column_mappings(
    annotator_headers: List[str],
    golden_headers: List[str],
    rubric: Optional[Dict] = None,
    model_name: str = "gemini-2.5-flash",
) -> Optional[Dict]:
    """
    Generates column mappings between CSV headers and rubric dimensions.

    Args:
        annotator_headers: Column headers from annotator CSV.
        golden_headers: Column headers from golden label CSV.
        rubric: Optional rubric dictionary. If provided, used for dimension naming.
        model_name: LLM model to use for mapping.

    Returns:
        Column mapping dictionary or None on failure.
    """
    print(f"\n--- Generating Column Mappings using {model_name} ---")

    try:
        # Format rubric for prompt (handle None case)
        if rubric:
            rubric_text = json.dumps(rubric, indent=2)
        else:
            rubric_text = "Not provided. Infer dimensions from CSV column headers."

        prompt = COLUMN_MAPPING_TEMPLATE.format(
            rubric_json=rubric_text,
            annotator_headers=str(annotator_headers),
            golden_headers=str(golden_headers),
        )

        if "gemini" in model_name.lower():
            response_text = _call_gemini(prompt, model_name)
        else:
            response_text = _call_together(prompt, model_name)

        cleaned = _clean_json_response(response_text)
        mappings = json.loads(cleaned)

        # # Clean up any [PROMPTS_CSV] prefix from the mappings
        # if "prompt_columns" in mappings:
        #     for key in mappings["prompt_columns"]:
        #         val = mappings["prompt_columns"][key]
        #         if isinstance(val, str) and val.startswith("[PROMPTS_CSV] "):
        #             mappings["prompt_columns"][key] = val.replace("[PROMPTS_CSV] ", "")

        # # Also clean up identifiers section
        # if "identifiers" in mappings:
        #     for key in mappings["identifiers"]:
        #         val = mappings["identifiers"][key]
        #         if isinstance(val, str) and val.startswith("[PROMPTS_CSV] "):
        #             mappings["identifiers"][key] = val.replace("[PROMPTS_CSV] ", "")

        print("Column mappings generated successfully.")
        return mappings

    except Exception as e:
        print(f"Error generating column mappings: {e}")
        return None


# def generate_evaluation_artifacts(
#     instruction_document: str, model_name: str = "gemini-2.5-flash"
# ) -> Tuple[Optional[str], Optional[Dict]]:
#     """
#     Generates both system prompt and rubric from instruction document.
#     Compatible with original LLM-as-Judge interface.

#     Args:
#         instruction_document: Full text of the instruction document.
#         model_name: LLM model to use.

#     Returns:
#         Tuple of (system_prompt_text, rubric_dict) or (None, None) on failure.
#     """
#     rubric = generate_rubric_from_document(instruction_document, model_name)

#     if rubric is None:
#         return None, None

#     # Generate a system prompt summarizing the rubric
#     system_prompt = _generate_system_prompt_from_rubric(rubric)

#     return system_prompt, rubric


def _generate_system_prompt_from_rubric(rubric: Dict) -> str:
    """Generate a system prompt from extracted rubric."""
    rubric_data = rubric.get("rubric", rubric)

    lines = [
        f"# {rubric_data.get('name', 'Annotation Evaluation Task')}",
        "",
        rubric_data.get(
            "description", "Evaluate annotator responses against golden labels."
        ),
        "",
        "## Evaluation Dimensions",
        "",
    ]

    for cat in rubric_data.get("categories", []):
        lines.append(f"### {cat.get('name', cat.get('id', 'Unknown'))}")
        lines.append(cat.get("description", ""))
        lines.append("")

        if "levels" in cat:
            lines.append("**Possible Values:**")
            for level in cat["levels"]:
                lines.append(
                    f"- {level.get('label', 'Unknown')}: {level.get('description', '')}"
                )
            lines.append("")

    if "final_rating" in rubric_data:
        fr = rubric_data["final_rating"]
        lines.append("## Final Rating")
        lines.append(fr.get("description", ""))
        lines.append("")
        if "levels" in fr:
            for level in fr["levels"]:
                lines.append(f"- {level.get('value', '')}: {level.get('label', '')}")

    return "\n".join(lines)

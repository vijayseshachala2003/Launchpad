#!/usr/bin/env python3
"""Debug script to find why golden_value is None."""

import csv
import json

# UPDATE THESE PATHS
MAPPINGS_PATH = (
    "./output/External - BLUEBIRD MULTI-TAB EVALUATION - INSTRUCTIONS_mappings.json"
)
GOLDEN_CSV = "./data/RLHF Inventory - Bluebird Gold Label.csv"
ANNOTATOR_CSV = "./data/RLHF Inventory - Dummy Responses BB.csv"

# Load mappings
with open(MAPPINGS_PATH) as f:
    mappings = json.load(f)

# Load one row from each CSV
with open(GOLDEN_CSV, encoding="utf-8") as f:
    golden_row = list(csv.DictReader(f))[0]

with open(ANNOTATOR_CSV, encoding="utf-8") as f:
    annotator_row = list(csv.DictReader(f))[0]

# Simulate merge (same as main.py)
merged = {**annotator_row}
for k, v in golden_row.items():
    merged[f"{k}_golden"] = v

print("=" * 60)
print("MERGED ROW KEYS (golden columns):")
print("=" * 60)
for k in sorted(merged.keys()):
    if "_golden" in k:
        print(
            f"  '{k}': '{merged[k][:50]}...'"
            if len(str(merged[k])) > 50
            else f"  '{k}': '{merged[k]}'"
        )

print("\n" + "=" * 60)
print("MAPPINGS - DIMENSION COLUMNS:")
print("=" * 60)
dims = mappings.get("dimensions", {})
for dim_id, dim_cols in dims.items():
    golden_a = dim_cols.get("golden_a", "")
    golden_b = dim_cols.get("golden_b", "")

    # What the code looks for
    lookup_a = f"{golden_a}_golden"
    lookup_b = f"{golden_b}_golden"

    # Check if it exists
    found_a = lookup_a in merged
    found_b = lookup_b in merged

    print(f"\n{dim_id}:")
    print(f"  golden_a mapping: '{golden_a}'")
    print(f"  looking for: '{lookup_a}' -> {'FOUND' if found_a else 'NOT FOUND!'}")
    if found_a:
        print(f"  value: '{merged[lookup_a]}'")

    print(f"  golden_b mapping: '{golden_b}'")
    print(f"  looking for: '{lookup_b}' -> {'FOUND' if found_b else 'NOT FOUND!'}")
    if found_b:
        print(f"  value: '{merged[lookup_b]}'")

print("\n" + "=" * 60)
print("LIKERT MAPPING:")
print("=" * 60)
likert = mappings.get("likert", {})
golden_likert = likert.get("golden", "")
lookup = f"{golden_likert}_golden"
print(f"  golden mapping: '{golden_likert}'")
print(f"  looking for: '{lookup}' -> {'FOUND' if lookup in merged else 'NOT FOUND!'}")
if lookup in merged:
    print(f"  value: '{merged[lookup]}'")

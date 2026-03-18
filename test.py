import sys
from pathlib import Path

import requests

BACKEND = Path(__file__).resolve().parent / "backend"
sys.path.insert(0, str(BACKEND))

from ingest_api import STAGE_IDS_SQL  # noqa: E402

API_ENDPOINT = "https://reporting.soulhq.ai/read-query/execute"
SOURCE = "Python Test"

QUERY = f"""
SELECT
  A.created_at,
  u.email,
  A.previous_data ->> 'uniqueId' AS "uniqueId"
FROM annotation_task_response_data A
LEFT JOIN annotation_users u ON A.user_id = u.id
WHERE A.status = 'SUBMITTED'
  AND A.stage_id IN {STAGE_IDS_SQL}
ORDER BY A.created_at
LIMIT 5;
"""


def test_api():
    url = f"{API_ENDPOINT}?source={requests.utils.quote(SOURCE)}"

    response = requests.post(
        url,
        json={"query": QUERY},
        headers={"Content-Type": "application/json"},
        timeout=60,
    )

    print(f"Status Code: {response.status_code}")

    if response.status_code != 200:
        print("Error response:")
        print(response.text)
        return

    data = response.json()

    if isinstance(data, list):
        rows = data
    elif isinstance(data, dict):
        rows = data.get("data") or data.get("rows") or []
    else:
        rows = []

    print(f"\nTotal rows received: {len(rows)}")

    if rows:
        print("\nSample row:")
        print(rows[0])
    else:
        print("No data returned.")


if __name__ == "__main__":
    test_api()

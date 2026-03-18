#!/usr/bin/env python3
"""
Launchpad Eval — small server to serve the frontend and run Section 2 or Section 3 judge scripts.
Accepts file upload; names input/output as section_N_YYYY-MM-DD_HH-MM-SS.csv and ..._output.csv.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask, jsonify, request, send_from_directory
from flask import Response, stream_with_context

from datetime_tz import wall_to_utc_iso
from pipeline_runner import run_pipeline_events

BACKEND_DIR = Path(__file__).resolve().parent
REPO_ROOT = BACKEND_DIR.parent
FRONTEND_DIR = REPO_ROOT / "frontend"

# Load .env from backend/ so OPENAI_API_KEY is available for judge subprocesses
load_dotenv(BACKEND_DIR / ".env")

app = Flask(__name__, static_folder=str(FRONTEND_DIR))
app.config["MAX_CONTENT_LENGTH"] = 100 * 1024 * 1024  # 100 MB


def load_config() -> dict:
    config_path = BACKEND_DIR / "config.json"
    if not config_path.exists():
        return {}
    with open(config_path, encoding="utf-8") as f:
        return json.load(f)


def _timestamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d_%H-%M-%S")


def _expand_utc_end_inclusive(date_to_z: str) -> str:
    """datetime-local '23:59' becomes 23:59:00Z and drops rows in the last minute."""
    if not date_to_z.endswith("Z"):
        return date_to_z
    dt = datetime.fromisoformat(date_to_z.replace("Z", "+00:00"))
    if dt.hour == 23 and dt.minute == 59 and dt.second == 0 and dt.microsecond == 0:
        dt = dt.replace(second=59, microsecond=999999)
        return dt.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    return date_to_z


@app.route("/")
def index():
    return send_from_directory(FRONTEND_DIR, "index.html")


@app.route("/api/pipeline", methods=["POST"])
def api_pipeline():
    data = request.get_json() or {}

    raw_from = (data.get("date_from") or "").strip()
    raw_to = (data.get("date_to") or "").strip()
    if not raw_from or not raw_to:
        return jsonify({"error": "date_from and date_to are required (ISO datetime)."}), 400
    tz_name = (data.get("timezone") or os.environ.get("PIPELINE_TIMEZONE") or "UTC").strip() or "UTC"
    if tz_name.upper() == "GMT":
        tz_name = "UTC"
    try:
        date_from = wall_to_utc_iso(raw_from, tz_name)
        date_to = _expand_utc_end_inclusive(wall_to_utc_iso(raw_to, tz_name))
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    df = datetime.fromisoformat(date_from.replace("Z", "+00:00"))
    dt = datetime.fromisoformat(date_to.replace("Z", "+00:00"))
    if df > dt:
        return jsonify(
            {"error": "date_from must be before or equal to date_to (in the selected timezone)."}
        ), 400
    try:
        max_rows = int(data.get("max_rows") or 0)
    except (TypeError, ValueError):
        max_rows = 0
    skip_ingest = bool(data.get("skip_ingest"))
    cfg = load_config()
    python_cmd = cfg.get("python", "python3")

    def generate():
        try:
            for ev in run_pipeline_events(
                BACKEND_DIR,
                date_from,
                date_to,
                max_rows,
                python_cmd,
                skip_ingest,
            ):
                yield f"data: {json.dumps(ev)}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.route("/api/run", methods=["POST"])
def run_section():
    # Support multipart form: section, file (CSV), max_rows
    section_raw = request.form.get("section")
    try:
        section = int(section_raw)
    except (TypeError, ValueError):
        section = None
    if section not in (2, 3):
        return {"error": "Invalid section. Use 2 or 3."}, 400

    upload = request.files.get("file")
    if not upload or not upload.filename:
        return {"error": "No file uploaded. Please select an input CSV file."}, 400
    if not upload.filename.lower().endswith(".csv"):
        return {"error": "File must be a CSV."}, 400

    max_rows_raw = request.form.get("max_rows", "0").strip()
    max_rows = int(max_rows_raw) if max_rows_raw.isdigit() else 0

    config = load_config()
    key = "section_2_script" if section == 2 else "section_3_script"
    script_path = config.get(key)
    if not script_path:
        return {"error": f"Script not found for section {section}. Edit config.json and set '{key}'."}, 400
    script_path = Path(script_path)
    if not script_path.is_absolute():
        script_path = BACKEND_DIR / script_path
    script_path = script_path.resolve()
    if not script_path.exists():
        return {"error": f"Script not found for section {section}. Edit config.json and set '{key}'."}, 400

    script_dir = script_path.parent
    timestamp = _timestamp()
    base_name = f"section_{section}_{timestamp}"
    input_path = script_dir / f"{base_name}.csv"
    output_path = script_dir / f"{base_name}_output.csv"

    try:
        upload.save(str(input_path))
    except Exception as e:
        return {"error": f"Failed to save uploaded file: {e}"}, 500

    python_cmd = config.get("python", "python3")
    cmd = [python_cmd, script_path, "--input", str(input_path), "--output", str(output_path)]
    if max_rows > 0:
        cmd.extend(["--max-rows", str(max_rows)])

    def generate():
        proc = None
        try:
            env = os.environ.copy()
            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
                cwd=str(script_dir),
                env=env,
            )
            stdout_lines = []
            for line in iter(proc.stdout.readline, ""):
                stdout_lines.append(line)
                # Judge scripts print "Completed X/Y ..." — parse for progress
                m = re.search(r"Completed\s+(\d+)/(\d+)", line)
                if m:
                    yield f"data: {json.dumps({'type': 'progress', 'current': int(m.group(1)), 'total': int(m.group(2))})}\n\n"
            proc.wait(timeout=3600)
            stdout_text = "".join(stdout_lines)
        except FileNotFoundError as e:
            yield f"data: {json.dumps({'type': 'done', 'error': str(e), 'exit_code': -1})}\n\n"
            return
        except subprocess.TimeoutExpired:
            if proc:
                proc.kill()
            yield f"data: {json.dumps({'type': 'done', 'error': 'Run timed out (1 hour).', 'exit_code': -1})}\n\n"
            return
        except Exception as e:
            yield f"data: {json.dumps({'type': 'done', 'error': str(e), 'exit_code': -1})}\n\n"
            return
        yield f"data: {json.dumps({'type': 'done', 'exit_code': proc.returncode, 'stdout': stdout_text, 'stderr': '', 'input_path': str(input_path), 'output_path': str(output_path)})}\n\n"

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


if __name__ == "__main__":
    # threaded=True allows running Section 2 and Section 3 concurrently (multi-thread)
    app.run(host="127.0.0.1", port=5050, debug=False, threaded=True)

# Launchpad Eval — Section 2 & 3

All code lives in this single folder. Web UI to run the judge pipelines for **Section 2** and **Section 3**; you can run both sections at once (parallel, multi-threaded).

## Setup

1. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```

2. Create `.env` in this folder with `OPENAI_API_KEY=your_key` (used by the judge scripts when run from the server).

3. `config.json` points to `scripts/judge_section2.py` and `scripts/judge_section3.py` by default. Set `python` to your interpreter (e.g. `python3`) if needed.

## Run

From this directory:

```bash
python server.py
```

Then open **http://127.0.0.1:5050** in your browser.

- **Section 2** and **Section 3** each have their own file input, max rows, and **Run** button.
- You can run both at the same time; the server handles concurrent requests (threaded). Judge scripts use their own worker threads internally.
- Input/output files are written under `scripts/` as `section_N_YYYY-MM-DD_HH-MM-SS.csv` and `..._output.csv` (and `.json`).

/**
 * Docs + CLI reference for backend/annotator-judge/ (Python M1/M2/M3 toolkit).
 * Web API integration can be added later (spawn main.py / batch_evaluate.py from server/).
 */
export default function AnnotatorJudgePanel() {
  return (
    <section className="section-panel" aria-labelledby="annotator-judge-heading">
      <div className="container">
        <h1 id="annotator-judge-heading">Annotator evaluation (M1 / M2 / M3)</h1>
        <p className="subtitle">
          Generic pipeline for comparing <strong>annotator</strong> judgements to <strong>golden</strong> labels:
          rule-based <strong>M1</strong>, LLM justification coherence <strong>M2</strong>, and rubric compliance{' '}
          <strong>M3</strong>. Code lives under <code>backend/annotator-judge/</code> — see{' '}
          <code>README.md</code> there for full documentation and a <strong>compartment file map</strong> (CLI vs{' '}
          <code>src/</code> vs config).
        </p>

        <div className="card">
          <h2>Workflows</h2>
          <ul className="bullet-list">
            <li>
              <strong>Generate</strong> — Extract rubric + column mappings from an instruction PDF/DOCX (optional) and
              annotator/golden CSVs.
            </li>
            <li>
              <strong>Evaluate</strong> — <code>main.py evaluate</code> or faster <code>batch_evaluate.py</code>.
            </li>
            <li>
              <strong>Report</strong> — <code>main.py report</code> for summaries, rankings, CSVs, plots.
            </li>
          </ul>
        </div>

        <div className="card">
          <h2>Typical inputs</h2>
          <table className="info-table">
            <thead>
              <tr>
                <th>Artifact</th>
                <th>Role</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Annotator CSV</td>
                <td>Annotator ratings, Likert, justifications</td>
              </tr>
              <tr>
                <td>Golden CSV</td>
                <td>Golden labels + prompts + ResponseA / ResponseB</td>
              </tr>
              <tr>
                <td>Instruction doc</td>
                <td>Optional PDF/DOCX for rubric extraction (M3)</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="card">
          <h2>Run locally (CLI)</h2>
          <p className="tz-hint" style={{ marginBottom: '0.75rem' }}>
            Python 3.10+, <code>pip install -r requirements.txt</code>, and <code>.env</code> with{' '}
            <code>GOOGLE_API_KEY</code> (or Together). From repo <code>backend/annotator-judge/</code>:
          </p>
          <pre className="code-block">
            {`# Generate rubric + mappings
python main.py generate \\
  --instruction_doc "path/to/instructions.pdf" \\
  --annotator-csv "data/annotator.csv" \\
  --golden-csv "data/golden.csv" \\
  -o output

# Batch evaluate (example: M1+M2+M3)
python batch_evaluate.py \\
  --annotator-csv "data/annotator.csv" \\
  --golden-csv "data/golden.csv" \\
  --mappings "output/..._mappings.json" \\
  --rubric "output/..._rubric.json" \\
  --use-llm \\
  -o output/results`}
          </pre>
        </div>

        <div className="card card-muted">
          <h2>Web integration</h2>
          <p className="tz-hint" style={{ margin: 0 }}>
            There is no HTTP route for this Python pipeline yet. To run it from the browser later, add a route in{' '}
            <code>server/</code> that uploads CSVs, spawns <code>python main.py</code> / <code>batch_evaluate.py</code>,
            and streams logs (similar to the Launchpad pipeline). This tab is reserved for that UI.
          </p>
        </div>
      </div>
    </section>
  )
}

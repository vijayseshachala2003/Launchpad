import { useState, useRef, useEffect } from 'react'

/** Matches Assessment Evaluation / Soul (GMT). Backend treats as UTC. */
const JUDGE_TIMEZONE = 'UTC'
const STAGE_PURPOSE = 'annotator_judge'
const GOLD_PURPOSE = 'annotator_judge'
const GOLD_REQUIRED_COLUMNS = [
  'subtask_id',
  'punt_a',
  'punt_a_priority',
  'instruction_a',
  'instruction_a_priority',
  'context_awareness_a',
  'context_awareness_a_priority',
  'relevance_a',
  'relevance_a_priority',
  'completeness_a',
  'completeness_a_priority',
  'writing_style_a',
  'writing_style_a_priority',
  'collab_a',
  'collab_a_priority',
  'factuality_a',
  'factuality_a_priority',
  'info_retrieval_a',
  'info_retrieval_a_priority',
  'code_a',
  'code_a_priority',
  'code_sequence_a',
  'code_sequence_a_priority',
  'code_output_a',
  'code_output_a_priority',
  'overall_a',
  'overall_a_priority',
  'punt_b',
  'punt_b_priority',
  'instruction_b',
  'instruction_b_priority',
  'context_awareness_b',
  'context_awareness_b_priority',
  'relevance_b',
  'relevance_b_priority',
  'completeness_b',
  'completeness_b_priority',
  'writing_style_b',
  'writing_style_b_priority',
  'collab_b',
  'collab_b_priority',
  'factuality_b',
  'factuality_b_priority',
  'info_retrieval_b',
  'info_retrieval_b_priority',
  'code_b',
  'code_b_priority',
  'code_sequence_b',
  'code_sequence_b_priority',
  'code_output_b',
  'code_output_b_priority',
  'overall_b',
  'overall_b_priority',
  'likert_scale',
  'likert_scale_priority',
]
const GOLD_TEMPLATE_HEADER = GOLD_REQUIRED_COLUMNS.join(',')

function toEndOfDayIfMidnight(iso) {
  if (!iso) return iso
  if (/T00:00(:00)?$/.test(iso)) return iso.replace(/T00:00(:00)?$/, 'T23:59:59')
  return iso
}

function expandEndOfDayMinutes(iso) {
  if (!iso) return iso
  if (/T23:59(:00)?$/.test(iso)) return iso.replace(/T23:59(:00)?$/, 'T23:59:59')
  return iso
}

const AJ_EXPORT_PARTS = [
  { which: 'annotator-input', label: 'Annotator input (.csv)' },
  { which: 'golden-input', label: 'Golden input (.csv)' },
  { which: 'evaluation-results', label: 'evaluation_results.json' },
  { which: 'summary-report', label: 'summary_report.txt' },
  { which: 'full-results', label: 'full_results.csv' },
]

async function downloadAjExport(apiBase, token, which, fallbackName) {
  const base = (apiBase || '').replace(/\/$/, '')
  const url = `${base}/api/annotator-judge/export/${token}/${which}`
  const res = await fetch(url, { credentials: 'include' })
  if (!res.ok) {
    const j = await res.json().catch(() => ({}))
    throw new Error(j.error || res.statusText)
  }
  const blob = await res.blob()
  const cd = res.headers.get('Content-Disposition')
  let name = fallbackName
  const m = cd && cd.match(/filename="?([^";]+)"?/)
  if (m) name = m[1]
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(a.href)
}

function downloadCsvTemplate(filename, headerLine, sampleLine = '') {
  const content = sampleLine ? `${headerLine}\n${sampleLine}\n` : `${headerLine}\n`
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(a.href)
}

/**
 * Annotator M1/M2/M3: Soul ingest, Supabase join to golden_datasets, batch_evaluate.py via Node.
 */
export default function AnnotatorJudgePanel() {
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [ingestBusy, setIngestBusy] = useState(false)
  const [ingestStatus, setIngestStatus] = useState('')
  const [ingestStatusClass, setIngestStatusClass] = useState('')

  const [maxRows, setMaxRows] = useState(0)
  const [skipIngest, setSkipIngest] = useState(false)
  const [useLlm, setUseLlm] = useState(false)
  const [batchSize, setBatchSize] = useState(5)
  const [downloadCsv, setDownloadCsv] = useState(true)
  const [rubricPath, setRubricPath] = useState('')
  const [pipelineBusy, setPipelineBusy] = useState(false)
  const [logLines, setLogLines] = useState([])
  const [pipeStatus, setPipeStatus] = useState('')
  const [pipeStatusClass, setPipeStatusClass] = useState('')
  const [csvToken, setCsvToken] = useState(null)
  const [downloadBusy, setDownloadBusy] = useState(null)
  const [stageIds, setStageIds] = useState([])
  const [stageIdInput, setStageIdInput] = useState('')
  const [stageBusy, setStageBusy] = useState(false)
  const [stageStatus, setStageStatus] = useState('')
  const [stageStatusClass, setStageStatusClass] = useState('')
  const [goldFile, setGoldFile] = useState(null)
  const [goldBusy, setGoldBusy] = useState(false)
  const [goldStatus, setGoldStatus] = useState('')
  const [goldStatusClass, setGoldStatusClass] = useState('')

  const logRef = useRef(null)
  const apiBase = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [logLines])

  const loadStageIds = async () => {
    setStageBusy(true)
    try {
      const res = await fetch(`${apiBase}/api/stage-ids?purpose=${STAGE_PURPOSE}`, {
        credentials: 'include',
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j.error || res.statusText)
      setStageIds(Array.isArray(j.stage_ids) ? j.stage_ids : [])
      setStageStatus('')
      setStageStatusClass('')
    } catch (e) {
      setStageStatus(String(e.message || e))
      setStageStatusClass('err')
    } finally {
      setStageBusy(false)
    }
  }

  useEffect(() => {
    loadStageIds()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBase])

  const addStageId = async () => {
    const id = stageIdInput.trim()
    if (!id) return
    setStageBusy(true)
    try {
      const res = await fetch(`${apiBase}/api/stage-ids`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, purpose: STAGE_PURPOSE }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j.error || res.statusText)
      setStageIdInput('')
      setStageStatus(`Added stage_id: ${id}`)
      setStageStatusClass('ok')
      await loadStageIds()
    } catch (e) {
      setStageStatus(String(e.message || e))
      setStageStatusClass('err')
    } finally {
      setStageBusy(false)
    }
  }

  const runIngestOnly = async () => {
    let from = dateFrom.trim()
    let to = expandEndOfDayMinutes(toEndOfDayIfMidnight(dateTo.trim()))
    if (!from || !to) {
      setIngestStatus('Set both from and to timestamps.')
      setIngestStatusClass('err')
      return
    }
    setIngestBusy(true)
    setIngestStatus('Ingesting…')
    setIngestStatusClass('')
    try {
      const res = await fetch(`${apiBase}/api/judge-ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date_from: from,
          date_to: to,
          timezone: JUDGE_TIMEZONE,
        }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) {
        setIngestStatus(j.error || res.statusText)
        setIngestStatusClass('err')
        return
      }
      const sf = j.soul_rows_fetched
      const ins = j.rows_inserted
      const sk = j.skipped_existing
      if (typeof sf === 'number') {
        setIngestStatus(
          `Ingest: ${sf} from Soul; ${ins ?? 0} inserted; ${sk ?? 0} already in DB (unchanged).`
        )
      } else {
        setIngestStatus('Done.')
      }
      setIngestStatusClass('ok')
    } catch (e) {
      setIngestStatus(String(e.message || e))
      setIngestStatusClass('err')
    } finally {
      setIngestBusy(false)
    }
  }

  const uploadAnnotatorGold = async () => {
    if (!goldFile) return
    setGoldBusy(true)
    try {
      const csvText = await goldFile.text()
      const res = await fetch(`${apiBase}/api/golden-datasets/bulk-upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ purpose: GOLD_PURPOSE, csv_text: csvText }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j.error || res.statusText)
      setGoldStatus(
        `Uploaded ${j.upserted_rows ?? 0} row(s) into ${j.target_table || 'golden_datasets'} for purpose "${
          j.purpose || GOLD_PURPOSE
        }" from ${goldFile.name}.`
      )
      setGoldStatusClass('ok')
      setGoldFile(null)
    } catch (e) {
      setGoldStatus(String(e.message || e))
      setGoldStatusClass('err')
    } finally {
      setGoldBusy(false)
    }
  }

  const runFullPipeline = async () => {
    let from = dateFrom.trim()
    let to = expandEndOfDayMinutes(toEndOfDayIfMidnight(dateTo.trim()))
    if (!from || !to) {
      setPipeStatus('Set both from and to timestamps.')
      setPipeStatusClass('err')
      return
    }

    setPipelineBusy(true)
    setPipeStatus('Running…')
    setPipeStatusClass('')
    setCsvToken(null)
    setLogLines([])

    try {
      const res = await fetch(`${apiBase}/api/annotator-judge-pipeline`, {
        method: 'POST',
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({
          date_from: from,
          date_to: to,
          timezone: JUDGE_TIMEZONE,
          max_rows: Number.isNaN(maxRows) ? 0 : maxRows,
          skip_ingest: skipIngest,
          use_llm: useLlm,
          batch_size: Number.isNaN(batchSize) ? 5 : batchSize,
          download_csv: downloadCsv,
          rubric_path: rubricPath.trim(),
        }),
      })

      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        setPipeStatus(j.error || res.statusText)
        setPipeStatusClass('err')
        setPipelineBusy(false)
        return
      }

      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      let failed = false

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const parts = buf.split('\n\n')
        buf = parts.pop() || ''
        for (const block of parts) {
          const line = block.replace(/^data:\s*/m, '').trim()
          if (!line) continue
          let ev
          try {
            ev = JSON.parse(line)
          } catch {
            continue
          }
          if (ev.type === 'log' && ev.message) {
            setLogLines((prev) => [...prev, ev.message])
          } else if (ev.type === 'error') {
            failed = true
            setPipeStatus(ev.message || 'Error')
            setPipeStatusClass('err')
          } else if (ev.type === 'done') {
            if (!failed) {
              setPipeStatus(
                ev.rows_evaluated != null
                  ? `Done. Evaluated ${ev.rows_evaluated} annotator row(s).`
                  : 'Done.'
              )
              setPipeStatusClass('ok')
            }
            if (ev.csv_download_token) setCsvToken(ev.csv_download_token)
          }
        }
      }
    } catch (e) {
      setPipeStatus(String(e.message || e))
      setPipeStatusClass('err')
    } finally {
      setPipelineBusy(false)
    }
  }

  return (
    <section className="section-panel" aria-labelledby="annotator-judge-heading">
      <div className="container">
        <h1 id="annotator-judge-heading">Annotator evaluation (M1 / M2 / M3)</h1>
        <p className="subtitle">
          <strong>1.</strong> Server queries Soul for your range; inserts only new <code>subtask_id</code> rows into{' '}
          <code>annotator_judge_table</code> (existing keys unchanged by ingest).<br />
          <strong>2.</strong> Join <code>golden_datasets</code>, run <code>batch_evaluate.py</code> (optional LLM for M2/M3).<br />
          <strong>3.</strong> Downloads optional. Same ingest rules as Assessment Evaluation (insert-only by natural key).
        </p>

        <div className="card">
          <h2>Ingest stage IDs (Annotator judge)</h2>
          <p className="tz-hint">
            Purpose: <code>{STAGE_PURPOSE}</code>. These IDs are used by Soul ingest for this tab.
          </p>
          <div className="field">
            <label htmlFor="stage-id-input-aj">Add stage_id</label>
            <input
              id="stage-id-input-aj"
              type="text"
              placeholder="Enter stage_id"
              value={stageIdInput}
              onChange={(e) => setStageIdInput(e.target.value)}
              disabled={stageBusy || ingestBusy || pipelineBusy}
            />
          </div>
          <div className="download-buttons">
            <button type="button" onClick={addStageId} disabled={stageBusy || !stageIdInput.trim()}>
              Add stage_id
            </button>
            <button type="button" onClick={loadStageIds} disabled={stageBusy}>
              Refresh list
            </button>
          </div>
          {stageStatus ? <p className={`status ${stageStatusClass}`}>{stageStatus}</p> : null}
          <div className="log" style={{ minHeight: 80 }}>
            {(stageIds.length ? stageIds : ['(no stage_ids configured)']).join('\n')}
          </div>
        </div>

        <div className="card">
          <h2>Bulk upload Annotator gold dataset</h2>
          <p className="tz-hint">
            Upload a CSV into <code>golden_datasets</code> with purpose <code>{GOLD_PURPOSE}</code>.
          </p>
          <div className="field">
            <label htmlFor="gold-annotator-file">CSV file</label>
            <input
              id="gold-annotator-file"
              type="file"
              accept=".csv,text/csv"
              disabled={goldBusy || ingestBusy || pipelineBusy}
              onChange={(e) => {
                const f = e.target.files && e.target.files[0] ? e.target.files[0] : null
                setGoldFile(f)
                setGoldStatus('')
                setGoldStatusClass('')
              }}
            />
          </div>
          <div className="download-buttons">
            <button
              type="button"
              onClick={uploadAnnotatorGold}
              disabled={!goldFile || goldBusy || ingestBusy || pipelineBusy}
            >
              {goldBusy ? 'Uploading…' : 'Upload annotator gold CSV'}
            </button>
            <button
              type="button"
              disabled={goldBusy || ingestBusy || pipelineBusy}
              onClick={() => downloadCsvTemplate('golden_datasets_template.csv', GOLD_TEMPLATE_HEADER)}
            >
              Download template
            </button>
          </div>
          <p className="tz-hint">
            Required columns (exact names): <code>{GOLD_REQUIRED_COLUMNS.join(', ')}</code>
          </p>
          <p className="tz-hint">
            Restrictions: every row needs non-empty <code>subtask_id</code>; rows upsert by{' '}
            <code>(purpose, subtask_id)</code>; existing rows are updated.
          </p>
          {goldStatus ? <p className={`status ${goldStatusClass}`}>{goldStatus}</p> : null}
        </div>

        <div className="card">
          <h2>Date range (UTC)</h2>
          <div className="field timezone-static-field">
            <span className="field-label-text">Timezone</span>
            <p className="timezone-static" aria-live="polite">
              <strong>GMT / UTC</strong> <span className="timezone-fixed-tag">(fixed)</span>
            </p>
          </div>
          <div className="field">
            <label htmlFor="judge-date-from">Created at — from</label>
            <input
              id="judge-date-from"
              type="datetime-local"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              disabled={ingestBusy || pipelineBusy}
            />
          </div>
          <div className="field">
            <label htmlFor="judge-date-to">Created at — to</label>
            <input
              id="judge-date-to"
              type="datetime-local"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              disabled={ingestBusy || pipelineBusy}
            />
          </div>
        </div>

        <div className="card">
          <h2>Soul ingest only</h2>
          <button type="button" onClick={runIngestOnly} disabled={ingestBusy || pipelineBusy}>
            {ingestBusy ? 'Ingesting…' : 'Run judge ingest'}
          </button>
          {ingestStatus ? <p className={`status ${ingestStatusClass}`}>{ingestStatus}</p> : null}
        </div>

        <div className="card">
          <h2>Full pipeline (ingest + M1/M2/M3)</h2>
          <div className="field">
            <label htmlFor="aj-max-rows">Max annotator rows (0 = no limit)</label>
            <input
              id="aj-max-rows"
              type="number"
              min={0}
              value={maxRows}
              onChange={(e) => setMaxRows(parseInt(e.target.value, 10) || 0)}
              disabled={pipelineBusy}
            />
          </div>
          <div className="field">
            <label htmlFor="aj-batch">LLM batch size (M2/M3)</label>
            <input
              id="aj-batch"
              type="number"
              min={1}
              max={20}
              value={batchSize}
              onChange={(e) => setBatchSize(parseInt(e.target.value, 10) || 5)}
              disabled={pipelineBusy}
            />
          </div>
          <div className="field">
            <label htmlFor="aj-rubric">Rubric JSON path (optional, repo-relative)</label>
            <input
              id="aj-rubric"
              type="text"
              placeholder="e.g. backend/annotator-judge/output/rubric.json"
              value={rubricPath}
              onChange={(e) => setRubricPath(e.target.value)}
              disabled={pipelineBusy}
            />
          </div>
          <div className="field checkbox-row">
            <input
              id="aj-skip-ingest"
              type="checkbox"
              checked={skipIngest}
              onChange={(e) => setSkipIngest(e.target.checked)}
              disabled={pipelineBusy}
            />
            <label htmlFor="aj-skip-ingest" style={{ margin: 0 }}>
              Skip Soul ingest — use existing rows in <code>annotator_judge_table</code> only
            </label>
          </div>
          <div className="field checkbox-row">
            <input
              id="aj-use-llm"
              type="checkbox"
              checked={useLlm}
              onChange={(e) => setUseLlm(e.target.checked)}
              disabled={pipelineBusy}
            />
            <label htmlFor="aj-use-llm" style={{ margin: 0 }}>
              Run M2 (and M3 if rubric path resolves)
            </label>
          </div>
          <div className="field checkbox-row">
            <input
              id="aj-download"
              type="checkbox"
              checked={downloadCsv}
              onChange={(e) => setDownloadCsv(e.target.checked)}
              disabled={pipelineBusy}
            />
            <label htmlFor="aj-download" style={{ margin: 0 }}>
              Enable browser downloads after success
            </label>
          </div>
          <button type="button" onClick={runFullPipeline} disabled={pipelineBusy}>
            {pipelineBusy ? 'Running…' : 'Run full annotator judge pipeline'}
          </button>
          {pipeStatus ? <p className={`status ${pipeStatusClass}`}>{pipeStatus}</p> : null}
          <div className="log" ref={logRef}>
            {logLines.join('\n')}
          </div>
          {csvToken && (
            <div className="download-section" style={{ marginTop: '1rem' }}>
              <h3>Downloads</h3>
              <div className="download-buttons">
                {AJ_EXPORT_PARTS.map(({ which, label }) => (
                  <button
                    key={which}
                    type="button"
                    disabled={downloadBusy === which}
                    onClick={async () => {
                      setDownloadBusy(which)
                      try {
                        await downloadAjExport(apiBase, csvToken, which, label.replace(/\s+/g, '_'))
                      } catch (err) {
                        setPipeStatus(String(err.message || err))
                        setPipeStatusClass('err')
                      } finally {
                        setDownloadBusy(null)
                      }
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <p className="tz-hint" style={{ marginTop: '0.5rem' }}>
                <code>full_results.csv</code> appears only after a successful run with output files present.
              </p>
            </div>
          )}
        </div>

        <div className="card">
          <h2>CLI (advanced)</h2>
          <p className="tz-hint" style={{ marginBottom: '0.75rem' }}>
            <code>backend/annotator-judge/config/ae_v1_mappings.json</code> is used by the web pipeline. For custom
            rubrics, run <code>main.py generate</code> locally.
          </p>
          <pre className="code-block">
            {`cd backend/annotator-judge
pip install -r requirements.txt
python batch_evaluate.py \\
  --annotator-csv path/to/ann.csv \\
  --golden-csv path/to/gold.csv \\
  --mappings config/ae_v1_mappings.json \\
  -o output/run1 \\
  --use-llm`}
          </pre>
        </div>
      </div>
    </section>
  )
}

import { useState, useRef, useEffect } from 'react'

/** Fixed for Assessment Evaluation — matches Metabase / Soul (GMT). Backend treats as UTC. */
const ASSESSMENT_TIMEZONE = 'UTC'
const STAGE_PURPOSE = 'launchpad_eval'
const GOLD_PURPOSE = 'Launchpad - eval'
const GOLD_REQUIRED_COLUMNS = ['uniqueid', 'q1_label', 'q2_label', 'q3_label', 'q4_label', 'q5_label']
const GOLD_TEMPLATE_HEADER = GOLD_REQUIRED_COLUMNS.join(',')
const GOLD_TEMPLATE_SAMPLE = 'sample_uniqueid,sample_q1,sample_q2,sample_q3,sample_q4,sample_q5'

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

const EXPORT_PARTS = [
  { which: 'eval-summary', label: 'Eval summary — pre-filled + S1/S2/S3 + selected (.csv)' },
  { which: 'section2-input', label: 'Section 2 input (.csv)' },
  { which: 'section3-input', label: 'Section 3 input (.csv)' },
  { which: 'section2-output', label: 'Section 2 judge output (.csv)' },
  { which: 'section3-output', label: 'Section 3 judge output (.csv)' },
  { which: 'summary', label: 'Run summary (.json)' },
]

async function downloadExport(apiBase, token, which, fallbackName) {
  const base = (apiBase || '').replace(/\/$/, '')
  const url = `${base}/api/pipeline/export/${token}/${which}`
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

/** Soul → Supabase → Section 2 & 3 judges (Launchpad pipeline). */
export default function AssessmentEvaluation() {
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [maxRows, setMaxRows] = useState(50)
  const [thresholdScore, setThresholdScore] = useState('3.00')
  const [section1Threshold, setSection1Threshold] = useState('3.00')
  const [skipIngest, setSkipIngest] = useState(false)
  const [downloadCsv, setDownloadCsv] = useState(true)
  const [csvToken, setCsvToken] = useState(null)
  const [downloadBusy, setDownloadBusy] = useState(null)
  const [logLines, setLogLines] = useState([])
  const [progS2, setProgS2] = useState({ current: 0, total: 0 })
  const [progS3, setProgS3] = useState({ current: 0, total: 0 })
  const [status, setStatus] = useState('')
  const [statusClass, setStatusClass] = useState('')
  const [running, setRunning] = useState(false)
  const [showProgress, setShowProgress] = useState(false)
  const [section1Summary, setSection1Summary] = useState(null)
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

  const appendLog = (line) => {
    setLogLines((prev) => [...prev, line])
  }

  const uploadLaunchpadGold = async () => {
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
        `Uploaded ${j.upserted_rows ?? 0} row(s) into ${j.target_table || 'golden_datasets_assessments'} for purpose "${
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

  const runPipeline = async () => {
    let from = dateFrom.trim()
    let to = expandEndOfDayMinutes(toEndOfDayIfMidnight(dateTo.trim()))
    if (!from || !to) {
      setStatus('Set both from and to timestamps.')
      setStatusClass('err')
      return
    }

    const threshold = Number.parseFloat(String(thresholdScore).trim())
    const sec1Threshold = Number.parseFloat(String(section1Threshold).trim())
    if (!Number.isFinite(threshold)) {
      setStatus('Set a valid decimal final score threshold (for example: 3.25).')
      setStatusClass('err')
      return
    }
    if (!Number.isFinite(sec1Threshold)) {
      setStatus('Set a valid decimal Section 1 threshold (for example: 3.00).')
      setStatusClass('err')
      return
    }

    setRunning(true)
    setStatus('Running…')
    setStatusClass('')
    setCsvToken(null)
    setLogLines([])
    setSection1Summary(null)
    setShowProgress(true)
    setProgS2({ current: 0, total: 0 })
    setProgS3({ current: 0, total: 0 })

    try {
      const res = await fetch(`${apiBase}/api/pipeline`, {
        method: 'POST',
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({
          date_from: from,
          date_to: to,
          timezone: ASSESSMENT_TIMEZONE,
          max_rows: Number.isNaN(maxRows) ? 0 : maxRows,
          skip_ingest: skipIngest,
          download_csv: downloadCsv,
          threshold_score: threshold,
          section1_threshold: sec1Threshold,
        }),
      })

      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        setStatus(j.error || res.statusText)
        setStatusClass('err')
        setRunning(false)
        return
      }

      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      let failed = false
      let gotDone = false

      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() || ''
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          try {
            const ev = JSON.parse(line.slice(6))
            if (ev.type === 'log') appendLog(ev.message)
            else if (ev.type === 'section1-summary') {
              setSection1Summary({
                updated: ev.updated_rows ?? 0,
                compared: ev.compared_rows ?? 0,
                avgTotal: ev.avg_total ?? 0,
                perfect: ev.perfect_rows ?? 0,
                purpose: ev.purpose || 'Launchpad - eval',
              })
            }
            else if (ev.type === 'progress') {
              if (ev.section === 's2') setProgS2({ current: ev.current, total: ev.total })
              else setProgS3({ current: ev.current, total: ev.total })
            } else if (ev.type === 'error') {
              appendLog('ERROR: ' + ev.message)
              failed = true
              setStatus(ev.message)
              setStatusClass('err')
            } else if (ev.type === 'done') {
              gotDone = true
              if (ev.csv_download_token) {
                setCsvToken(ev.csv_download_token)
                appendLog(
                  `Done. Rows: ${ev.rows_evaluated}. Use the download buttons below for CSV/JSON files (links expire in ~1 hour).`
                )
              } else {
                appendLog(
                  `Done. Rows: ${ev.rows_evaluated}. Server paths: ${ev.sec2_output || ''} | ${ev.sec3_output || ''}`
                )
              }
              if (!failed) {
                setStatus('Pipeline finished. Supabase updated.')
                setStatusClass('ok')
              }
            }
          } catch (_) {}
        }
      }

      if (!gotDone && !failed) {
        setStatus('Finished.')
        setStatusClass('ok')
      }
    } catch (e) {
      setStatus(e.message || 'Request failed')
      setStatusClass('err')
      appendLog(String(e))
    } finally {
      setRunning(false)
    }
  }

  const pctS2 = progS2.total ? Math.round((progS2.current / progS2.total) * 100) : 0
  const pctS3 = progS3.total ? Math.round((progS3.current / progS3.total) * 100) : 0

  return (
    <section className="section-panel" aria-labelledby="assessment-heading">
      <div className="container">
        <h1 id="assessment-heading">Assessment Evaluation</h1>
        <p className="subtitle">
          <strong>1.</strong> Server queries Soul for your date range; inserts only rows whose <code>uniqueid</code> is not
          already in <code>new_evaluation_table</code> (existing rows unchanged by ingest). Optional skip Soul step.<br />
          <strong>2.</strong> Load rows in the time range, run <strong>Section 2</strong> and{' '}
          <strong>Section 3</strong> judges <strong>in parallel</strong>.<br />
          <strong>3.</strong> Write judge scores back to <code>new_evaluation_table</code>.
        </p>

        <div className="card">
          <h2>Ingest stage IDs (Launchpad evaluation)</h2>
          <p className="tz-hint">
            Purpose: <code>{STAGE_PURPOSE}</code>. These IDs are used by Soul ingest for this tab.
          </p>
          <div className="field">
            <label htmlFor="stage-id-input-eval">Add stage_id</label>
            <input
              id="stage-id-input-eval"
              type="text"
              placeholder="Enter stage_id"
              value={stageIdInput}
              onChange={(e) => setStageIdInput(e.target.value)}
              disabled={stageBusy}
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
          <h2>Bulk upload Launchpad gold dataset</h2>
          <p className="tz-hint">
            Upload a CSV into <code>golden_datasets_assessments</code> with purpose <code>{GOLD_PURPOSE}</code>.
          </p>
          <div className="field">
            <label htmlFor="gold-launchpad-file">CSV file</label>
            <input
              id="gold-launchpad-file"
              type="file"
              accept=".csv,text/csv"
              disabled={goldBusy || running}
              onChange={(e) => {
                const f = e.target.files && e.target.files[0] ? e.target.files[0] : null
                setGoldFile(f)
                setGoldStatus('')
                setGoldStatusClass('')
              }}
            />
          </div>
          <div className="download-buttons">
            <button type="button" onClick={uploadLaunchpadGold} disabled={!goldFile || goldBusy || running}>
              {goldBusy ? 'Uploading…' : 'Upload launchpad gold CSV'}
            </button>
            <button
              type="button"
              disabled={goldBusy || running}
              onClick={() =>
                downloadCsvTemplate(
                  'golden_datasets_assessments_template.csv',
                  GOLD_TEMPLATE_HEADER,
                  GOLD_TEMPLATE_SAMPLE
                )
              }
            >
              Download template
            </button>
          </div>
          <p className="tz-hint">
            Required columns (exact names): <code>{GOLD_REQUIRED_COLUMNS.join(', ')}</code>
          </p>
          <p className="tz-hint">
            Restrictions: every row needs non-empty <code>uniqueid</code>; rows upsert by{' '}
            <code>uniqueid</code>; existing rows are updated.
          </p>
          {goldStatus ? <p className={`status ${goldStatusClass}`}>{goldStatus}</p> : null}
        </div>

        <div className="card">
          <h2>Run</h2>

          <div className="field timezone-static-field">
            <span className="field-label-text">Timezone</span>
            <p className="timezone-static" aria-live="polite">
              <strong>GMT / UTC</strong> <span className="timezone-fixed-tag">(fixed)</span>
            </p>
            <p className="tz-hint">
              From/to below are interpreted as wall time in GMT/UTC to align with Metabase and Soul data.
            </p>
          </div>

          <div className="field">
            <label htmlFor="date-from">Created at — from</label>
            <input
              id="date-from"
              type="datetime-local"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="date-to">Created at — to</label>
            <input
              id="date-to"
              type="datetime-local"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="max-rows">Max rows to evaluate (0 = no limit)</label>
            <input
              id="max-rows"
              type="number"
              min={0}
              value={maxRows}
              onChange={(e) => setMaxRows(parseInt(e.target.value, 10) || 0)}
            />
          </div>
          <div className="field">
            <label htmlFor="threshold-score">Post-eval threshold score</label>
            <input
              id="threshold-score"
              type="number"
              step="0.01"
              min={0}
              value={thresholdScore}
              onChange={(e) => setThresholdScore(e.target.value)}
            />
            <p className="tz-hint">
              Final score uses weighted average. This is the overall threshold for post-eval decisioning.
            </p>
          </div>
          <div className="field">
            <label htmlFor="section1-threshold">Section 1 threshold</label>
            <input
              id="section1-threshold"
              type="number"
              step="0.01"
              min={0}
              value={section1Threshold}
              onChange={(e) => setSection1Threshold(e.target.value)}
            />
            <p className="tz-hint">
              <code>SELECTED</code> only if <strong>both</strong> conditions are met: section1_total is greater than or
              equal to Section 1 threshold and final_score is greater than or equal to post-eval threshold; otherwise{' '}
              <code>REJECTED</code>.
            </p>
          </div>
          <div className="field checkbox-row">
            <input
              id="skip-ingest"
              type="checkbox"
              checked={skipIngest}
              onChange={(e) => setSkipIngest(e.target.checked)}
            />
            <label htmlFor="skip-ingest" style={{ margin: 0 }}>
              Skip Soul ingest — use existing rows in <code>new_evaluation_table</code> only
            </label>
          </div>
          <div className="field checkbox-row">
            <input
              id="download-csv"
              type="checkbox"
              checked={downloadCsv}
              onChange={(e) => setDownloadCsv(e.target.checked)}
            />
            <label htmlFor="download-csv" style={{ margin: 0 }}>
              After a successful run, enable browser downloads for pipeline CSVs and a JSON run summary
            </label>
          </div>

          <button type="button" onClick={runPipeline} disabled={running}>
            Run pipeline
          </button>
          <p className={`status ${statusClass}`}>{status}</p>

          {section1Summary && (
            <div className="download-section">
              <h3>Section 1 summary</h3>
              <p>
                Purpose: <code>{section1Summary.purpose}</code>
              </p>
              <p>
                Compared <strong>{section1Summary.compared}</strong> row(s), updated{' '}
                <strong>{section1Summary.updated}</strong>, average total{' '}
                <strong>{Number(section1Summary.avgTotal).toFixed(2)}</strong>, perfect 5/5:{' '}
                <strong>{section1Summary.perfect}</strong>.
              </p>
            </div>
          )}

          {csvToken && (
            <div className="download-section">
              <h3>Download pipeline files</h3>
              <p>
                Judge inputs/outputs and a small JSON summary. Same files also remain on the server under{' '}
                <code>backend/scripts/</code> for debugging.
              </p>
              <div className="download-buttons">
                {EXPORT_PARTS.map(({ which, label }) => (
                  <button
                    key={which}
                    type="button"
                    disabled={downloadBusy === which}
                    onClick={async () => {
                      setDownloadBusy(which)
                      try {
                        const fallback =
                          which === 'summary' ? 'pipeline-run-summary.json' : `${which}.csv`
                        await downloadExport(apiBase, csvToken, which, fallback)
                      } catch (e) {
                        appendLog(`Download failed (${which}): ${e.message}`)
                      } finally {
                        setDownloadBusy(null)
                      }
                    }}
                  >
                    {downloadBusy === which ? '…' : label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {showProgress && (
            <div className="progress-row">
              <div>
                <div className="prog-label">Section 2</div>
                <div className="progress-bar">
                  <div className="progress-bar-fill" style={{ width: `${pctS2}%` }} />
                </div>
                <div className="prog-text">
                  {progS2.current} / {progS2.total} rows
                </div>
              </div>
              <div>
                <div className="prog-label">Section 3</div>
                <div className="progress-bar">
                  <div className="progress-bar-fill" style={{ width: `${pctS3}%` }} />
                </div>
                <div className="prog-text">
                  {progS3.current} / {progS3.total} rows
                </div>
              </div>
            </div>
          )}

          <div className="log" ref={logRef}>
            {logLines.join('\n')}
          </div>
        </div>
      </div>
    </section>
  )
}

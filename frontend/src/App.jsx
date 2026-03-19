import { useState, useRef, useEffect } from 'react'

const TIMEZONES = [
  { value: 'UTC', label: 'GMT (UTC)' },
  { value: 'America/New_York', label: 'America/New_York (ET)' },
  { value: 'America/Chicago', label: 'America/Chicago (CT)' },
  { value: 'America/Denver', label: 'America/Denver (MT)' },
  { value: 'America/Los_Angeles', label: 'America/Los_Angeles (PT)' },
  { value: 'Europe/London', label: 'Europe/London' },
  { value: 'Asia/Kolkata', label: 'Asia/Kolkata (IST)' },
  { value: 'Asia/Tokyo', label: 'Asia/Tokyo' },
  { value: 'Australia/Sydney', label: 'Australia/Sydney' },
]

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

export default function App() {
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [timezone, setTimezone] = useState('UTC')
  const [maxRows, setMaxRows] = useState(50)
  const [skipIngest, setSkipIngest] = useState(false)
  const [logLines, setLogLines] = useState([])
  const [progS2, setProgS2] = useState({ current: 0, total: 0 })
  const [progS3, setProgS3] = useState({ current: 0, total: 0 })
  const [status, setStatus] = useState('')
  const [statusClass, setStatusClass] = useState('')
  const [running, setRunning] = useState(false)
  const [showProgress, setShowProgress] = useState(false)
  const logRef = useRef(null)

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [logLines])

  const appendLog = (line) => {
    setLogLines((prev) => [...prev, line])
  }

  const runPipeline = async () => {
    let from = dateFrom.trim()
    let to = expandEndOfDayMinutes(toEndOfDayIfMidnight(dateTo.trim()))
    if (!from || !to) {
      setStatus('Set both from and to timestamps.')
      setStatusClass('err')
      return
    }

    setRunning(true)
    setStatus('Running…')
    setStatusClass('')
    setLogLines([])
    setShowProgress(true)
    setProgS2({ current: 0, total: 0 })
    setProgS3({ current: 0, total: 0 })

    try {
      const res = await fetch('/api/pipeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date_from: from,
          date_to: to,
          timezone,
          max_rows: Number.isNaN(maxRows) ? 0 : maxRows,
          skip_ingest: skipIngest,
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
              appendLog(
                `Done. Rows: ${ev.rows_evaluated}. Outputs: ${ev.sec2_output || ''} | ${ev.sec3_output || ''}`
              )
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
    <div className="container">
      <h1>Launchpad Eval Pipeline</h1>
      <p className="subtitle">
        <strong>1.</strong> Ingest from Soul API into Supabase (optional skip).<br />
        <strong>2.</strong> Load rows in the time range, run <strong>Section 2</strong> and{' '}
        <strong>Section 3</strong> judges <strong>in parallel</strong> (multi-threaded).<br />
        <strong>3.</strong> Write scores to <code>new_evaluation_table</code>.
      </p>

      <div className="card">
        <h2>Run</h2>

        <div className="field">
          <label htmlFor="tz-filter">Timezone (data is in GMT)</label>
          <select
            id="tz-filter"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            aria-describedby="tz-hint"
          >
            {TIMEZONES.map((tz) => (
              <option key={tz.value} value={tz.value}>
                {tz.label}
              </option>
            ))}
          </select>
          <p id="tz-hint" className="tz-hint">
            From/to are in GMT. Leave as GMT (UTC) to match Metabase/Soul data.
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
        <div className="field checkbox-row">
          <input
            id="skip-ingest"
            type="checkbox"
            checked={skipIngest}
            onChange={(e) => setSkipIngest(e.target.checked)}
          />
          <label htmlFor="skip-ingest" style={{ margin: 0 }}>
            Skip ingest — only read from Supabase and judge (rows already in DB)
          </label>
        </div>

        <button type="button" onClick={runPipeline} disabled={running}>
          Run pipeline
        </button>
        <p className={`status ${statusClass}`}>{status}</p>

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
  )
}

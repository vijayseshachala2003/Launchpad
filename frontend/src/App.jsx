import { useState } from 'react'
import AssessmentEvaluation from './AssessmentEvaluation.jsx'
import AnnotatorJudgePanel from './AnnotatorJudgePanel.jsx'

export default function App() {
  const [section, setSection] = useState('assessment')

  return (
    <div className="app-shell">
      <aside className="app-sidebar" aria-label="Section switcher">
        <p className="app-brand">Launchpad Eval</p>
        <h2 className="app-sidebar-heading">Sections</h2>
        <nav className="app-nav" aria-label="Primary">
          <button
            type="button"
            className={section === 'assessment' ? 'nav-btn active' : 'nav-btn'}
            onClick={() => setSection('assessment')}
          >
            <span className="nav-title">Assessment Evaluation</span>
            <span className="nav-subtitle">Section 2 + Section 3 pipeline</span>
          </button>
          <button
            type="button"
            className={section === 'annotator-judge' ? 'nav-btn active' : 'nav-btn'}
            onClick={() => setSection('annotator-judge')}
          >
            <span className="nav-title">Annotator Judge</span>
            <span className="nav-subtitle">M1 / M2 / M3 against gold labels</span>
          </button>
        </nav>
      </aside>

      <main className="app-main">
        {section === 'assessment' && <AssessmentEvaluation />}
        {section === 'annotator-judge' && <AnnotatorJudgePanel />}
      </main>
    </div>
  )
}

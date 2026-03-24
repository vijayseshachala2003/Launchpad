import { useState } from 'react'
import AssessmentEvaluation from './AssessmentEvaluation.jsx'
import AnnotatorJudgePanel from './AnnotatorJudgePanel.jsx'

export default function App() {
  const [section, setSection] = useState('assessment')

  return (
    <div className="app-shell">
      <header className="app-header">
        <p className="app-brand">Launchpad Eval</p>
        <nav className="app-nav" aria-label="Primary">
          <button
            type="button"
            className={section === 'assessment' ? 'nav-btn active' : 'nav-btn'}
            onClick={() => setSection('assessment')}
          >
            Assessment Evaluation
          </button>
          <button
            type="button"
            className={section === 'annotator-judge' ? 'nav-btn active' : 'nav-btn'}
            onClick={() => setSection('annotator-judge')}
          >
            Annotator Judge (M1/M2/M3)
          </button>
        </nav>
      </header>

      <main className="app-main">
        {section === 'assessment' && <AssessmentEvaluation />}
        {section === 'annotator-judge' && <AnnotatorJudgePanel />}
      </main>
    </div>
  )
}

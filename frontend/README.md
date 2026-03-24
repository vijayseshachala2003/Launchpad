# Frontend (React + Vite)

**Client-side only** — runs in the browser. The **server** app lives in **`../server/`** (Node.js); Python judges and env live in **`../backend/`**.

See **[root README.md](../README.md)** for the full three-folder map.

| Path | Purpose |
|------|---------|
| `index.html` | Vite entry |
| `src/main.jsx` | React root |
| `src/App.jsx` | Tabs: Assessment Evaluation vs Annotator Judge |
| `src/AssessmentEvaluation.jsx` | Launchpad pipeline + SSE |
| `src/AnnotatorJudgePanel.jsx` | Docs for `backend/annotator-judge/` |
| `src/index.css` | Styles |
| `vite.config.js` | Proxies **`/api`** → `http://127.0.0.1:5050` |
| `.env.example` | Copy to `.env` for optional `VITE_API_BASE_URL` |

**Dev:** `npm install && npm run dev` → http://127.0.0.1:5173 — run **`../server`** with `npm start` on port **5050**.

**Build:** `npm run build` → `dist/`. **`server/`** serves `dist/` in production.

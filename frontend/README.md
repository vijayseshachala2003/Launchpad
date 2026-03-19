# Frontend (React + Vite)

Client-side rendered pipeline UI. Same behavior as before: timezone, date range, max rows, skip ingest, run pipeline, SSE log and progress.

| Path           | Purpose                    |
|----------------|----------------------------|
| `index.html`   | Vite entry                 |
| `src/main.jsx` | React root                 |
| `src/App.jsx`  | Pipeline form + SSE logic  |
| `src/index.css`| Styles                     |
| `vite.config.js` | Dev proxy `/api` → Flask |

**Dev:** `npm install && npm run dev` → http://127.0.0.1:5173 (run backend on 5050).

**Build:** `npm run build` → `dist/`. Flask serves `dist/` when present.

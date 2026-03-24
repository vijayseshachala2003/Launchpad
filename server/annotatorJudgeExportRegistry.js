import { randomBytes } from 'crypto';
import { readFile } from 'fs/promises';
import path from 'path';

/** @type {Map<string, { scriptsRoot: string, files: Record<string, string>, expires: number }>} */
const store = new Map();

const DEFAULT_TTL_MS = 60 * 60 * 1000;

function isUnderDir(filePath, dir) {
  const r = path.resolve(filePath);
  const d = path.resolve(dir);
  return r === d || r.startsWith(d + path.sep);
}

/**
 * @param {string} scriptsRoot - Absolute path to backend/scripts (all artifact paths must live under here)
 * @param {{ annotatorCsv: string, goldenCsv: string, resultsJson: string, summaryTxt: string, fullResultsCsv?: string }} files
 */
export function registerAnnotatorJudgeExports(scriptsRoot, files, ttlMs = DEFAULT_TTL_MS) {
  const token = randomBytes(24).toString('hex');
  const root = path.resolve(scriptsRoot);
  const expires = Date.now() + ttlMs;
  store.set(token, {
    scriptsRoot: root,
    files: {
      'annotator-input': files.annotatorCsv,
      'golden-input': files.goldenCsv,
      'evaluation-results': files.resultsJson,
      'summary-report': files.summaryTxt,
      ...(files.fullResultsCsv ? { 'full-results': files.fullResultsCsv } : {}),
    },
    expires,
  });
  setTimeout(() => store.delete(token), ttlMs);
  return token;
}

/**
 * @param {string} which - annotator-input | golden-input | evaluation-results | summary-report | full-results
 */
export async function serveAnnotatorJudgeExport(token, which) {
  const e = store.get(token);
  if (!e || Date.now() > e.expires) {
    return { status: 404, error: 'Invalid or expired download link.' };
  }

  const filePath = e.files[which];
  if (!filePath) return { status: 404, error: 'Unknown file.' };

  if (!isUnderDir(filePath, e.scriptsRoot)) {
    return { status: 403, error: 'Forbidden path.' };
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType =
    ext === '.json'
      ? 'application/json; charset=utf-8'
      : ext === '.txt'
        ? 'text/plain; charset=utf-8'
        : 'text/csv; charset=utf-8';

  try {
    const body = await readFile(path.resolve(filePath));
    const base = path.basename(filePath);
    return {
      status: 200,
      contentType,
      disposition: `attachment; filename="${base}"`,
      body,
    };
  } catch {
    return { status: 404, error: 'File not found.' };
  }
}

import { randomBytes } from 'crypto';
import { readFile } from 'fs/promises';
import path from 'path';

/** @type {Map<string, { scriptDir: string, sec2In: string, sec3In: string, sec2Out: string, sec3Out: string, summary: string | null, expires: number }>} */
const store = new Map();

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour

function isUnderDir(filePath, dir) {
  const r = path.resolve(filePath);
  const d = path.resolve(dir);
  return r === d || r.startsWith(d + path.sep);
}

/**
 * @param {string} scriptsDir - Absolute path to backend/scripts (for path validation)
 * @param {{ sec2In: string, sec3In: string, sec2Out: string, sec3Out: string, summary: string | null }} files
 * @param {number} [ttlMs]
 * @returns {string} token
 */
export function registerPipelineExports(scriptsDir, files, ttlMs = DEFAULT_TTL_MS) {
  const token = randomBytes(24).toString('hex');
  const expires = Date.now() + ttlMs;
  store.set(token, {
    scriptDir: path.resolve(scriptsDir),
    sec2In: files.sec2In,
    sec3In: files.sec3In,
    sec2Out: files.sec2Out,
    sec3Out: files.sec3Out,
    summary: files.summary,
    expires,
  });
  setTimeout(() => store.delete(token), ttlMs);
  return token;
}

/**
 * @param {string} token
 * @param {string} which - section2-input | section3-input | section2-output | section3-output | summary
 * @returns {Promise<{ status: number, error?: string, contentType?: string, disposition?: string, body?: Buffer }>}
 */
export async function serveExport(token, which) {
  const e = store.get(token);
  if (!e || Date.now() > e.expires) {
    return { status: 404, error: 'Invalid or expired download link.' };
  }

  if (which === 'summary') {
    if (e.summary == null) return { status: 404, error: 'No summary for this export.' };
    return {
      status: 200,
      contentType: 'application/json; charset=utf-8',
      disposition: 'attachment; filename="pipeline-run-summary.json"',
      body: Buffer.from(e.summary, 'utf8'),
    };
  }

  const map = {
    'section2-input': e.sec2In,
    'section3-input': e.sec3In,
    'section2-output': e.sec2Out,
    'section3-output': e.sec3Out,
  };
  const filePath = map[which];
  if (!filePath) return { status: 404, error: 'Unknown file.' };

  if (!isUnderDir(filePath, e.scriptDir)) {
    return { status: 403, error: 'Forbidden path.' };
  }

  try {
    const body = await readFile(path.resolve(filePath));
    const base = path.basename(filePath);
    return {
      status: 200,
      contentType: 'text/csv; charset=utf-8',
      disposition: `attachment; filename="${base}"`,
      body,
    };
  } catch {
    return { status: 404, error: 'File not found.' };
  }
}

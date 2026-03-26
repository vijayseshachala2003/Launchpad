import pg from 'pg';
import { getPostgresConfig } from './db.js';

const { Client } = pg;

export const STAGE_ID_PURPOSE = {
  LAUNCHPAD_EVAL: 'launchpad_eval',
  ANNOTATOR_JUDGE: 'annotator_judge',
};

function isValidPurpose(purpose) {
  return Object.values(STAGE_ID_PURPOSE).includes(purpose);
}

function normalizeStageId(stageId) {
  const id = String(stageId || '').trim();
  if (!/^stc_[A-Za-z0-9]+$/.test(id)) {
    throw new Error('Invalid stage_id format. Expected value like stc_260218173538143LSI2M.');
  }
  return id;
}

export async function listStageIdsByPurpose(purpose) {
  if (!isValidPurpose(purpose)) {
    throw new Error(`Invalid purpose "${purpose}".`);
  }
  const client = new Client(getPostgresConfig());
  await client.connect();
  try {
    const res = await client.query(
      `SELECT id, purpose
       FROM stage_ids
       WHERE purpose = $1
       ORDER BY id`,
      [purpose]
    );
    return res.rows;
  } finally {
    await client.end();
  }
}

export async function addStageId(stageId, purpose) {
  if (!isValidPurpose(purpose)) {
    throw new Error(`Invalid purpose "${purpose}".`);
  }
  const id = normalizeStageId(stageId);
  const client = new Client(getPostgresConfig());
  await client.connect();
  try {
    await client.query(
      `INSERT INTO stage_ids (id, purpose)
       VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET purpose = EXCLUDED.purpose`,
      [id, purpose]
    );
    return { id, purpose };
  } finally {
    await client.end();
  }
}

export async function getRequiredStageIds(purpose) {
  const rows = await listStageIdsByPurpose(purpose);
  const ids = rows.map((r) => String(r.id || '').trim()).filter(Boolean);
  if (!ids.length) {
    throw new Error(`No stage_ids configured for purpose "${purpose}". Add at least one stage_id first.`);
  }
  return ids;
}

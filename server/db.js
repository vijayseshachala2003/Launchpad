import pg from 'pg';

const { Client } = pg;

export function getPostgresConfig() {
  let host = (process.env.SUPABASE_DB_HOST || '').trim().replace(/\/+$/, '');
  if (host.startsWith('http://') || host.startsWith('https://')) {
    try {
      host = new URL(host).hostname;
    } catch (_) {}
  }
  if (host.endsWith('.supabase.co') && !host.startsWith('db.')) {
    host = 'db.' + host;
  }
  return {
    host,
    port: parseInt(process.env.SUPABASE_DB_PORT || '5432', 10),
    database: process.env.SUPABASE_DB_NAME || 'postgres',
    user: process.env.SUPABASE_DB_USER,
    password: process.env.SUPABASE_DB_PASSWORD,
    ssl: { rejectUnauthorized: true },
  };
}

/**
 * @param {string} dateFrom - UTC ISO
 * @param {string} dateTo - UTC ISO
 * @param {number} maxRows
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export async function fetchRowsForRange(dateFrom, dateTo, maxRows) {
  const client = new Client(getPostgresConfig());
  await client.connect();
  try {
    let sql = `
      SELECT uniqueid, email, initialvalue_prompt, initialvalue_ai_response,
             section_2_instruction, task_1_response, task_2_response, task_3_response,
             initialvalue_scenario, initialvalue_sec_3_qn, section_3_instruction, sec_3_ans
      FROM new_evaluation_table
      WHERE created_at >= $1::timestamptz AND created_at <= $2::timestamptz
      ORDER BY created_at
    `;
    const args = [dateFrom, dateTo];
    if (maxRows && maxRows > 0) {
      sql += ' LIMIT $3';
      args.push(maxRows);
    }
    const res = await client.query(sql, args);
    return res.rows;
  } finally {
    await client.end();
  }
}

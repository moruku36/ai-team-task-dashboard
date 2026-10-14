// One canonical document, row lock and atomic commit: independent instances serialize writes.
import { emptyBoard } from './model.mjs';
export class PostgresStore {
  constructor(pool) { this.pool = pool; }
  async read() {
    const { rows } = await this.pool.query('SELECT document FROM dashboard_state WHERE id = 1');
    if (!rows.length) throw new Error('Schema not initialized');
    return rows[0].document;
  }
  async readQuota() {
    const { rows } = await this.pool.query("SELECT document->'quota' AS quota FROM dashboard_state WHERE id = 1");
    return rows[0]?.quota ?? { records: [] };
  }
  async transaction(change) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query('SELECT document FROM dashboard_state WHERE id = 1 FOR UPDATE');
      if (!rows.length) throw new Error('Schema not initialized');
      const document = rows[0].document;
      const result = change(document);
      await client.query('UPDATE dashboard_state SET document = $1::jsonb WHERE id = 1', [JSON.stringify(document)]);
      await client.query('COMMIT');
      return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
}
export async function connectStore(env = process.env) {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL required');
  const url = new URL(env.DATABASE_URL);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Postgres required');
  // pg connection-string SSL options can override strict options: reject them explicitly.
  for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) url.searchParams.delete(key);
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: url.href, ssl: { rejectUnauthorized: true },
    max: 2, connectionTimeoutMillis: 10000, idleTimeoutMillis: 10000 });
  return new PostgresStore(pool);
}
export async function initialize(store) {
  await store.pool.query('CREATE TABLE IF NOT EXISTS dashboard_state (id integer PRIMARY KEY CHECK (id = 1), document jsonb NOT NULL)');
  await store.pool.query('INSERT INTO dashboard_state (id, document) VALUES (1, $1::jsonb) ON CONFLICT DO NOTHING', [JSON.stringify(emptyBoard())]);
}

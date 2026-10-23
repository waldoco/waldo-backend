type Sql = Pick<SqlStorage, 'exec'>;

const KEEP_MS = 7 * 24 * 60 * 60_000;

// Exactly-once app writes for the first-run, consent and findings routes. The first answer to a request_id is kept for a
// week and returned again for the same body; the same id with a different body is refused. Results carry ids, states and
// times only, never owner text.
export const requestBook = (sql: Sql, now: () => number) => {
  sql.exec(`CREATE TABLE IF NOT EXISTS app_write_requests (
    request_id TEXT PRIMARY KEY, route TEXT NOT NULL, body_digest TEXT NOT NULL, result_json TEXT NOT NULL, at INTEGER NOT NULL)`);
  return {
    find(route: string, requestId: string, digest: string): Readonly<{ kind: 'fresh' }> | Readonly<{ kind: 'replay'; result: unknown }> | Readonly<{ kind: 'reused' }> {
      const row = sql.exec<{ route: string; body_digest: string; result_json: string; at: number }>('SELECT route, body_digest, result_json, at FROM app_write_requests WHERE request_id = ?', requestId).toArray()[0];
      if (!row || row.at + KEEP_MS <= now()) return { kind: 'fresh' };
      return row.route === route && row.body_digest === digest ? { kind: 'replay', result: JSON.parse(row.result_json) } : { kind: 'reused' };
    },
    record(route: string, requestId: string, digest: string, result: unknown): void {
      sql.exec('DELETE FROM app_write_requests WHERE at + ? <= ?', KEEP_MS, now());
      sql.exec('INSERT OR REPLACE INTO app_write_requests (request_id, route, body_digest, result_json, at) VALUES (?, ?, ?, ?, ?)', requestId, route, digest, JSON.stringify(result), now());
    },
  };
};
export type RequestBook = ReturnType<typeof requestBook>;

const sorted = (value: unknown): unknown => Array.isArray(value) ? value.map(sorted)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : 1).map(([key, child]) => [key, sorted(child)]))
  : value;
export const bodyDigest = async (body: unknown): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(sorted(body)))))].map(byte => byte.toString(16).padStart(2, '0')).join('');

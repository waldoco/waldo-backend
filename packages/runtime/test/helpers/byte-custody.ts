import { ownerByteCustody } from '../../src/rights/write-custody';

// Storage fake for adapter unit tests only. The actual production custody gate
// runs against it; eviction and physical cleanup use real DO SQLite tests.
export const testByteCustody = () => {
  const rows = new Map<string, { object_key: string; byte_size: number; sha256: string; state: string; created_at: number }>();
  const sql = { exec(query: string, ...args: unknown[]) {
    if (query.startsWith('INSERT INTO owner_byte_writes')) rows.set(args[0] as string, { object_key: args[0] as string, byte_size: args[1] as number, sha256: args[2] as string, state: args[3] as string, created_at: args[4] as number });
    if (query.startsWith('UPDATE owner_byte_writes')) { const row = rows.get(args[0] as string); if (row) row.state = query.includes("'settled'") ? 'settled' : 'uncertain'; }
    return { toArray: () => query.startsWith('SELECT') ? [...rows.values()].filter(row => args.length ? row.object_key === args[0] : row.state !== 'settled') : [] };
  } } as unknown as SqlStorage;
  const storage = { sql, kv: { get: () => undefined }, transactionSync<T>(work: () => T) { const previous = structuredClone(rows); try { return work(); } catch (error) { rows.clear(); previous.forEach((value, key) => rows.set(key, value)); throw error; } } };
  return ownerByteCustody(storage, async () => {});
};

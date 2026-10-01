import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { iMessageCommandSchema, iMessageResultSchema, opaqueIMessageIdSchema as id } from '@waldo/contracts';
const eventRow = z.strictObject({ identity: id, bridgeId: id, accountId: id, generation: id, eventId: id, nonce: id, digest: id, body: z.string().optional(), bytes: z.int().nonnegative(), state: z.enum(['pending', 'acknowledged']) });
const commandRow = z.strictObject({ identity: id, bridgeId: id, accountId: id, nonce: id, digest: id, body: z.string(), bytes: z.int().nonnegative(), command: iMessageCommandSchema, state: z.enum(['started', 'settled', 'quarantined']), result: iMessageResultSchema });
const stateSchema = z.strictObject({
  version: z.literal(1), events: z.array(eventRow), commands: z.array(commandRow),
  nonces: z.array(z.strictObject({ bridgeId: id, accountId: id, nonce: id, expiresAtMs: z.int().nonnegative() })),
  streams: z.array(z.strictObject({ bridgeId: id, accountId: id, generation: id, cursor: id.optional() })),
  heartbeats: z.array(z.strictObject({ bridgeId: id, accountId: id, atMs: z.int().nonnegative(), nonce: id, status: z.enum(['online', 'offline']) })),
});
export type RelayState = z.infer<typeof stateSchema>;
const empty = (): RelayState => ({ version: 1, events: [], commands: [], nonces: [], streams: [], heartbeats: [] });

export class RelayStore {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS relay_state (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)');
    this.db.prepare('INSERT OR IGNORE INTO relay_state(id,value) VALUES(1,?)').run(JSON.stringify(empty()));
    this.snapshot();
  }
  snapshot(): RelayState {
    const row = this.db.prepare('SELECT value FROM relay_state WHERE id=1').get() as { value: string };
    return stateSchema.parse(JSON.parse(row.value));
  }
  transaction<T>(work: (state: RelayState) => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const state = this.snapshot();
      const result = work(state);
      this.db.prepare('UPDATE relay_state SET value=? WHERE id=1').run(JSON.stringify(stateSchema.parse(state)));
      this.db.exec('COMMIT');
      return result;
    } catch (cause) {
      this.db.exec('ROLLBACK');
      throw cause;
    }
  }
  close() { this.db.close(); }
}

import { RightsError } from './jobs';

type PendingWrite = { key: string; byte_size: number; sha256: string; state: 'in_flight' | 'uncertain'; created_at: number };
type Storage = Pick<DurableObjectStorage, 'sql' | 'transactionSync'> & { kv?: Pick<DurableObjectStorage['kv'], 'get'> };
// Captured by the invocation; a cached adapter must never borrow the host's
// subsequently active run after an asynchronous owner/provider check.
export type OwnerByteInvocation = Readonly<{
  scope?: Readonly<{ admit(): void }>;
  assertCurrent?: () => Promise<void>;
}>;
export type OwnerByteCustody = Readonly<{
  put<T>(key: string, bytes: Uint8Array, write: (immutableBytes: Uint8Array) => Promise<T>, invocation?: OwnerByteInvocation): Promise<T>;
  assertQuiescent(): void;
  quiesce(timeoutMs?: number): Promise<void>;
  pending(): readonly PendingWrite[];
  settled(key: string): boolean;
  // Exact presence can settle a lost acknowledgement. Absence never proves an
  // interrupted provider request cannot finish after a later delete.
  reconcile(key: string, bytes: Uint8Array): Promise<boolean>;
}>;
const hash = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer))].map(value => value.toString(16).padStart(2, '0')).join('');
const active = new WeakMap<object, Map<string, Promise<unknown>>>();

// Durable provider reservations are independent of the effect/approval ledger.
// The lock and reservation share a synchronous transaction: already granted
// asynchronous admission cannot start a new put after deletion closes the owner.
export const ownerByteCustody = (storage: Storage, assertCurrent: () => Promise<void>, now = Date.now): OwnerByteCustody => {
  const init = () => storage.sql.exec('CREATE TABLE IF NOT EXISTS owner_byte_writes (object_key TEXT PRIMARY KEY, byte_size INTEGER NOT NULL, sha256 TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL)');
  const running = active.get(storage) ?? new Map<string, Promise<unknown>>(); active.set(storage, running);
  const pending = () => { init(); return storage.sql.exec<{ object_key: string; byte_size: number; sha256: string; state: PendingWrite['state']; created_at: number }>("SELECT * FROM owner_byte_writes WHERE state!='settled' ORDER BY created_at,object_key").toArray().map(({ object_key, ...row }) => ({ key: object_key, ...row })); };
  const assertQuiescent = () => { if (pending().length) throw new RightsError('unavailable'); };
  return {
    pending, assertQuiescent,
    settled(key) { init(); return storage.sql.exec<{state: string}>('SELECT state FROM owner_byte_writes WHERE object_key=?', key).toArray()[0]?.state === 'settled'; },
    async quiesce(timeoutMs = 5000) {
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) throw new RightsError('invalid');
      if (running.size) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([Promise.allSettled([...running.values()]), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new RightsError('unavailable')), timeoutMs); })]); }
        finally { clearTimeout(timer); }
      }
      assertQuiescent();
    },
    async put<T>(key: string, bytes: Uint8Array, write: (immutableBytes: Uint8Array) => Promise<T>, invocation?: OwnerByteInvocation) {
      if (!key || !(bytes instanceof Uint8Array)) throw new RightsError('invalid');
      const immutableBytes = bytes.slice(), sha256 = await hash(immutableBytes);
      invocation?.scope?.admit();
      await assertCurrent();
      await invocation?.assertCurrent?.();
      storage.transactionSync(() => {
        invocation?.scope?.admit();
        if (!storage.kv) throw new RightsError('unavailable');
        if (storage.kv.get('rights:owner-lock')) throw new RightsError('rejected');
        init();
        if (storage.sql.exec('SELECT object_key FROM owner_byte_writes WHERE object_key=?', key).toArray().length) throw new RightsError('conflict');
        storage.sql.exec('INSERT INTO owner_byte_writes VALUES(?,?,?,?,?)', key, immutableBytes.byteLength, sha256, 'in_flight', now());
      });
      // No await between reservation and physical dispatch. Only the admitted
      // snapshot is passed to the provider, so caller mutation cannot change it.
      let operation: Promise<T>;
      try { operation = Promise.resolve(write(immutableBytes)); }
      catch (error) { storage.sql.exec("UPDATE owner_byte_writes SET state='uncertain' WHERE object_key=?", key); throw error; }
      running.set(key, operation);
      let result: T;
      try {
        result = await operation;
        storage.sql.exec("UPDATE owner_byte_writes SET state='settled' WHERE object_key=?", key);
      } catch (error) {
        storage.sql.exec("UPDATE owner_byte_writes SET state='uncertain' WHERE object_key=?", key);
        throw error;
      } finally { running.delete(key); }
      // Settlement is cleanup evidence, not permission to publish a new file.
      await assertCurrent();
      await invocation?.assertCurrent?.();
      invocation?.scope?.admit();
      if (storage.kv!.get('rights:owner-lock')) throw new RightsError('rejected');
      return result;
    },
    async reconcile(key, bytes) {
      const row = pending().find(row => row.key === key);
      if (!row) return true;
      if (running.has(key) || bytes.byteLength !== row.byte_size || await hash(bytes) !== row.sha256) return false;
      return storage.transactionSync(() => {
        const current = pending().find(row => row.key === key);
        if (!current || running.has(key) || current.sha256 !== row.sha256) return false;
        storage.sql.exec("UPDATE owner_byte_writes SET state='settled' WHERE object_key=?", key); return true;
      });
    },
  };
};

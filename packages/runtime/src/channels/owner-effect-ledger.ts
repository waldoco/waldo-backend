import { sha256Hex } from '../connectors/google';

export type GrantUsageKey = Readonly<{
  owner_ref: string; grant_ref: string; area: string; action: string; local_day: string; timezone: string;
}>;
export type EffectReceipt = Readonly<{ provider_id: string; result: unknown }>;
export type EffectIntent = Readonly<{
  operationId: string; owner_ref: string; tool: string; payload: unknown;
  quota?: GrantUsageKey & Readonly<{ max_per_day: number }>;
}>;
export type EffectRecord = EffectIntent & Readonly<{
  identity: string; state: 'reserved' | 'attempting' | 'unknown' | 'done' | 'rejected';
  created_at: number; receipt?: EffectReceipt;
}>;
export type EffectReadback =
  | Readonly<{ status: 'done'; receipt: EffectReceipt }>
  | Readonly<{ status: 'not_applied' | 'unknown' }>;
export class EffectUnknownError extends Error {
  constructor() { super('effect outcome unknown; check the provider before retrying'); }
}
export class EffectQuotaError extends Error {
  constructor() { super('effect quota exhausted'); }
}
export class EffectNotAppliedError extends Error {
  constructor() { super('effect was not applied'); }
}

const PREFIX = 'owner:effect:';
const activeByStorage = new WeakMap<DurableObjectStorage, Set<string>>();
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw Error('effect payload must be JSON');
  return encoded;
};
const sameUsage = (a: GrantUsageKey, b: GrantUsageKey) => a.owner_ref === b.owner_ref && a.grant_ref === b.grant_ref
  && a.area === b.area && a.action === b.action && a.local_day === b.local_day && a.timezone === b.timezone;

// The host supplies identity and quota after approval/authority validation. This ledger
// never grants permission. Intent and quota are committed together without an await.
export const ownerEffectLedger = (storage: DurableObjectStorage, now: () => number) => {
  let active = activeByStorage.get(storage);
  if (!active) { active = new Set(); activeByStorage.set(storage, active); }
  const rows = () => [...storage.kv.list<EffectRecord>({ prefix: PREFIX })].map(([, value]) => value);
  const get = (operationId: string) => structuredClone(storage.kv.get<EffectRecord>(PREFIX + operationId) ?? null);
  const usage = (key: GrantUsageKey, records = rows()) => records.filter(row => row.quota && sameUsage(row.quota, key) && row.state !== 'rejected').length;
  const reserve = (intent: EffectIntent): EffectRecord => storage.transactionSync(() => {
    if (!intent.operationId || !intent.owner_ref || !intent.tool) throw Error('effect identity required');
    const identity = canonical(intent);
    const prior = get(intent.operationId);
    if (prior) {
      if (prior.identity !== identity) throw Error('effect identity conflict');
      return structuredClone(prior);
    }
    if (intent.quota && (intent.quota.owner_ref !== intent.owner_ref || !Number.isSafeInteger(intent.quota.max_per_day) || intent.quota.max_per_day < 0)) throw Error('invalid effect quota');
    if (intent.quota && usage(intent.quota) >= intent.quota.max_per_day) throw new EffectQuotaError();
    const record: EffectRecord = { ...structuredClone(intent), identity, state: 'reserved', created_at: now() };
    storage.kv.put(PREFIX + intent.operationId, record);
    return structuredClone(record);
  });
  const update = (operationId: string, state: EffectRecord['state'], receipt?: EffectReceipt) => storage.transactionSync(() => {
    const record = get(operationId);
    if (!record) throw Error('effect intent missing');
    if (state === 'done' && (!receipt || typeof receipt.provider_id !== 'string' || !receipt.provider_id)) throw Error('effect provider receipt required');
    if (receipt) canonical(receipt);
    storage.kv.put(PREFIX + operationId, { ...record, state, ...(receipt ? { receipt: structuredClone(receipt) } : {}) });
  });
  const readback = async (operationId: string, reconcile: () => Promise<EffectReadback>): Promise<EffectReceipt> => {
    let outcome: EffectReadback;
    try { outcome = await reconcile(); }
    catch { console.error('owner_effect_reconcile_failed'); outcome = { status: 'unknown' }; }
    if (outcome.status === 'done') { update(operationId, 'done', outcome.receipt); return outcome.receipt; }
    update(operationId, outcome.status === 'not_applied' ? 'rejected' : 'unknown');
    if (outcome.status === 'not_applied') throw new EffectNotAppliedError();
    throw new EffectUnknownError();
  };
  return {
    get, reserve,
    isActive: (operationId: string) => active!.has(operationId),
    count: async (key: GrantUsageKey): Promise<number> => usage(key),
    async execute(intent: EffectIntent, adapter: Readonly<{
      dispatch(): Promise<EffectReceipt>; reconcile(): Promise<EffectReadback>;
    }>): Promise<EffectReceipt> {
      const record = reserve(intent);
      if (record.state === 'done') return record.receipt!;
      if (record.state === 'rejected') throw new EffectNotAppliedError();
      if (active!.has(intent.operationId)) throw new EffectUnknownError();
      active!.add(intent.operationId);
      try {
        if (record.state !== 'reserved') return await readback(intent.operationId, adapter.reconcile);
        update(intent.operationId, 'attempting');
        let receipt: EffectReceipt;
        try { receipt = await adapter.dispatch(); }
        catch {
          console.error('owner_effect_dispatch_unknown');
          return await readback(intent.operationId, adapter.reconcile);
        }
        // A persistence failure after I/O deliberately leaves an attempting intent.
        update(intent.operationId, 'done', receipt);
        return receipt;
      } finally { active!.delete(intent.operationId); }
    },
  };
};
export type OwnerEffectLedger = ReturnType<typeof ownerEffectLedger>;

export const ownerEffectOperationRef = async (context?: Readonly<{ authenticatedUserId: string; turnId?: string; toolCallId?: string }>): Promise<string | undefined> =>
  context?.turnId && context.toolCallId ? `tool:${await sha256Hex(JSON.stringify([context.authenticatedUserId, context.turnId, context.toolCallId]))}` : undefined;

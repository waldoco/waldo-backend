import type { CostKind } from '@waldo/contracts';
import { md5Hex } from '../channels/md5';
import type { TurnLogEntry } from '../channels/owner-turn-types';
import { modelCost } from '../llm/pricing';

// One owner's spend for one UTC day, cost kind and model, as waldo.cost_ledger_daily stores it.
// model is '' for spend that is not a model call (sandbox or browser time, broker calls).
// broker_calls has no producer yet; the column exists so the rollup shape does not change when one lands.
export type CostRollupRow = {
  day: string; kind: CostKind; model: string;
  calls: number; input: number; output: number; cached: number; web_searches: number;
  browser_ms: number; sandbox_ms: number; broker_calls: number; usd: number;
};

type Kv = Readonly<{ get<T>(key: string): T | undefined; put<T>(key: string, value: T): void; delete(key: string): boolean }>;
type SignedCall = (fn: string, message: string, args: Record<string, string | number>) => Promise<unknown>;
// open: deltas not yet sent. sending: the batch on the wire, resent under the same id until the database answers,
// so a reply lost after the commit replays as a no-op instead of counting twice.
type Pending = { open: CostRollupRow[]; sending?: { id: string; rows: CostRollupRow[]; attempts: number } };

export const COST_ROLLUP_KEY = 'cost_rollup_pending';
export const COST_ROLLUP_MAX_ATTEMPTS = 20;

// One flush in flight per DO storage, shared by every channel runtime the DO builds over it.
const flights = new WeakMap<Kv, Promise<void>>();

export const costRollupEnabled = (env: Readonly<{ WALDO_COST_LEDGER_SYNC?: string }>): boolean => env.WALDO_COST_LEDGER_SYNC === 'on';

export const costRollupDelta = (entry: TurnLogEntry, at: number): CostRollupRow | null => {
  const { usage } = entry;
  const browserMs = entry.browser_ms ?? 0;
  const sandboxMs = entry.sandbox_ms ?? 0;
  if (!usage && browserMs <= 0 && sandboxMs <= 0) return null;
  return {
    day: new Date(at).toISOString().slice(0, 10), kind: entry.cost_kind ?? 'turn', model: usage?.model ?? '',
    calls: usage ? 1 : 0, input: usage?.input ?? 0, output: usage?.output ?? 0, cached: usage?.cached ?? 0,
    web_searches: usage?.web_searches ?? 0, browser_ms: browserMs, sandbox_ms: sandboxMs, broker_calls: 0,
    usd: usage ? modelCost(usage)?.total ?? 0 : 0,
  };
};

const SUMMED = ['calls', 'input', 'output', 'cached', 'web_searches', 'browser_ms', 'sandbox_ms', 'broker_calls', 'usd'] as const;
const sameBucket = (a: CostRollupRow, b: CostRollupRow) => a.day === b.day && a.kind === b.kind && a.model === b.model;

const merge = (rows: readonly CostRollupRow[], delta: CostRollupRow): CostRollupRow[] => {
  const index = rows.findIndex((row) => sameBucket(row, delta));
  if (index < 0) return [...rows, delta];
  const summed = { ...rows[index]! };
  for (const field of SUMMED) summed[field] += delta[field];
  return rows.map((row, i) => (i === index ? summed : row));
};

// Write-behind of per-day spend to Supabase. record() is synchronous storage only; flush() is the one network
// path, runs one request at a time, and reports failures to onError instead of throwing, so a turn never waits on
// or fails because of the ledger. Deltas survive eviction in the DO's KV until the database has them.
export const costRollup = ({ kv, call, doName, newId, onError }: Readonly<{
  kv: Kv; call: SignedCall | null; doName: string | null; newId: () => string; onError?: (error: unknown) => void;
}>) => {
  const linked = call !== null && !!doName;
  const read = (): Pending => kv.get<Pending>(COST_ROLLUP_KEY) ?? { open: [] };
  const write = (pending: Pending) => {
    if (pending.open.length === 0 && !pending.sending) kv.delete(COST_ROLLUP_KEY);
    else kv.put(COST_ROLLUP_KEY, pending);
  };

  // 'sent' means there may be more to send; 'idle' means nothing is pending; 'failed' stops this flush.
  const sendOnce = async (): Promise<'sent' | 'idle' | 'failed'> => {
    let pending = read();
    if (!pending.sending) {
      if (pending.open.length === 0) return 'idle';
      pending = { open: [], sending: { id: newId(), rows: pending.open, attempts: 0 } };
      write(pending);
    }
    const batch = pending.sending!;
    const rows = JSON.stringify(batch.rows);
    try {
      await call!('cost_ledger_add', `cost.add.${doName}.${batch.id}.${md5Hex(rows)}`, { p_do_name: doName!, p_batch: batch.id, p_rows: rows });
      const { sending: _sent, ...rest } = read();
      write(rest);
      return 'sent';
    } catch (error) {
      const attempts = batch.attempts + 1;
      const current = read();
      if (attempts >= COST_ROLLUP_MAX_ATTEMPTS) {
        const { sending: _dropped, ...rest } = current;
        write(rest);
        onError?.(new Error(`cost ledger batch ${batch.id} dropped after ${attempts} attempts: ${String(error)}`));
      } else {
        write({ ...current, sending: { ...batch, attempts } });
        onError?.(error);
      }
      return 'failed';
    }
  };

  return {
    record(entry: TurnLogEntry, at: number): boolean {
      if (!linked) return false;
      const delta = costRollupDelta(entry, at);
      if (!delta) return false;
      try {
        const pending = read();
        write({ ...pending, open: merge(pending.open, delta) });
        return true;
      } catch (error) {
        onError?.(error);
        return false;
      }
    },
    flush(): Promise<void> {
      if (!linked) return Promise.resolve();
      const inFlight = flights.get(kv);
      if (inFlight) return inFlight;
      const running = (async () => {
        try {
          while (await sendOnce() === 'sent');
        } catch (error) {
          onError?.(error);
        } finally {
          flights.delete(kv);
        }
      })();
      flights.set(kv, running);
      return running;
    },
  };
};

export type CostRollup = ReturnType<typeof costRollup>;

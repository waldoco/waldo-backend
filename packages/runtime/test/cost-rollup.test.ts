import { describe, expect, it } from 'vitest';
import { OPENAI_GPT_6_LUNA_MODEL } from '@waldo/contracts';
import { md5Hex } from '../src/channels/md5';
import type { TurnLogEntry } from '../src/channels/owner-turn-types';
import { modelCost } from '../src/llm/pricing';
import { COST_ROLLUP_KEY, COST_ROLLUP_MAX_ATTEMPTS, costRollup, costRollupDelta, costRollupEnabled } from '../src/observability/cost-rollup';

const DAY = Date.UTC(2026, 9, 20, 10);
const llm = (over: Partial<TurnLogEntry> = {}): TurnLogEntry => ({
  trace: 'tg-1', hop: 'llm_reply', ms: 900, ok: true, cost_kind: 'turn',
  usage: { model: OPENAI_GPT_6_LUNA_MODEL, input: 1000, output: 200, cached: 600, web_searches: 1 }, ...over,
});

const memoryKv = () => {
  const rows = new Map<string, unknown>();
  return { rows, get: <T>(key: string) => rows.get(key) as T | undefined, put: <T>(key: string, value: T) => { rows.set(key, structuredClone(value)); }, delete: (key: string) => rows.delete(key) };
};

type Sent = { fn: string; message: string; args: Record<string, string | number> };
const recorder = (answer: (sent: Sent) => Promise<unknown> = async () => 1) => {
  const sent: Sent[] = [];
  return { sent, call: async (fn: string, message: string, args: Record<string, string | number>) => { const item = { fn, message, args }; sent.push(item); return answer(item); } };
};

const ids = () => { let n = 0; return () => `batch-${++n}`; };

describe('costRollupDelta', () => {
  it('turns a model call into a per-day, per-kind, per-model row priced by pricing.ts', () => {
    const usage = llm().usage!;
    expect(costRollupDelta(llm(), DAY)).toEqual({
      day: '2026-10-20', kind: 'turn', model: OPENAI_GPT_6_LUNA_MODEL, calls: 1, input: 1000, output: 200, cached: 600,
      web_searches: 1, browser_ms: 0, sandbox_ms: 0, broker_calls: 0, usd: modelCost(usage)!.total,
    });
  });

  it('keeps tokens for an unpriced model with a zero estimate', () => {
    expect(costRollupDelta(llm({ usage: { model: 'unknown-model', input: 10, output: 5, cached: 0 } }), DAY))
      .toMatchObject({ model: 'unknown-model', calls: 1, input: 10, output: 5, web_searches: 0, usd: 0 });
  });

  it('files sandbox and browser time under the empty model', () => {
    expect(costRollupDelta({ trace: 't', hop: 'tool_run_code', ms: 1, ok: true, cost_kind: 'worker', sandbox_ms: 1500, browser_ms: 0 }, DAY))
      .toMatchObject({ kind: 'worker', model: '', calls: 0, sandbox_ms: 1500, usd: 0 });
  });

  it('defaults the kind to turn and ignores hops that cost nothing', () => {
    expect(costRollupDelta(llm({ cost_kind: undefined }), DAY)?.kind).toBe('turn');
    expect(costRollupDelta({ trace: 't', hop: 'send', ms: 3, ok: true }, DAY)).toBeNull();
  });
});

describe('costRollupEnabled', () => {
  it('is off unless the flag says on', () => {
    expect(costRollupEnabled({})).toBe(false);
    expect(costRollupEnabled({ WALDO_COST_LEDGER_SYNC: 'off' })).toBe(false);
    expect(costRollupEnabled({ WALDO_COST_LEDGER_SYNC: 'on' })).toBe(true);
  });
});

describe('costRollup write-behind', () => {
  it('merges deltas in storage and sends one signed batch whose md5 covers the exact rows text', async () => {
    const kv = memoryKv(); const rpc = recorder();
    const rollup = costRollup({ kv, call: rpc.call, doName: 'do-a', newId: ids() });
    rollup.record(llm(), DAY);
    rollup.record(llm({ usage: { model: OPENAI_GPT_6_LUNA_MODEL, input: 500, output: 100, cached: 0 } }), DAY + 1000);
    rollup.record({ trace: 't', hop: 'send', ms: 1, ok: true }, DAY);
    expect(kv.get<{ open: unknown[] }>(COST_ROLLUP_KEY)?.open).toHaveLength(1);
    await rollup.flush();
    expect(rpc.sent).toHaveLength(1);
    const [{ fn, message, args }] = rpc.sent as [Sent];
    expect(fn).toBe('cost_ledger_add');
    expect(args.p_do_name).toBe('do-a');
    expect(args.p_batch).toBe('batch-1');
    expect(message).toBe(`cost.add.do-a.batch-1.${md5Hex(args.p_rows as string)}`);
    expect(JSON.parse(args.p_rows as string)).toEqual([expect.objectContaining({ day: '2026-10-20', model: OPENAI_GPT_6_LUNA_MODEL, calls: 2, input: 1500, output: 300, cached: 600, web_searches: 1 })]);
    expect(kv.get(COST_ROLLUP_KEY)).toBeUndefined();
  });

  it('keeps separate rows per day, kind and model', async () => {
    const kv = memoryKv(); const rpc = recorder();
    const rollup = costRollup({ kv, call: rpc.call, doName: 'do-a', newId: ids() });
    rollup.record(llm(), DAY);
    rollup.record(llm({ cost_kind: 'heartbeat' }), DAY);
    rollup.record(llm(), DAY + 86_400_000);
    await rollup.flush();
    expect(JSON.parse(rpc.sent[0]!.args.p_rows as string)).toHaveLength(3);
  });

  it('never throws into the turn, and resends the same batch id after a failure so the database can drop a replay', async () => {
    const kv = memoryKv(); const errors: unknown[] = [];
    let fail = true;
    const rpc = recorder(async () => { if (fail) throw new Error('supabase down'); return 1; });
    const rollup = costRollup({ kv, call: rpc.call, doName: 'do-a', newId: ids(), onError: (error) => errors.push(error) });
    rollup.record(llm(), DAY);
    await expect(rollup.flush()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    rollup.record(llm(), DAY);
    fail = false;
    await rollup.flush();
    expect(rpc.sent.map((sent) => sent.args.p_batch)).toEqual(['batch-1', 'batch-1', 'batch-2']);
    expect(rpc.sent[1]!.args.p_rows).toBe(rpc.sent[0]!.args.p_rows);
    expect(kv.get(COST_ROLLUP_KEY)).toBeUndefined();
  });

  it('runs one request at a time and picks up what arrived meanwhile', async () => {
    const kv = memoryKv();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const rpc = recorder(async (sent) => { if (sent.args.p_batch === 'batch-1') await gate; return 1; });
    const rollup = costRollup({ kv, call: rpc.call, doName: 'do-a', newId: ids() });
    rollup.record(llm(), DAY);
    const first = rollup.flush();
    rollup.record(llm({ cost_kind: 'background' }), DAY);
    const second = rollup.flush();
    expect(rpc.sent).toHaveLength(1);
    release();
    await Promise.all([first, second]);
    expect(rpc.sent.map((sent) => sent.args.p_batch)).toEqual(['batch-1', 'batch-2']);
    expect(kv.get(COST_ROLLUP_KEY)).toBeUndefined();
  });

  it('shares one flight between the channel runtimes of one DO', async () => {
    const kv = memoryKv();
    const wire: { batch: string; resolve: (value: unknown) => void }[] = [];
    const call = (_fn: string, _message: string, args: Record<string, string | number>) =>
      new Promise<unknown>((resolve) => { wire.push({ batch: args.p_batch as string, resolve }); });
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
    const newId = ids();
    const telegram = costRollup({ kv, call, doName: 'do-a', newId });
    const app = costRollup({ kv, call, doName: 'do-a', newId });
    telegram.record(llm(), DAY);
    const first = telegram.flush();
    app.record(llm({ cost_kind: 'background' }), DAY);
    const second = app.flush();
    expect(wire.map((sent) => sent.batch)).toEqual(['batch-1']);
    wire[0]!.resolve(1);
    await tick();
    expect(wire.map((sent) => sent.batch)).toEqual(['batch-1', 'batch-2']);
    wire[1]!.resolve(1);
    await Promise.all([first, second]);
    expect(kv.get(COST_ROLLUP_KEY)).toBeUndefined();
  });

  it('drops a batch the database keeps refusing, after a bounded number of attempts', async () => {
    const kv = memoryKv(); const errors: unknown[] = [];
    const rpc = recorder(async () => { throw new Error('400'); });
    const rollup = costRollup({ kv, call: rpc.call, doName: 'do-a', newId: ids(), onError: (error) => errors.push(error) });
    rollup.record(llm(), DAY);
    for (let attempt = 0; attempt < COST_ROLLUP_MAX_ATTEMPTS; attempt += 1) await rollup.flush();
    expect(rpc.sent).toHaveLength(COST_ROLLUP_MAX_ATTEMPTS);
    expect(kv.get(COST_ROLLUP_KEY)).toBeUndefined();
    expect(String(errors.at(-1))).toContain('dropped');
  });

  it('clears a batch for an owner the directory does not know', async () => {
    const kv = memoryKv(); const rpc = recorder(async () => null);
    const rollup = costRollup({ kv, call: rpc.call, doName: 'do-gone', newId: ids() });
    rollup.record(llm(), DAY);
    await rollup.flush();
    expect(kv.get(COST_ROLLUP_KEY)).toBeUndefined();
  });

  it('does nothing without a signed rail or a DO name', async () => {
    const kv = memoryKv();
    const unlinked = costRollup({ kv, call: null, doName: 'do-a', newId: ids() });
    unlinked.record(llm(), DAY);
    await unlinked.flush();
    const nameless = costRollup({ kv, call: recorder().call, doName: null, newId: ids() });
    nameless.record(llm(), DAY);
    await nameless.flush();
    expect(kv.rows.size).toBe(0);
  });
});

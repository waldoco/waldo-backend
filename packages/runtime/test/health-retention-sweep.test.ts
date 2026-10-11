import { describe, expect, it } from 'vitest';
import { md5Hex } from '../src/channels/md5';
import { sweepHealthRetention } from '../src/health/retention-sweep';

type Call = { fn: string; message: string; args: Record<string, string | number> };
const rpcOf = (answers: unknown[]) => {
  const calls: Call[] = [];
  const rpc = async (fn: string, message: string, args: Record<string, string | number>) => {
    calls.push({ fn, message, args });
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { rpc, calls };
};
const page = (owners: number, more: boolean) => ({ owners, more, raw_deleted: 0, requests_deleted: 0, context_deleted: 0 });

describe('sweepHealthRetention', () => {
  it('asks for one bounded page, signed over the exact payload it sends', async () => {
    const { rpc, calls } = rpcOf([page(3, false)]);
    expect(await sweepHealthRetention(rpc)).toEqual({ state: 'complete', owners: 3, rounds: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.fn).toBe('health_retention_sweep');
    expect(JSON.parse(String(calls[0]!.args.p_payload))).toEqual({ limit: 50 });
    expect(calls[0]!.message).toBe(`health.retention_sweep.${md5Hex(String(calls[0]!.args.p_payload))}`);
  });

  it('keeps going while the database says there are more, and adds the owners up', async () => {
    const { rpc, calls } = rpcOf([page(50, true), page(50, true), page(7, false)]);
    expect(await sweepHealthRetention(rpc)).toEqual({ state: 'complete', owners: 107, rounds: 3 });
    expect(calls).toHaveLength(3);
  });

  it('stops after a bounded number of rounds and says it did not finish', async () => {
    const { rpc, calls } = rpcOf([page(50, true)]);
    expect(await sweepHealthRetention(rpc)).toEqual({ state: 'incomplete', owners: 1000, rounds: 20 });
    expect(calls).toHaveLength(20);
  });

  it('stops at the first failure without throwing, keeping what it already did', async () => {
    const { rpc } = rpcOf([page(50, true), new Error('down')]);
    expect(await sweepHealthRetention(rpc)).toEqual({ state: 'failed', owners: 50, rounds: 1 });
  });

  it('treats an error code or a shape it does not know as a failure, never as done', async () => {
    for (const answer of [{ error: 'invalid_request' }, null, 'ok', { owners: 'x', more: false }, { owners: 1 }, { owners: -1, more: false }]) {
      expect(await sweepHealthRetention(rpcOf([answer]).rpc)).toMatchObject({ state: 'failed' });
    }
  });

  it('does nothing when the database is not configured', async () => {
    expect(await sweepHealthRetention(null)).toEqual({ state: 'unconfigured', owners: 0, rounds: 0 });
  });
});

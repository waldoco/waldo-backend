import { describe, expect, it } from 'vitest';
import { ClosedRunError } from '../src/channels/run-effect-scope';
import { lastRunFailure, pausedLine, recordingFailures, RUN_FAILURE_CODES, runFailureCode } from '../src/channels/run-failure';
import { OwnerAdmissionError } from '../src/identity/owner-message-admission';
import { ModelUnavailableError } from '../src/llm/provider';
import type { ScheduleEntry } from '@waldo/contracts';

// Why a scheduled job's run failed, as a closed code with no error text: what a paused card says and what a trace counts.
const kvOf = () => {
  const map = new Map<string, unknown>();
  return { map, kv: { get: <T>(key: string) => map.get(key) as T | undefined, put: (key: string, value: unknown) => { map.set(key, value); }, delete: (key: string) => map.delete(key) } };
};
const entry = (id: string) => ({ id, kind: 'brief' }) as unknown as ScheduleEntry;

describe('runFailureCode', () => {
  it('names the failures Waldo can tell apart, and every other one unknown', () => {
    const named = (error: unknown) => runFailureCode(error);
    expect(named(new ModelUnavailableError('timeout' as never))).toBe('model_unavailable');
    expect(named(new Error('live model failed: invalid_args (invalid_response)'))).toBe('model_failed');
    expect(named(new Error('turn timed out after 90000ms'))).toBe('timed_out');
    expect(named(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))).toBe('timed_out');
    expect(named(Object.assign(new Error('signal timed out'), { name: 'TimeoutError' }))).toBe('timed_out');
    expect(named(new Error('telegram send blocked'))).toBe('not_delivered');
    expect(named(new Error('send held for the owner, not delivered'))).toBe('not_delivered');
    expect(named(new Error('owner_unbound'))).toBe('owner_check');
    expect(named(new OwnerAdmissionError('unavailable'))).toBe('owner_check');
    expect(named(new ClosedRunError())).toBe('owner_check');
    expect(named(new Error('final outbox capacity'))).toBe('outbox_full');
    expect(named(new Error('Wrong number of parameter bindings for SQL query.'))).toBe('storage');
    expect(named(new Error('Your synthetic reading was 42 and the owner is Sam'))).toBe('unknown');
    expect(named('a thrown string')).toBe('unknown');
    expect(named(undefined)).toBe('unknown');
  });

  it('gives each code one short fixed line that fits the card\'s reason', () => {
    for (const code of RUN_FAILURE_CODES) {
      const line = pausedLine(code, 3);
      expect(line.startsWith('Paused after 3 failed tries in a row: ')).toBe(true);
      expect(line.length).toBeLessThanOrEqual(120);
    }
  });
});

describe('recordingFailures', () => {
  it('keeps the latest failure of each job by its code, rethrows the same error, and forgets it once a run goes well', async () => {
    const { kv, map } = kvOf();
    let fail: unknown = new Error('final outbox capacity');
    const executors = recordingFailures({ brief: async () => { if (fail) throw fail; return undefined; } }, kv, () => 1_000);
    await expect(executors.brief!(entry('card:brief'))).rejects.toBe(fail);
    expect(lastRunFailure(kv, 'card:brief')).toEqual({ code: 'outbox_full', at: 1_000 });
    fail = new Error('telegram send blocked');
    await expect(executors.brief!(entry('card:brief'))).rejects.toBe(fail);
    expect(lastRunFailure(kv, 'card:brief')).toEqual({ code: 'not_delivered', at: 1_000 });
    expect(JSON.stringify([...map.values()])).not.toContain('blocked');
    fail = undefined;
    await expect(executors.brief!(entry('card:brief'))).resolves.toBeUndefined();
    expect(lastRunFailure(kv, 'card:brief')).toBeNull();
  });

  it('a run that waits for the model is no failure and leaves the record as it was', async () => {
    const { kv } = kvOf();
    kv.put('schedule_failure_v1:card:brief', { code: 'timed_out', at: 5 });
    const executors = recordingFailures({ brief: async () => 'waiting_on_model' as const }, kv, () => 9);
    expect(await executors.brief!(entry('card:brief'))).toBe('waiting_on_model');
    expect(lastRunFailure(kv, 'card:brief')).toEqual({ code: 'timed_out', at: 5 });
  });
});

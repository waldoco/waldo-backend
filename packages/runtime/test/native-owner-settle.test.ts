import { describe, expect, it, vi } from 'vitest';
import { settleNativeOwnerTurn } from '../scenarios/native-owner-settle';
import { OWNER_INBOX_KEY, type InboxRecord } from '../src/channels/telegram-owner-inbox';
import { FINAL_OUTBOX_KEY, type FinalRecord } from '../src/channels/telegram-final-outbox';

const fixture = () => {
  const target = { bot: 'fixture', subject: '81201', doName: 'fixture-owner', updateId: 7 };
  const row: InboxRecord = { ...target, id: 'fixture:telegram:7', digest: 'synthetic', sequence: 1, body: '{}', admittedAt: 1, state: 'admitted' };
  const data = new Map<string, unknown>([[OWNER_INBOX_KEY, [row]]]);
  const kv = { get: <T>(key: string): T | undefined => structuredClone(data.get(key)) as T | undefined,
    put: (key: string, value: unknown) => { data.set(key, structuredClone(value)); } };
  const transport = { settle: vi.fn(async () => {}), pending: () => 0 };
  const final = (): FinalRecord => ({ id: 'final', trace: 'tg-7', payload: { chat_id: 81201, text: 'synthetic' }, digest: 'synthetic',
    ownerSubject: target.subject, doName: target.doName, bot: target.bot, status: 'pending', dueAt: 1250, createdAt: 1000, attempts: 0,
    inbox: { id: row.id, runId: 'run', attempt: 'attempt' } });
  return { target, row, kv, data, transport, final };
};

describe('bounded native fixture settlement', () => {
  it('drives admission and exact final delivery even with an idle private queue', async () => {
    const f = fixture();
    const unrelated = { ...f.final(), id: 'other', dueAt: 9999, inbox: { id: 'other:telegram:7', runId: 'other', attempt: 'other' } };
    const alarm = vi.fn(async () => {
      if (alarm.mock.calls.length === 1) {
        f.kv.put(OWNER_INBOX_KEY, [{ ...f.row, state: 'awaiting_delivery', runId: 'run', attempt: 'attempt', closedAt: 1000 }]);
        f.kv.put(FINAL_OUTBOX_KEY, [f.final(), unrelated]);
      } else {
        const rows = f.kv.get<FinalRecord[]>(FINAL_OUTBOX_KEY)!;
        expect(rows[0]!.dueAt).toBe(1000);
        expect(rows[1]!.dueAt).toBe(9999);
        rows[0]!.status = 'delivered'; rows[0]!.settled = true;
        f.kv.put(FINAL_OUTBOX_KEY, rows);
        f.kv.put(OWNER_INBOX_KEY, [{ ...f.row, state: 'completed', runId: 'run', attempt: 'attempt', closedAt: 1000 }]);
      }
    });
    await settleNativeOwnerTurn({ alarm }, f.kv, f.transport, f.target, () => 1000);
    expect(alarm).toHaveBeenCalledTimes(2);
  });
  it('makes the exact delivery wake due under both future fixture and wall clocks', async () => {
    const f = fixture(), wall = Date.now();
    f.kv.put(OWNER_INBOX_KEY, [{ ...f.row, state: 'awaiting_delivery', runId: 'run', attempt: 'attempt', closedAt: wall }]);
    f.kv.put(FINAL_OUTBOX_KEY, [f.final()]);
    const alarm = vi.fn(async () => {
      expect(f.kv.get<FinalRecord[]>(FINAL_OUTBOX_KEY)![0]!.dueAt).toBeLessThanOrEqual(Date.now());
    });
    await expect(settleNativeOwnerTurn({ alarm }, f.kv, f.transport, f.target, () => wall + 86400000, 1)).rejects.toThrow('exhausted');
    expect(alarm).toHaveBeenCalledTimes(1);
  });
  it('fails after the exact alarm bound rather than declaring idle admission settled', async () => {
    const f = fixture(), alarm = vi.fn(async () => {});
    await expect(settleNativeOwnerTurn({ alarm }, f.kv, f.transport, f.target, () => 1000, 3)).rejects.toThrow('exhausted 3 alarm steps');
    expect(alarm).toHaveBeenCalledTimes(3);
  });
  it.each(['missing', 'wrong owner', 'wrong update'])('rejects %s admission before driving any alarm', async kind => {
    const f = fixture(), alarm = vi.fn(async () => {});
    f.kv.put(OWNER_INBOX_KEY, kind === 'missing' ? [] : [{ ...f.row, ...(kind === 'wrong owner' ? { subject: '999' } : { updateId: 8 }) }]);
    await expect(settleNativeOwnerTurn({ alarm }, f.kv, f.transport, f.target, () => 1000)).rejects.toThrow('admission missing or mismatched');
    expect(alarm).not.toHaveBeenCalled();
  });
  it('rejects a sibling attempt final instead of accepting its delivery', async () => {
    const f = fixture();
    f.kv.put(OWNER_INBOX_KEY, [{ ...f.row, state: 'completed', runId: 'run', attempt: 'attempt', closedAt: 1000 }]);
    f.kv.put(FINAL_OUTBOX_KEY, [{ ...f.final(), status: 'delivered', settled: true, inbox: { id: f.row.id, runId: 'other', attempt: 'other' } }]);
    await expect(settleNativeOwnerTurn({ alarm: async () => {} }, f.kv, f.transport, f.target, () => 1000)).rejects.toThrow('final custody mismatch');
  });
  it('fails explicitly on quarantined delivery', async () => {
    const f = fixture();
    f.kv.put(OWNER_INBOX_KEY, [{ ...f.row, state: 'quarantined', reason: 'delivery_uncertain' }]);
    await expect(settleNativeOwnerTurn({ alarm: async () => {} }, f.kv, f.transport, f.target, () => 1000)).rejects.toThrow('delivery_uncertain');
  });
  it('does not accept completed admission without a durably settled final', async () => {
    const f = fixture(), alarm = vi.fn(async () => {});
    f.kv.put(OWNER_INBOX_KEY, [{ ...f.row, state: 'completed', closedAt: 1000 }]);
    await expect(settleNativeOwnerTurn({ alarm }, f.kv, f.transport, f.target, () => 1000, 1)).rejects.toThrow('exhausted');
  });
});

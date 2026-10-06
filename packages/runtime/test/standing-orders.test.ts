import { describe, expect, it } from 'vitest';
import { TOOL_PERMISSIONS, type ScheduleEntry } from '@waldo/contracts';
import { standingOrderBook, standingOrderFireText, standingOrderHandlers, standingOrdersPrompt } from '../src/channels/standing-orders';

type ScheduledRow = { id: string; kind: string; dueAt: number; recurrence: unknown };
const fakeSql = () => {
  const rows = new Map<string, { id: string; scope: string; trigger: string; at: string | null; gate: string; escalation: string; created_at: number }>();
  return {
    rows,
    exec(query: string, ...args: unknown[]) {
      if (query.startsWith('CREATE TABLE')) return { toArray: () => [] };
      if (query.startsWith('INSERT INTO standing_orders')) {
        const [id, scope, trigger, at, gate, escalation, created_at] = args as [string, string, string, string | null, string, string, number];
        rows.set(id, { id, scope, trigger, at, gate, escalation, created_at });
        return { toArray: () => [] };
      }
      if (query.startsWith('SELECT * FROM standing_orders WHERE id') || query.startsWith('SELECT id FROM standing_orders WHERE id')) {
        const row = rows.get(args[0] as string);
        return { toArray: () => (row ? [row] : []) };
      }
      if (query.startsWith('SELECT * FROM standing_orders ORDER BY')) {
        return { toArray: () => [...rows.values()].sort((a, b) => a.created_at - b.created_at) };
      }
      if (query.startsWith('DELETE FROM standing_orders')) {
        // Faithful to SQLite: a DELETE without RETURNING yields no rows whether or not it removed one.
        rows.delete(args[0] as string);
        return { toArray: () => [] };
      }
      throw new Error(`unexpected query: ${query}`);
    },
  };
};

const fakeScheduler = () => {
  const armed: ScheduledRow[] = [];
  const cancelled: string[] = [];
  return {
    armed,
    cancelled,
    async schedule(input: { id: string; kind: string; dueAt: number; occurrenceAt: number; recurrence?: unknown }) {
      armed.push({ id: input.id, kind: input.kind, dueAt: input.dueAt, recurrence: input.recurrence ?? null });
      return { id: input.id, due_at: input.dueAt };
    },
    read: (id: string) => armed.find((row) => row.id === id),
    async cancel(id: string) {
      cancelled.push(id);
      const at = armed.findIndex((row) => row.id === id);
      if (at >= 0) armed.splice(at, 1); // persists like the real Scheduler: a cancelled entry is gone
    },
  };
};

const clock = { timezone: 'Asia/Kolkata', now: () => new Date('2026-09-27T02:00:00Z') }; // 07:30 IST

describe('standing order book', () => {
  it('arms a daily order on the scheduler with the owner-local recurrence', async () => {
    const sql = fakeSql();
    const scheduler = fakeScheduler();
    const book = standingOrderBook(sql as never, scheduler as never, clock, () => 'abc123');
    const order = await book.set({ scope: 'Summarize my day', trigger: 'daily', at: '21:00', gate: 'act_and_report', escalation: 'message_owner' });
    expect(order.id).toBe('order:abc123');
    expect(scheduler.armed).toHaveLength(1);
    expect(scheduler.armed[0]).toMatchObject({
      id: 'order:abc123',
      kind: 'standing_order',
      recurrence: { type: 'daily_local', time: '21:00', timezone: 'Asia/Kolkata' },
    });
    // 21:00 IST today is still ahead of 07:30 IST, so the first fire lands today.
    expect(scheduler.armed[0]!.dueAt).toBe(Date.parse('2026-09-27T15:30:00Z'));
  });

  it('rolls a past daily time to tomorrow', async () => {
    const sql = fakeSql();
    const scheduler = fakeScheduler();
    const book = standingOrderBook(sql as never, scheduler as never, clock, () => 'def456');
    await book.set({ scope: 'Morning check', trigger: 'daily', at: '06:00', gate: 'confirm_first', escalation: 'log_only' });
    // 06:00 IST already passed at 07:30 IST; next fire is tomorrow 06:00 IST.
    expect(scheduler.armed[0]!.dueAt).toBe(Date.parse('2026-09-28T00:30:00Z'));
  });

  it('an every-turn order arms nothing; daily needs a time and every-turn takes none', async () => {
    const sql = fakeSql();
    const scheduler = fakeScheduler();
    const book = standingOrderBook(sql as never, scheduler as never, clock, () => 'ghi789');
    await book.set({ scope: 'Never book before 10am', trigger: 'every_turn', gate: 'confirm_first', escalation: 'message_owner' });
    expect(scheduler.armed).toHaveLength(0);
    await expect(book.set({ scope: 'x', trigger: 'daily', gate: 'act_and_report', escalation: 'message_owner' })).rejects.toThrow('needs its local HH:MM');
    await expect(book.set({ scope: 'x', trigger: 'every_turn', at: '09:00', gate: 'act_and_report', escalation: 'message_owner' })).rejects.toThrow('takes no time');
  });

  it('cancels the schedule row with the order', async () => {
    const sql = fakeSql();
    const scheduler = fakeScheduler();
    const book = standingOrderBook(sql as never, scheduler as never, clock, () => 'jkl012');
    await book.set({ scope: 'Summarize my day', trigger: 'daily', at: '21:00', gate: 'act_and_report', escalation: 'message_owner' });
    expect(await book.cancel('order:jkl012')).toBe(true);
    expect(scheduler.cancelled).toEqual(['order:jkl012']);
    expect(book.list()).toEqual([]);
    expect(await book.cancel('order:missing')).toBe(false);
  });
});

describe('standing orders prompt', () => {
  it('renders the legend and one line per order, empty when none', async () => {
    const sql = fakeSql();
    const scheduler = fakeScheduler();
    let n = 0;
    const book = standingOrderBook(sql as never, scheduler as never, clock, () => `mno34${(n += 1)}`);
    expect(standingOrdersPrompt(book)).toBe('');
    await book.set({ scope: 'Never book before 10am', trigger: 'every_turn', gate: 'confirm_first', escalation: 'message_owner' });
    await book.set({ scope: 'Summarize my day', trigger: 'daily', at: '21:00', gate: 'act_and_report', escalation: 'message_owner' });
    const prompt = standingOrdersPrompt(book);
    expect(prompt).toContain('Standing orders from the owner');
    expect(prompt).toContain('a confirm_first order is never license to act without the owner');
    expect(prompt).toContain('- [order:mno341] Never book before 10am (applies every turn; gate: confirm with the owner before acting)');
    expect(prompt).toContain('Summarize my day (runs daily at 21:00; gate: act and report)');
  });
});

describe('standing order fire text', () => {
  it('carries the gate semantics into the machine turn', () => {
    const base = { id: 'order:x', scope: 'Summarize my day', trigger: 'daily' as const, at: '21:00', created_at: 0 };
    expect(standingOrderFireText({ ...base, gate: 'confirm_first', escalation: 'message_owner' })).toBe(
      '[Standing order due now, set earlier by the owner: "Summarize my day"] Prepare what you would do and report it; make no changes until the owner confirms in chat.',
    );
    expect(standingOrderFireText({ ...base, gate: 'act_and_report', escalation: 'log_only' })).toBe(
      '[Standing order due now, set earlier by the owner: "Summarize my day"] Do it now, then report what you did.',
    );
  });
});

describe('standing order tools', () => {
  const sql = fakeSql();
  const scheduler = fakeScheduler();
  const book = standingOrderBook(sql as never, scheduler as never, clock, () => 'pqr678');
  const [set, list, cancel] = standingOrderHandlers(book);

  it('are chat-turn tools: owner writes live only on user_message', () => {
    for (const handler of [set!, list!, cancel!]) {
      expect(handler.trigger_allowlist).toEqual(['user_message']);
      expect(TOOL_PERMISSIONS.user_message).toContain(handler.name);
    }
    expect(set!.mutates_state).toBe(true);
    expect(cancel!.mutates_state).toBe(true);
  });

  it('sets, lists and cancels through the book', async () => {
    expect(await set!.handle({ scope: 'Never book before 10am', trigger: 'every_turn', gate: 'confirm_first', escalation: 'message_owner' } as never)).toMatchObject({ ok: true, data: { id: 'order:pqr678' } });
    expect(await list!.handle({} as never)).toMatchObject({ ok: true, data: { orders: [{ scope: 'Never book before 10am' }] } });
    expect(await cancel!.handle({ id: 'order:pqr678' } as never)).toMatchObject({ ok: true, data: { cancelled: true } });
  });

  it('returns a readable error for a daily order without a time', async () => {
    expect(await set!.handle({ scope: 'x', trigger: 'daily', gate: 'act_and_report', escalation: 'message_owner' } as never)).toMatchObject({ ok: false, code: 'invalid_args', error: 'a daily standing order needs its local HH:MM time' });
  });

  it('E3: cancelling an every-turn order the scheduler does not know still reports it removed; an unknown id reports false', async () => {
    const sql = fakeSql();
    const scheduler = fakeScheduler();
    const book = standingOrderBook(sql as never, scheduler as never, clock, () => 'every1');
    await book.set({ scope: 'Keep replies short', trigger: 'every_turn', gate: 'act_and_report', escalation: 'message_owner' });
    expect(await book.cancel('order:every1')).toBe(true);
    expect(book.byId('order:every1')).toBeNull();
    expect(await book.cancel('order:every1')).toBe(false);
  });

  it('E4: a failed scheduler arm leaves no active daily order behind and the failure still surfaces', async () => {
    const sql = fakeSql();
    const scheduler = { ...fakeScheduler(), async schedule() { throw new Error('scheduler unavailable'); } };
    const book = standingOrderBook(sql as never, scheduler as never, clock, () => 'daily1');
    await expect(book.set({ scope: 'Summarize my day', trigger: 'daily', at: '21:00', gate: 'act_and_report', escalation: 'message_owner' })).rejects.toThrow('scheduler unavailable');
    expect(book.list()).toHaveLength(0);
  });

  it('E4: a scheduler that stored the armed row and then failed to re-arm is cancelled too, so no orphan recurring schedule remains', async () => {
    const sql = fakeSql();
    const base = fakeScheduler();
    const scheduler = {
      ...base,
      async schedule(input: { id: string; kind: string; dueAt: number; occurrenceAt: number; recurrence?: unknown }) {
        await base.schedule(input); // row stored first, as the real Scheduler does
        throw new Error('alarm registration rejected');
      },
    };
    const book = standingOrderBook(sql as never, scheduler as never, clock, () => 'daily2');
    await expect(book.set({ scope: 'Summarize my day', trigger: 'daily', at: '21:00', gate: 'act_and_report', escalation: 'message_owner' })).rejects.toThrow('alarm registration rejected');
    expect(book.list()).toHaveLength(0);
    expect(base.cancelled).toEqual(['order:daily2']);
    expect(base.armed).toHaveLength(0); // no orphan recurring schedule is left armed
  });
});

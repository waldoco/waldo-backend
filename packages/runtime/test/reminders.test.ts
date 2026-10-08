import { describe, expect, it } from 'vitest';
import { cancelReminderArgsSchema, setReminderArgsSchema, setStandingOrderArgsSchema, TOOL_PERMISSIONS } from '@waldo/contracts';
import { nextOccurrence } from '../src/scheduler/multiplexer';
import { localIso, localToEpoch, reminderHandlers, type ReminderBook } from '../src/channels/reminders';


describe('reminder time', () => {
  it('reads owner wall-clock time in their timezone', () => {
    expect(localToEpoch('2026-09-23T18:30', 'Asia/Kolkata')).toBe(Date.parse('2026-09-23T13:00:00Z'));
    expect(localIso(Date.parse('2026-09-23T13:00:00Z'), 'Asia/Kolkata')).toBe('2026-09-23T18:30');
  });

  it('handles DST zones', () => {
    expect(localToEpoch('2026-07-01T09:00', 'America/New_York')).toBe(Date.parse('2026-07-01T13:00:00Z'));
    expect(localToEpoch('2026-12-01T09:00', 'America/New_York')).toBe(Date.parse('2026-12-01T14:00:00Z'));
  });
});

describe('reminder tools', () => {
  const calls: string[] = [];
  const book: ReminderBook = {
    async set(args) {
      if (args.at < '2026') throw new Error('already past');
      calls.push(`set:${args.note}`);
      return { id: 'reminder:1', ...args };
    },
    list: () => [{ id: 'reminder:1', note: 'water', at: '2026-09-23T18:30', repeat: 'daily' }],
    async cancel(id) { calls.push(`cancel:${id}`); return id === 'reminder:1'; },
    async cancelAll() { return 0; },
    note: () => null,
    fired: () => undefined,
  };
  const [set, list, cancel] = reminderHandlers(book);

  it('are chat-only tools', () => {
    for (const handler of [set!, list!, cancel!]) {
      expect(handler.trigger_allowlist).toEqual(['user_message']);
      expect(TOOL_PERMISSIONS.user_message).toContain(handler.name);
    }
  });

  it('set, list and cancel through the book', async () => {
    expect(await set!.handle({ note: 'water', at: '2026-09-23T18:30', repeat: 'daily' } as never)).toMatchObject({ ok: true, data: { id: 'reminder:1' } });
    expect(await list!.handle({} as never)).toMatchObject({ ok: true, data: { reminders: [{ note: 'water' }] } });
    expect(await cancel!.handle({ id: 'reminder:1' } as never)).toMatchObject({ ok: true, data: { cancelled: true } });
    expect(calls).toEqual(['set:water', 'cancel:reminder:1']);
  });

  it('returns a readable error for a past time', async () => {
    expect(await set!.handle({ note: 'x', at: '2025-01-01T09:00', repeat: 'none' } as never)).toMatchObject({ ok: false, code: 'invalid_args', error: 'already past' });
  });
});

describe('cancel all reminders contract (T32 contract repro, not live trace)', () => {
  it('accepts all or one id, but rejects neither or both', () => {
    expect(cancelReminderArgsSchema.safeParse({ all: true }).success).toBe(true);
    expect(cancelReminderArgsSchema.safeParse({ id: 'reminder:1' }).success).toBe(true);
    for (const args of [{}, { all: false }, { id: 'reminder:1', all: true }]) {
      expect(cancelReminderArgsSchema.safeParse(args).success).toBe(false);
    }
  });

  it('bulk cancellation returns the count without requiring ids from the model', async () => {
    const book = { async cancelAll() { return 2; } } as unknown as ReminderBook;
    const handler = reminderHandlers(book)[2]!;
    expect(await handler.handle({ all: true } as never)).toMatchObject({ ok: true, data: { cancelled: 2 } });
  });
});

describe('reminder recurrence contract', () => {
  it('accepts daily, weekdays, weekly and validated cron, rejecting mismatched cron args', () => {
    const base = { note: 'standup', at: '2026-10-09T09:00' };
    for (const repeat of ['none', 'daily', 'weekdays', 'weekly']) expect(setReminderArgsSchema.safeParse({ ...base, repeat }).success).toBe(true);
    expect(setReminderArgsSchema.safeParse({ ...base, repeat: 'cron', cron: '0 9 * * 1-5' }).success).toBe(true);
    for (const args of [{ repeat: 'cron' }, { repeat: 'cron', cron: '99 9 * * *' }, { repeat: 'cron', cron: '0 0 0 0 0' }, { repeat: 'daily', cron: '0 9 * * *' }]) {
      expect(setReminderArgsSchema.safeParse({ ...base, ...args }).success).toBe(false);
    }
  });
});

describe('owner-local DST recurrence edge cases', () => {
  it('a weekly spring-gap time moves to the first valid minute on the same weekday', () => {
    expect(nextOccurrence({ type: 'weekly_local', time: '02:30', timezone: 'America/New_York', weekday: 0 }, Date.parse('2026-03-07T15:00:00Z'))).toBe(Date.parse('2026-03-08T07:00:00Z'));
  });
  it('a weekly fall overlap fires once at the first occurrence, not again after completion', () => {
    const recurrence = { type: 'weekly_local' as const, time: '01:30', timezone: 'America/New_York', weekday: 0 };
    const first = nextOccurrence(recurrence, Date.parse('2026-10-31T15:00:00Z'));
    expect(first).toBe(Date.parse('2026-11-01T05:30:00Z'));
    expect(nextOccurrence(recurrence, first)).toBe(Date.parse('2026-11-08T06:30:00Z'));
  });
  it('standing order schema validates the same cron contract', () => {
    for (const trigger of ['daily', 'weekdays', 'weekly']) expect(setStandingOrderArgsSchema.safeParse({ scope: 'review', trigger, at: '09:00' }).success).toBe(true);
    expect(setStandingOrderArgsSchema.safeParse({ scope: 'review', trigger: 'cron', cron: '0 9 * * 1-5' }).success).toBe(true);
    for (const args of [{ trigger: 'cron' }, { trigger: 'cron', cron: '99 9 * * *' }, { trigger: 'daily', cron: '0 9 * * *' }]) expect(setStandingOrderArgsSchema.safeParse({ scope: 'review', ...args }).success).toBe(false);
  });
});

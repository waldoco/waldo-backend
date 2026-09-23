import { describe, expect, it } from 'vitest';
import { TOOL_PERMISSIONS } from '@waldo/contracts';
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

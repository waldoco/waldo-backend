import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { approvalDesk, UNDO_WINDOW_MS } from '../src/channels/approvals';
import type { GoogleClient } from '../src/connectors/google';

const TEAM = 'team@group.calendar.google.com';
const iso = (s: string) => s as never;

it('a guest invite shows its calendar, guests, place, Meet link and emailing on the card, and applies and undoes on that calendar', async () => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('approval-calendar-guests')), async (_instance, state) => {
    const sent: string[] = [];
    const calls: unknown[][] = [];
    let now = 1_000_000;
    let n = 0;
    const client = {
      account: { connection_id: 'local:owner@example.com', email: 'owner@example.com' },
      event: async (id: string, calendarId?: string) => { calls.push(['event', id, calendarId]); return { id, title: 'Standup', start: '2026-09-23T18:00:00+05:30', end: '2026-09-23T18:15:00+05:30', all_day: false, etag: id === 'new1' ? 'v2' : 'v1', ...(id === 'e1' ? { attendees: 3 } : {}) }; },
      createEvent: async (input: Record<string, unknown>) => { calls.push(['create', input]); return { id: 'new1', title: 'Design review', start: '', end: '', all_day: false, etag: 'v2' }; },
      moveEvent: async (...args: unknown[]) => { calls.push(['move', ...args]); return { id: 'e1', title: 'Standup', start: '', end: '', all_day: false, etag: 'v3' }; },
      cancelEvent: async (...args: unknown[]) => { calls.push(['cancel', ...args]); },
    } as unknown as GoogleClient;
    const desk = approvalDesk(state.storage.sql, {
      call: async (method, body) => { if (method === 'sendMessage') sent.push(String((body as { text?: string }).text)); return {}; },
      owner: 42, google: async () => client, newId: () => String(++n), now: () => now, timezone: 'Asia/Kolkata', log: () => undefined,
    });

    const invite = await desk.propose({ action: 'create', title: 'Design review', start: iso('2026-09-24T10:00:00+05:30'), end: iso('2026-09-24T10:30:00+05:30'), reason: 'Sam asked',
      calendar_id: TEAM, attendees: ['sam@example.com', 'pat@example.org'], send_updates: 'all', location: 'Room 4', add_meet_link: true, description: 'Agenda' });
    const card = sent.at(-1)!;
    for (const shown of [TEAM, 'sam@example.com', 'pat@example.org', 'Room 4', 'Meet link', 'Google emails the 2 guests']) expect(card).toContain(shown);

    await desk.callback({ id: 'q1', from: { id: 42 }, data: `a:${invite}`, message: { message_id: 5, chat: { id: 42 } } }, 't');
    const create = calls.find((call) => call[0] === 'create')![1] as Record<string, unknown>;
    expect(create).toMatchObject({ calendarId: TEAM, attendees: ['sam@example.com', 'pat@example.org'], sendUpdates: 'all', location: 'Room 4', meet: true, description: 'Agenda' });

    now += UNDO_WINDOW_MS - 1;
    await desk.callback({ id: 'q2', from: { id: 42 }, data: `u:${invite}` }, 't');
    expect(calls.filter((call) => call[0] === 'event').at(-1)).toEqual(['event', 'new1', TEAM]);
    expect(calls.find((call) => call[0] === 'cancel')!.slice(1)).toEqual(['new1', 'v2', expect.any(String), { calendarId: TEAM, sendUpdates: 'all' }]);

    const silent = await desk.propose({ action: 'move', event_id: 'e1', title: 'Standup', start: iso('2026-09-25T18:00:00+05:30'), end: iso('2026-09-25T18:15:00+05:30'), calendar_id: TEAM, reason: 'clash' });
    expect(sent.at(-1)).toContain('Google does not email the 3 guests');
    const solo = await desk.propose({ action: 'create', title: 'Walk', start: iso('2026-09-26T07:00:00+05:30'), end: iso('2026-09-26T07:30:00+05:30'), reason: 'morning' });
    expect(sent.at(-1)).not.toMatch(/guest|email/i);
    expect(solo).toMatch(/^p/);
    await desk.callback({ id: 'q3', from: { id: 42 }, data: `a:${silent}`, message: { message_id: 6, chat: { id: 42 } } }, 't');
    expect(calls.find((call) => call[0] === 'move')!.slice(1)).toEqual(['e1', '2026-09-25T18:00:00+05:30', '2026-09-25T18:15:00+05:30', 'v1', expect.any(String), { calendarId: TEAM }]);
    expect(calls.filter((call) => call[0] === 'event').every((call) => call[2] === TEAM)).toBe(true);
  });
});

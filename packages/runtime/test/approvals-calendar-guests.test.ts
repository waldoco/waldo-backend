import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { approvalDesk, UNDO_WINDOW_MS } from '../src/channels/approvals';
import { ownerEffectLedger } from '../src/channels/owner-effect-ledger';
import { GoogleError, type CalendarItem, type GoogleClient } from '../src/connectors/google';

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
      calendar_id: TEAM, attendees: ['sam@example.com', 'pat@example.org'], send_updates: 'all', location: 'Room 4', add_meet_link: true, description: 'Agenda: launch plan\nBring the Q3 numbers' });
    const card = sent.at(-1)!;
    for (const shown of [TEAM, 'sam@example.com', 'pat@example.org', 'Room 4', 'Meet link', 'Google emails the 2 guests', 'Notes on the event, which every guest can read:\nAgenda: launch plan\nBring the Q3 numbers']) expect(card).toContain(shown);

    await desk.callback({ id: 'q1', from: { id: 42 }, data: `a:${invite}`, message: { message_id: 5, chat: { id: 42 } } }, 't');
    const create = calls.find((call) => call[0] === 'create')![1] as Record<string, unknown>;
    expect(create).toMatchObject({ calendarId: TEAM, attendees: ['sam@example.com', 'pat@example.org'], sendUpdates: 'all', location: 'Room 4', meet: true, description: 'Agenda: launch plan\nBring the Q3 numbers' });

    now += UNDO_WINDOW_MS - 1;
    await desk.callback({ id: 'q2', from: { id: 42 }, data: `u:${invite}` }, 't');
    expect(calls.filter((call) => call[0] === 'event').at(-1)).toEqual(['event', 'new1', TEAM]);
    expect(calls.find((call) => call[0] === 'cancel')!.slice(1)).toEqual(['new1', 'v2', expect.any(String), { calendarId: TEAM, sendUpdates: 'all' }]);

    const silent = await desk.propose({ action: 'move', event_id: 'e1', title: 'Standup', start: iso('2026-09-25T18:00:00+05:30'), end: iso('2026-09-25T18:15:00+05:30'), calendar_id: TEAM, reason: 'clash' });
    expect(sent.at(-1)).toContain('Google does not email the 3 guests');
    const solo = await desk.propose({ action: 'create', title: 'Walk', start: iso('2026-09-26T07:00:00+05:30'), end: iso('2026-09-26T07:30:00+05:30'), reason: 'morning', description: 'Loop the park' });
    expect(sent.at(-1)).toContain('Notes on the event:\nLoop the park');
    expect(sent.at(-1)).not.toMatch(/guest|email/i);
    expect(solo).toMatch(/^p/);
    await desk.callback({ id: 'q3', from: { id: 42 }, data: `a:${silent}`, message: { message_id: 6, chat: { id: 42 } } }, 't');
    expect(calls.find((call) => call[0] === 'move')!.slice(1)).toEqual(['e1', '2026-09-25T18:00:00+05:30', '2026-09-25T18:15:00+05:30', 'v1', expect.any(String), { calendarId: TEAM }]);
    expect(calls.filter((call) => call[0] === 'event').every((call) => call[2] === TEAM)).toBe(true);
  });
});

it('a move or cancel with no calendar or emailing choice sends no options, so its intent bytes match a change proposed before them', async () => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('approval-calendar-no-options')), async (_instance, state) => {
    const calls: unknown[][] = [];
    let n = 0;
    const client = {
      account: { connection_id: 'local:owner@example.com', email: 'owner@example.com' },
      event: async (id: string) => ({ id, title: 'Standup', start: '2026-09-23T18:00:00+05:30', end: '2026-09-23T18:15:00+05:30', all_day: false, etag: 'v1' }),
      moveEvent: async (...args: unknown[]) => { calls.push(['move', ...args]); return { id: 'e1', title: 'Standup', start: '', end: '', all_day: false, etag: 'v2' }; },
      cancelEvent: async (...args: unknown[]) => { calls.push(['cancel', ...args]); },
    } as unknown as GoogleClient;
    const desk = approvalDesk(state.storage.sql, { call: async () => ({}), owner: 42, google: async () => client, newId: () => String(++n), now: () => 1_000_000, timezone: 'Asia/Kolkata', log: () => undefined });
    const move = await desk.propose({ action: 'move', event_id: 'e1', title: 'Standup', start: iso('2026-09-25T18:00:00+05:30'), end: iso('2026-09-25T18:15:00+05:30'), reason: 'clash' });
    await desk.decide(move, 'a', 't');
    const cancel = await desk.propose({ action: 'cancel', event_id: 'e2', title: 'Standup', reason: 'off' });
    await desk.decide(cancel, 'a', 't');
    expect(calls.map((call) => call.at(-1))).toEqual([undefined, undefined]);
  });
});

// A lost response is recovered by reading the event back where the change put it. Read anywhere
// else, the event is not found and the outcome would stay unknown.
it('recovers a lost create and a lost undo by reading the event back on its own calendar', async () => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('approval-calendar-readback')), async (_instance, state) => {
    let now = 1_000_000;
    let n = 0;
    const start = '2026-09-24T10:00:00+05:30', end = '2026-09-24T10:30:00+05:30';
    const events = new Map<string, CalendarItem>();
    let loseNext = true;
    const lose = () => { if (loseNext) { loseNext = false; throw new Error('lost response'); } };
    const client = {
      account: { connection_id: 'local:owner@example.com', email: 'owner@example.com' },
      event: async (id: string, calendarId?: string) => { const found = calendarId === TEAM ? events.get(id) : undefined; if (!found) throw new GoogleError(404, 'google 404: not found'); return found; },
      createEvent: async (input: { id: string; title: string; operationMarker: string }) => {
        const made = { id: input.id, title: input.title, start, end, all_day: false, etag: `made-${input.id}`, operation_marker: input.operationMarker };
        events.set(input.id, made); lose(); return made;
      },
      cancelEvent: async (id: string, _etag: string, marker: string) => { events.set(id, { ...events.get(id)!, status: 'cancelled', etag: 'gone', operation_marker: marker }); lose(); },
    } as unknown as GoogleClient;
    const desk = approvalDesk(state.storage.sql, { call: async () => ({}), owner: 42, google: async () => client, newId: () => String(++n), now: () => now, timezone: 'Asia/Kolkata', log: () => undefined, effects: ownerEffectLedger(state.storage, () => now) });
    const propose = () => desk.propose({ action: 'create', title: 'Design review', start: iso(start), end: iso(end), reason: 'Sam asked', calendar_id: TEAM });

    expect((await desk.decide(await propose(), 'a', 't')).toast).toBe('Done');

    const kept = await propose();
    expect((await desk.decide(kept, 'a', 't')).toast).toBe('Done');
    loseNext = true;
    now += 1_000;
    expect((await desk.decide(kept, 'u', 't')).toast).toBe('Undone');
  });
});

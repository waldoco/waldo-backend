import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { CAPACITY_BODY_KEY, CAPACITY_NOTE_KEY, calendarShape, capacityDays, capacityNote, cardCapacityNote, keepCapacityNote, runCapacityPass, type CapacityPassDeps } from '../src/channels/capacity';
import type { CalendarItem, GoogleClient } from '../src/connectors/google';
import { claimStore } from '../src/memory/claims';
import { BODY_WITHDRAWN, CAPACITY_LINES, NO_CALENDAR, NO_SHARED_HEALTH } from '../src/prompt/capacity';
import { DAY_CARDS, dayCardPrompt } from '../src/prompt/day-cards';

// CAPACITY_PLAN: the capacity note is the model's; these check what reaches it and what is kept, never its words. Every
// title, note and zone word is synthetic.
let sequence = 0;
const inObject = (fn: (state: DurableObjectState) => Promise<void> | void) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`capacity-${sequence++}`)), (_instance, state) => fn(state));
const event = (id: string, title: string, start: string, end: string, extra: Partial<CalendarItem> = {}): CalendarItem => ({ id, title, start, end, all_day: false, ...extra });
const reply = (note: string | null) => JSON.stringify({ note, evidence: 'the past week of calendar shape' });
const NOTE = 'Owner does their best focused work before lunch and holds about one long block a day; afternoons after back-to-back meetings run flat.';

describe('the calendar shape the pass reads', () => {
  it('counts commitments, committed time and the longest gap, and carries no title, person or place', () => {
    const items = [
      event('a', 'Board review with Priya', '2026-11-04T09:00:00Z', '2026-11-04T10:30:00Z', { location: 'Room Juniper', attendee_names: ['Priya'] }),
      event('b', 'Standup', '2026-11-04T10:00:00Z', '2026-11-04T11:00:00Z'),
      event('c', 'Investor call', '2026-11-04T14:00:00Z', '2026-11-04T15:00:00Z'),
      event('d', 'Deep work', '2026-11-04T12:00:00Z', '2026-11-04T13:00:00Z', { waldo_made: true }),
      event('e', 'Offsite', '2026-11-04', '2026-11-05', { all_day: true }),
      event('f', 'Cancelled lunch', '2026-11-04T12:00:00Z', '2026-11-04T13:00:00Z', { status: 'cancelled' }),
    ];
    const shape = calendarShape(items, ['2026-11-03', '2026-11-04', '2026-11-05'], 'UTC', Date.parse('2026-11-04T12:00:00Z'));
    expect(shape.split('\n')).toEqual([
      'Tue 3 Nov (lived): no commitments',
      'Wed 4 Nov (under way): 3 commitments, 3h00 committed, 09:00 to 15:00, longest gap 3h00; 1 all-day; 1 block Waldo made',
      'Thu 5 Nov (ahead): no commitments',
    ]);
    for (const word of ['Board', 'Priya', 'Juniper', 'Standup', 'Investor', 'Offsite', 'lunch']) expect(shape).not.toContain(word);
  });

  it('reads London\'s 25-hour day by the clock the owner lives by', () => {
    // 25 October 2026: clocks go back at 02:00, so 00:30 to 03:00 local is three and a half hours.
    const shape = calendarShape([event('n', 'Night shift', '2026-10-24T23:30:00Z', '2026-10-25T03:00:00Z')], ['2026-10-24', '2026-10-25'], 'Europe/London', Date.parse('2026-10-26T03:00:00Z'));
    expect(shape.split('\n')).toEqual(['Sat 24 Oct (lived): no commitments', 'Sun 25 Oct (lived): 1 commitment, 3h30 committed, 00:30 to 03:00, longest gap 0h00']);
  });

  it('splits an event across the owner\'s local midnight, in their zone', () => {
    // 03:00 the next morning in Kolkata, when the nightly pass runs: Wednesday is lived, Thursday under way.
    const shape = calendarShape([event('x', 'Late call', '2026-11-04T17:30:00Z', '2026-11-04T19:30:00Z')], ['2026-11-04', '2026-11-05'], 'Asia/Kolkata', Date.parse('2026-11-04T21:30:00Z'));
    expect(shape.split('\n')).toEqual(['Wed 4 Nov (lived): 1 commitment, 1h00 committed, 23:00 to 00:00, longest gap 0h00', 'Thu 5 Nov (under way): 1 commitment, 1h00 committed, 00:00 to 01:00, longest gap 0h00']);
  });

  it('runs from a week back to tomorrow in the owner\'s local days, across a clock change', () => {
    expect(capacityDays(Date.parse('2026-10-26T23:30:00Z'), 'Europe/London')).toEqual(['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27']);
    expect(capacityDays(Date.parse('2026-10-26T23:30:00Z'), 'Asia/Kolkata').at(-1)).toBe('2026-10-28');
  });
});

describe('the capacity note in memory', () => {
  it('is kept as one inferred health note in the mind area, and a newer one replaces it', () => inObject(state => {
    const store = claimStore(state.storage.sql, work => state.storage.transactionSync(work));
    expect(keepCapacityNote(store, state.storage.kv, reply(NOTE), '2026-11-05T02:00:00Z', false)).toBe('kept');
    const first = capacityNote(store, state.storage.kv)!;
    expect(first).toMatchObject({ text: NOTE, owner: false });
    expect(store.claims().find(claim => claim.id === first.id)).toMatchObject({ kind: 'health', source: 'inferred', area: 'mind' });
    const NEWER = 'Owner holds one long focus block before lunch on most days; a second block after a heavy meeting day has not held.';
    expect(keepCapacityNote(store, state.storage.kv, reply(NEWER), '2026-11-06T02:00:00Z', false)).toBe('kept');
    expect(store.claims().filter(claim => claim.text === NOTE || claim.text === NEWER).map(claim => claim.text)).toEqual([NEWER]);
    expect(capacityNote(store, state.storage.kv)?.text).toBe(NEWER);
  }));

  it('stays as it is when the model has nothing new, or says the same', () => inObject(state => {
    const store = claimStore(state.storage.sql, work => state.storage.transactionSync(work));
    keepCapacityNote(store, state.storage.kv, reply(NOTE), '2026-11-05T02:00:00Z', false);
    const id = capacityNote(store, state.storage.kv)!.id;
    expect(keepCapacityNote(store, state.storage.kv, reply(null), '2026-11-06T02:00:00Z', false)).toBe('unchanged');
    expect(keepCapacityNote(store, state.storage.kv, reply(NOTE), '2026-11-06T02:00:00Z', false)).toBe('unchanged');
    expect(capacityNote(store, state.storage.kv)?.id).toBe(id);
  }));

  it('holds a note that carries a body reading, and keeps the one before it', () => inObject(state => {
    const store = claimStore(state.storage.sql, work => state.storage.transactionSync(work));
    keepCapacityNote(store, state.storage.kv, reply(NOTE), '2026-11-05T02:00:00Z', false);
    expect(keepCapacityNote(store, state.storage.kv, reply('Owner focuses best when resting HR is 52 bpm.'), '2026-11-06T02:00:00Z', false)).toBe('held');
    expect(capacityNote(store, state.storage.kv)?.text).toBe(NOTE);
    expect(store.claims().some(claim => claim.text.includes('bpm'))).toBe(false);
  }));

  it('follows the owner\'s correction, and is gone when they dismiss it', () => inObject(state => {
    const store = claimStore(state.storage.sql, work => state.storage.transactionSync(work));
    keepCapacityNote(store, state.storage.kv, reply(NOTE), '2026-11-05T02:00:00Z', false);
    const OWNED = 'I do my best thinking after 4pm, not mornings.';
    expect(store.correct(capacityNote(store, state.storage.kv)!.id, { kind: 'health', text: OWNED, source: 'stated', evidence: `"${OWNED}"`, origin: 'owner', source_ref: 'app:message-1' }, '2026-11-05T09:00:00Z')).toBe(true);
    expect(capacityNote(store, state.storage.kv)).toMatchObject({ text: OWNED, owner: true });
    store.setStatus(capacityNote(store, state.storage.kv)!.id, 'dismissed');
    expect(capacityNote(store, state.storage.kv)).toBeNull();
    expect(state.storage.kv.get(CAPACITY_NOTE_KEY)).toBeUndefined();
  }));
});

describe('the nightly capacity pass', () => {
  const client = (items: readonly CalendarItem[]) => ({ events: async () => items }) as unknown as GoogleClient;
  const deps = (state: DurableObjectState, over: Partial<CapacityPassDeps> & Readonly<{ asked: string[] }>): CapacityPassDeps => ({
    store: claimStore(state.storage.sql, work => state.storage.transactionSync(work)), kv: state.storage.kv, timezone: 'UTC', now: () => Date.parse('2026-11-05T02:00:00Z'),
    healthNotes: true, health: async () => null, google: async () => client([]), ask: async input => { over.asked.push(input); return reply(NOTE); }, ...over,
  });

  it('without shared health, says so and reads the calendar as shape', () => inObject(async state => {
    const asked: string[] = [];
    expect(await runCapacityPass(deps(state, { asked, google: async () => client([event('a', 'Board review with Priya', '2026-11-04T09:00:00Z', '2026-11-04T10:00:00Z')]) }))).toBe('kept');
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain(NO_SHARED_HEALTH);
    expect(asked[0]).toContain('Wed 4 Nov (lived): 1 commitment');
    expect(asked[0]).not.toContain('Priya');
  }));

  it('with shared health, gives the model its words, and the next night the note it kept', () => inObject(async state => {
    const asked: string[] = [];
    const SHARED = 'Recovery zone: low. Trend: declining.';
    await runCapacityPass(deps(state, { asked, health: async () => SHARED }));
    await runCapacityPass(deps(state, { asked, health: async () => SHARED, ask: async input => { asked.push(input); return reply(null); } }));
    expect(asked[0]).toContain(SHARED);
    expect(asked[0]).not.toContain(NO_SHARED_HEALTH);
    expect(asked[1]).toContain(NOTE);
  }));

  it('says when the calendar is not connected', () => inObject(async state => {
    const asked: string[] = [];
    await runCapacityPass(deps(state, { asked, google: async () => null }));
    expect(asked[0]).toContain(NO_CALENDAR);
  }));

  it('once the owner stops sharing health, asks for a note without the body, and retires one the model cannot rewrite', () => inObject(async state => {
    const asked: string[] = [];
    const SHARED = 'Recovery zone: low. Trend: declining.';
    await runCapacityPass(deps(state, { asked, health: async () => SHARED }));
    expect(state.storage.kv.get(CAPACITY_BODY_KEY)).toBe(true);
    expect(await runCapacityPass(deps(state, { asked, ask: async input => { asked.push(input); return reply(null); } }))).toBe('retired');
    expect(asked[1]).toContain(BODY_WITHDRAWN);
    expect(capacityNote(claimStore(state.storage.sql), state.storage.kv)).toBeNull();
    // Written again without the body, the note stays when sharing is still off.
    await runCapacityPass(deps(state, { asked }));
    expect(state.storage.kv.get(CAPACITY_BODY_KEY)).toBe(false);
    expect(asked[2]).not.toContain(BODY_WITHDRAWN);
    expect(await runCapacityPass(deps(state, { asked, ask: async input => { asked.push(input); return reply(null); } }))).toBe('unchanged');
  }));

  it('rewrites the note without the body when the model can', () => inObject(async state => {
    const asked: string[] = [];
    await runCapacityPass(deps(state, { asked, health: async () => 'Recovery zone: good.' }));
    const CALENDAR_ONLY = 'Owner keeps their mornings free of meetings and holds one long focus block there most days.';
    expect(await runCapacityPass(deps(state, { asked, ask: async input => { asked.push(input); return reply(CALENDAR_ONLY); } }))).toBe('kept');
    expect(capacityNote(claimStore(state.storage.sql), state.storage.kv)?.text).toBe(CALENDAR_ONLY);
    expect(state.storage.kv.get(CAPACITY_BODY_KEY)).toBe(false);
  }));

  it('asks nothing when the owner turned health notes off, or wrote the note themselves', () => inObject(async state => {
    const asked: string[] = [];
    expect(await runCapacityPass(deps(state, { asked, healthNotes: false }))).toBe('health_notes_off');
    await runCapacityPass(deps(state, { asked }));
    const store = claimStore(state.storage.sql, work => state.storage.transactionSync(work));
    store.correct(capacityNote(store, state.storage.kv)!.id, { kind: 'health', text: 'Mornings are for the kids; I focus after 8pm.', source: 'stated', evidence: '"I focus after 8pm"', origin: 'owner', source_ref: 'app:message-2' }, '2026-11-05T09:00:00Z');
    asked.length = 0;
    expect(await runCapacityPass(deps(state, { asked }))).toBe('owner_held');
    expect(asked).toEqual([]);
    expect(capacityNote(store, state.storage.kv)?.text).toBe('Mornings are for the kids; I focus after 8pm.');
  }));
});

describe('the note a day card reads', () => {
  it('none with health notes off, none drawn from a body no longer shared, and the owner\'s own always', () => inObject(state => {
    const store = claimStore(state.storage.sql, work => state.storage.transactionSync(work));
    keepCapacityNote(store, state.storage.kv, reply(NOTE), '2026-11-05T02:00:00Z', true);
    expect(cardCapacityNote(store, state.storage.kv, true, true)).toBe(NOTE);
    expect(cardCapacityNote(store, state.storage.kv, true, false)).toBeNull();
    expect(cardCapacityNote(store, state.storage.kv, false, true)).toBeNull();
    const OWNED = 'I do my best thinking after 4pm.';
    store.correct(capacityNote(store, state.storage.kv)!.id, { kind: 'health', text: OWNED, source: 'stated', evidence: `"${OWNED}"`, origin: 'owner', source_ref: 'app:message-3' }, '2026-11-05T09:00:00Z');
    expect(cardCapacityNote(store, state.storage.kv, true, false)).toBe(OWNED);
  }));
});

describe('the day cards with CAPACITY_PLAN', () => {
  const context = { calendar: '(none)', ledger: '', today: '', updates: '' };
  const card = (id: string) => DAY_CARDS.find(entry => entry.id === id)!;
  const prompt = (id: string, capacity: boolean, planning = false) => dayCardPrompt(card(id), '2026-11-05T08:00', context, planning, false, capacity);

  it('the Brief shapes the day\'s deep work and may offer the reset; planning, it may put both on cards', () => {
    expect(prompt('card:brief', true)).toContain(CAPACITY_LINES.brief);
    expect(prompt('card:brief', true, true)).toContain(CAPACITY_LINES.planningBrief);
    expect(prompt('card:brief', true, true)).not.toContain(CAPACITY_LINES.brief);
  });

  it('the Close says tomorrow\'s shape; the Check-in is unchanged', () => {
    expect(prompt('card:close', true)).toContain(CAPACITY_LINES.close);
    expect(prompt('card:midday', true)).toBe(prompt('card:midday', false));
  });

  it('with the switch off every card is as before', () => {
    for (const entry of DAY_CARDS) expect(prompt(entry.id, false)).toBe(dayCardPrompt(entry, '2026-11-05T08:00', context));
  });
});

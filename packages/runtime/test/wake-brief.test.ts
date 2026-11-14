import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { applyDayPlan, applyWake, armDayCards, dayPlanBook, parseWakeReply, SET_FOR_TODAY, takeWakeTurn, wakeTarget, wakeTurnsPerDay, MOVED_EARLIER } from '../src/channels/day-cards';
import { reopensAt } from '../src/channels/interruptions';
import { sleepJustEnded, wakeFreshMs } from '../src/health/wake-notice';
import { DAY_CARDS, dayCardPrompt, dayPlanInput, PROSE_RULE, SCHEDULE_HEADING, SCHEDULE_RULE } from '../src/prompt/day-cards';
import { sanitise } from '../src/scribe/sanitiser';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';
import { ensureSchema } from '../src/tracer/schema';

const FRESH = wakeFreshMs(undefined);
const night = (endMs: number, extra: Record<string, unknown> = {}) => ({
  sample_id: `sleep-${endMs}`, revision: 1, signal: 'sleep_duration', unit: 'minutes', value: 420,
  start_at: new Date(endMs - 8 * 3_600_000).toISOString(), end_at: new Date(endMs).toISOString(), day: '2026-11-04', utc_offset_minutes: 330, ...extra,
});

describe('a night that just ended', () => {
  const now = Date.parse('2026-11-04T01:30:00Z');
  it('is one whose last asleep interval ended within the configured window', () => {
    expect(FRESH).toBe(180 * 60_000);
    expect(sleepJustEnded([night(now - 10 * 60_000)], now, FRESH)).toBe(true);
    expect(sleepJustEnded([night(now - FRESH + 60_000)], now, FRESH)).toBe(true);
    expect(sleepJustEnded([night(now + 2 * 60_000)], now, FRESH)).toBe(true);
    expect(sleepJustEnded([night(now - 60 * 60_000)], now, wakeFreshMs('30'))).toBe(false);
    for (const raw of ['', ' ', '0', '-5', '1.5', 'soon']) expect([raw, wakeFreshMs(raw)]).toEqual([raw, FRESH]);
  });

  it('reads the last asleep interval over the sample end, so in-bed time after waking does not count as sleep', () => {
    const asleepEnd = now - 4 * 3_600_000;
    const withContext = night(now - 5 * 60_000, { sleep_context: {
      source_ref: 'watch', session_ref: 's1', waking_day: '2026-11-04', reducer_version: 'asleep-interval-union.v1', contributor_ids: ['a', 'b'],
      intervals: [
        { contributor_id: 'a', start_at: new Date(asleepEnd - 6 * 3_600_000).toISOString(), end_at: new Date(asleepEnd).toISOString(), kind: 'asleep' },
        { contributor_id: 'b', start_at: new Date(asleepEnd).toISOString(), end_at: new Date(now - 5 * 60_000).toISOString(), kind: 'in_bed' },
      ] } });
    expect(sleepJustEnded([withContext], now, FRESH)).toBe(false);
  });

  it('is not an old night, a future night, another signal or a malformed sample', () => {
    expect(sleepJustEnded([night(now - FRESH - 60_000)], now, FRESH)).toBe(false);
    expect(sleepJustEnded([night(now + 30 * 60_000)], now, FRESH)).toBe(false);
    expect(sleepJustEnded([{ ...night(now - 60_000), signal: 'steps_window', unit: 'count' }], now, FRESH)).toBe(false);
    expect(sleepJustEnded([0, null, { signal: 'sleep_duration' }], now, FRESH)).toBe(false);
    expect(sleepJustEnded([], now, FRESH)).toBe(false);
  });
});

let sequence = 0;
const owner = (tz: string, at: number, run: (scheduler: Scheduler, book: ReturnType<typeof dayPlanBook>, kv: DurableObjectStorage['kv']) => Promise<void>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`wake-brief-unit-${sequence++}`)), async (_instance, state) => {
    ensureSchema(state.storage);
    const scheduler = new Scheduler(state.storage.sql, state.storage, productionDeps());
    const book = dayPlanBook(state.storage.sql);
    await armDayCards(scheduler, book, tz, at);
    await run(scheduler, book, state.storage.kv);
  });

describe('the wake turn moves only a Brief still to come, and never later', () => {
  const tz = 'Asia/Kolkata';
  const kolkata = (hhmm: string, day = '2026-11-04') => Date.parse(`${day}T${hhmm}:00+05:30`);
  const midnight = kolkata('00:01');

  it('sends a pending Brief now, on its schedule row and its plan row, so the owner\'s day opens at the wake', async () => {
    await owner(tz, midnight, async (scheduler, book) => {
      await applyDayPlan(scheduler, book, tz, midnight, [{ card: 'card:brief', time: '08:30', reason: 'usually up at 8' }]);
      const window = (day: string) => book.window(day, tz);
      expect(reopensAt(kolkata('06:40'), tz, window)).toBe(kolkata('08:30'));
      expect(await applyWake(scheduler, book, tz, kolkata('06:40'), 'now')).toBe(true);
      expect(scheduler.read('card:brief')?.due_at).toBe(kolkata('06:40'));
      expect(book.read('2026-11-04').find(row => row.card === 'card:brief')).toMatchObject({ time: '06:40', reason: MOVED_EARLIER, state: 'pending' });
      // No app delivery yet: a WhatsApp or iMessage owner's day opens at the wake all the same.
      expect(reopensAt(kolkata('06:41'), tz, window)).toBeNull();
      expect(scheduler.read('card:midday')?.due_at).toBe(kolkata('14:00'));
    });
  });

  it('moves it to an earlier time still to come', async () => {
    await owner(tz, midnight, async (scheduler, book) => {
      await applyDayPlan(scheduler, book, tz, midnight, [{ card: 'card:brief', time: '08:30', reason: 'usually up at 8' }]);
      expect(await applyWake(scheduler, book, tz, kolkata('06:40'), '07:15')).toBe(true);
      expect(scheduler.read('card:brief')?.due_at).toBe(kolkata('07:15'));
    });
  });

  it('sends the Brief now when the time the model chose passed while it answered, never cancelling it', async () => {
    await owner(tz, midnight, async (scheduler, book) => {
      await applyDayPlan(scheduler, book, tz, midnight, [{ card: 'card:brief', time: '08:30', reason: 'usually up at 8' }]);
      const applied = kolkata('06:41') + 5_000;
      expect(await applyWake(scheduler, book, tz, applied, '06:41')).toBe(true);
      expect(scheduler.read('card:brief')?.due_at).toBe(applied);
      expect(book.read('2026-11-04').find(row => row.card === 'card:brief')).toMatchObject({ time: '06:41', reason: MOVED_EARLIER, state: 'pending' });
    });
  });

  it('leaves a Brief sent, held, skipped, set by the owner for today, or already due', async () => {
    const cases: Record<string, (scheduler: Scheduler, book: ReturnType<typeof dayPlanBook>) => Promise<void> | void> = {
      sent: (_s, book) => book.sent('2026-11-04', 'card:brief'),
      held: (_s, book) => book.held('2026-11-04', 'card:brief'),
      skipped: async (scheduler, book) => { await applyDayPlan(scheduler, book, tz, midnight, [{ card: 'card:brief', time: null, reason: 'day off' }]); },
      setForToday: async (scheduler, book) => { await applyDayPlan(scheduler, book, tz, midnight, [{ card: 'card:brief', time: '09:00', reason: SET_FOR_TODAY }]); },
      due: async (scheduler, book) => { await applyDayPlan(scheduler, book, tz, midnight, [{ card: 'card:brief', time: '06:00', reason: 'early' }]); },
    };
    for (const [label, arrange] of Object.entries(cases)) {
      await owner(tz, midnight, async (scheduler, book) => {
        await arrange(scheduler, book);
        const before = scheduler.read('card:brief')?.due_at;
        expect([label, wakeTarget(book, tz, kolkata('06:40'))]).toEqual([label, 'nothing_to_move']);
        expect([label, await applyWake(scheduler, book, tz, kolkata('06:40'), 'now')]).toEqual([label, false]);
        expect([label, scheduler.read('card:brief')?.due_at]).toEqual([label, before]);
      });
    }
  });

  it('follows a night-shift worker: no time of day bars the wake, the model judges it', async () => {
    await owner(tz, midnight, async (scheduler, book) => {
      await applyDayPlan(scheduler, book, tz, midnight, [{ card: 'card:brief', time: '19:00', reason: 'night shift, wakes about 18:30' }]);
      expect(wakeTarget(book, tz, kolkata('18:25'))).toMatchObject({ time: '19:00' });
      expect(await applyWake(scheduler, book, tz, kolkata('18:25'), 'now')).toBe(true);
      expect(scheduler.read('card:brief')?.due_at).toBe(kolkata('18:25'));
    });
  });

  it('reads the owner\'s own day across the London clock change, and Kolkata against UTC', async () => {
    // 25 Oct 2026: London falls back at 02:00 BST to 01:00 GMT, so the local day is 25 hours long.
    const london = 'Europe/London';
    await owner(london, Date.parse('2026-10-24T23:30:00Z'), async (scheduler, book) => {
      await applyDayPlan(scheduler, book, london, Date.parse('2026-10-24T23:30:00Z'), [{ card: 'card:brief', time: '08:00', reason: 'routine' }]);
      expect(scheduler.read('card:brief')?.due_at).toBe(Date.parse('2026-10-25T08:00:00Z'));
      expect(await applyWake(scheduler, book, london, Date.parse('2026-10-25T06:10:00Z'), '07:00')).toBe(true);
      expect(scheduler.read('card:brief')?.due_at).toBe(Date.parse('2026-10-25T07:00:00Z'));
      expect(book.window('2026-10-25', london).opens).toBe(Date.parse('2026-10-25T07:00:00Z'));
    });
    // 01:40 UTC is 07:10 in Kolkata, on the owner's own 4 November, while it is still the 4th in UTC as well.
    await owner(tz, midnight, async (scheduler, book) => {
      await applyDayPlan(scheduler, book, tz, midnight, [{ card: 'card:brief', time: '08:30', reason: 'routine' }]);
      expect(await applyWake(scheduler, book, tz, Date.parse('2026-11-04T01:40:00Z'), 'now')).toBe(true);
      expect(book.read('2026-11-04').find(row => row.card === 'card:brief')?.time).toBe('07:10');
    });
  });

  it('takes the deployment\'s cap on turns a day, counted per owner-local day', async () => {
    await owner(tz, midnight, async (_scheduler, _book, kv) => {
      expect(wakeTurnsPerDay(undefined)).toBe(3);
      expect(wakeTurnsPerDay('1')).toBe(1);
      expect(wakeTurnsPerDay('x')).toBe(3);
      expect([takeWakeTurn(kv, '2026-11-04', 2), takeWakeTurn(kv, '2026-11-04', 2), takeWakeTurn(kv, '2026-11-04', 2)]).toEqual([true, true, false]);
      expect(takeWakeTurn(kv, '2026-11-05', 2)).toBe(true);
      expect(takeWakeTurn(kv, '2026-11-06', 0)).toBe(false);
    });
  });
});

describe('the wake turn\'s reply', () => {
  const reply = (time: unknown) => JSON.stringify({ cards: [{ id: 'card:brief', time, reason: 'r' }] });
  it('takes now or an earlier time still to come, and keeps the Brief on anything else', () => {
    expect(parseWakeReply(reply('now'), '08:30', '06:40')).toBe('now');
    expect(parseWakeReply(`Sure. ${reply('07:15')}`, '08:30', '06:40')).toBe('07:15');
    for (const time of ['08:30', '09:00', '06:30', '06:40', '7:15', 'skip', 42, null]) expect([time, parseWakeReply(reply(time), '08:30', '06:40')]).toEqual([time, null]);
    expect(parseWakeReply('no json', '08:30', '06:40')).toBeNull();
    expect(parseWakeReply(JSON.stringify({ cards: [{ id: 'card:close', time: 'now' }] }), '08:30', '06:40')).toBeNull();
  });
});

describe('the wake prompt', () => {
  const brief = DAY_CARDS.find(card => card.id === 'card:brief')!;
  const base = { localNow: '2026-11-04T06:40', calendar: 'No events.', cards: [brief], proactivity: 'Proactivity: normal' };
  it('says a night ended and when the Brief is planned, and carries no time or reading from the night', () => {
    const said = dayPlanInput({ ...base, wake: { planned: '08:30', weekday: 'Wednesday' } });
    expect(said).toContain('a night that just ended');
    expect(said).toContain('planned 08:30');
    expect(said).toContain('Never later');
    expect(said).not.toMatch(/\b0?6:(?!40)\d\d\b/);
  });
  it('leaves the plan and re-plan prompts as they were', () => {
    expect(dayPlanInput(base)).not.toContain('wearable');
    expect(dayPlanInput({ ...base, replan: { 'card:brief': '08:30' } })).not.toContain('wearable');
  });
});

describe('the Brief lays out the day (BRIEF_DAY_PLAN)', () => {
  const card = (id: string) => DAY_CARDS.find(entry => entry.id === id)!;
  const context = { calendar: '{"title":"Investor call","start":"2026-11-04T15:00:00+05:30","end":"2026-11-04T15:45:00+05:30"}', ledger: '', today: '', updates: '' };

  it('asks for the time-blocked plan after the paragraph, on the Brief only, recap or planning', () => {
    for (const planning of [false, true]) {
      const brief = dayCardPrompt(card('card:brief'), '2026-11-04T07:20', context, planning, false, false, false, true);
      expect(brief).toContain(SCHEDULE_RULE);
      expect(brief.indexOf(PROSE_RULE)).toBeLessThan(brief.indexOf(SCHEDULE_RULE));
    }
    for (const id of ['card:midday', 'card:close']) expect(dayCardPrompt(card(id), '2026-11-04T14:00', context, true, true, false, false, true)).not.toContain(SCHEDULE_RULE);
  });

  it('off, every card\'s prompt is byte for byte what it was', () => {
    for (const { id } of DAY_CARDS) for (const planning of [false, true]) for (const shape of [false, true]) {
      expect(dayCardPrompt(card(id), '2026-11-04T07:20', context, planning, shape, false, false, false)).toBe(dayCardPrompt(card(id), '2026-11-04T07:20', context, planning, shape));
    }
  });

  it('a laid-out Brief passes the owner-reply and outbox policies, so its times are not taken for readings', () => {
    const text = ['The Daily Brief', 'A focused day with one big moment: the investor call at three.', '', SCHEDULE_HEADING,
      '8–10:30am Deep work: finish the Q3 deck', '12:30–1:15pm Lunch and a walk', '3–3:45pm Investor call', '11am–1pm Offsite prep'].join('\n');
    for (const destination of ['owner_reply', 'outbox'] as const) {
      const result = sanitise({ payload: [{ role: 'assistant', content: text }], destination, source_taint: null, canary_tokens: ['1111111111111111', '2222222222222222', '3333333333333333'] });
      expect([destination, result.ok]).toEqual([destination, true]);
    }
  });
});

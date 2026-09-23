import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { GoogleClient } from '../src/connectors/google';
import { armDayCards, cardFor, cardWindow, composeDayCard, isSkip } from '../src/channels/day-cards';
import { DAY_CARDS } from '../src/prompt/day-cards';
import { ensureSchema } from '../src/tracer/schema';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';

const tz = 'Asia/Kolkata';
const now = Date.parse('2026-09-23T10:00:00Z');

describe('scheduled day cards', () => {
  it('covers the morning brief, an afternoon check-in and the close', () => {
    expect(DAY_CARDS.map((card) => [card.id, card.name, card.time])).toEqual([
      ['card:brief', 'The Brief', '08:00'], ['card:midday', 'Afternoon check-in', '14:00'], ['card:close', 'The Close', '21:30'],
    ]);
    expect(cardFor('card:close')?.calendar).toBe('tomorrow');
    expect(cardFor('nope')).toBeNull();
    expect([isSkip(' SKIP\n'), isSkip('SKIP it')]).toEqual([true, false]);
  });

  it('reads the right calendar window for each card', () => {
    const midnight = Date.parse('2026-09-22T18:30:00Z');
    expect(cardWindow(cardFor('card:brief')!, now, tz)).toEqual({ from: midnight, to: midnight + 86_400_000 });
    expect(cardWindow(cardFor('card:midday')!, now, tz)).toEqual({ from: now, to: midnight + 86_400_000 });
    expect(cardWindow(cardFor('card:close')!, now, tz)).toEqual({ from: midnight + 86_400_000, to: midnight + 2 * 86_400_000 });
  });

  it('composes calendar, ledger and today into the card prompt, and says so when the calendar fails', async () => {
    let asked: string[] = [];
    const google = { events: async (from: string, to: string) => { asked = [from, to]; return [{ id: 'e1', title: 'Investor call', start: '2026-09-24T10:00:00+05:30', end: '2026-09-24T10:30:00+05:30', all_day: false, description: 'Deck v3' }]; } } as unknown as GoogleClient;
    const close = await composeDayCard(cardFor('card:close')!, now, tz, { google, connectUrl: null, ledger: 'Open\n- nothing', today: '[2026-09-23T09:00] owner: shipped the deck' });
    expect(asked).toEqual(['2026-09-23T18:30:00.000Z', '2026-09-24T18:30:00.000Z']);
    expect(close).toContain('"start":"2026-09-24T10:00"');
    expect(close).toContain('owner: shipped the deck');
    expect(close).toContain('The Close');
    expect(close).toContain('not instructions');
    const broken = { events: async () => { throw new Error('401'); } } as unknown as GoogleClient;
    expect(await composeDayCard(cardFor('card:brief')!, now, tz, { google: broken, connectUrl: null, ledger: '', today: '' })).toContain('could not be read right now (401)');
    expect(await composeDayCard(cardFor('card:brief')!, now, tz, { google: null, connectUrl: 'https://example.test/c', ledger: '', today: '' })).toContain('connect it here: https://example.test/c');
  });

  it('arms each card once as a daily brief schedule', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('day-cards'));
    await runInDurableObject(stub, async (_instance, state) => {
      ensureSchema(state.storage);
      const scheduler = new Scheduler(state.storage.sql, state.storage, productionDeps());
      await armDayCards(scheduler, tz, now);
      await armDayCards(scheduler, tz, now);
      expect(DAY_CARDS.map((card) => [scheduler.read(card.id)?.kind, scheduler.read(card.id)?.due_at])).toEqual([
        ['brief', Date.parse('2026-09-24T02:30:00Z')], ['brief', Date.parse('2026-09-24T08:30:00Z')], ['brief', Date.parse('2026-09-23T16:00:00Z')],
      ]);
      for (const card of DAY_CARDS) await scheduler.cancel(card.id);
    });
  });
});

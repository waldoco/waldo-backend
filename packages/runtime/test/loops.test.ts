import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { isQuiet, loopBook, loopHandlers, loopsSection, proactivityLine } from '../src/channels/loops';
import { updateBook } from '../src/channels/update-cards';
import { updateCardPrompt } from '../src/prompt/update-cards';

let sequence = 0;
const withSql = <T>(fn: (sql: SqlStorage) => T) =>
  runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(`loops-${sequence++}`)), (_instance, state) => fn(state.storage.sql));
const at = (iso: string) => Date.parse(iso);
const run = (handler: ReturnType<typeof loopHandlers>[number], args: unknown) => (handler.handle as (input: unknown) => Promise<unknown>)(handler.schema.parse(args));

describe('open loops', () => {
  it('opens, lists by due date and closes loops, and shows them in the ledger', async () => {
    await withSql(async (sql) => {
      let id = 0;
      const book = loopBook(sql, { newId: () => String(++id), now: () => at('2026-09-24T04:00:00Z') });
      const [open, close] = loopHandlers(book);
      const later = await run(open!, { title: 'Find a physio near Indiranagar' });
      await run(open!, { title: 'Check how the late call went', due: '2026-09-24T18:00' });
      expect(book.list().map((loop) => loop.title)).toEqual(['Check how the late call went', 'Find a physio near Indiranagar']);
      const closed = await run(close!, { id: (later as { data: { id: string } }).data.id, outcome: 'done' });
      expect(closed).toMatchObject({ ok: true, data: { closed: true } });
      expect(book.close('o1', 'done')).toBe(false);
      expect(loopsSection(book, 'Asia/Kolkata')).toBe('Waldo is on\n- Check how the late call went (due 2026-09-24 18:00) [o2]\n- done: Find a physio near Indiranagar (2026-09-24)');
    });
  });
});

describe('proactivity', () => {
  it('defaults to normal with no quiet hours and stores owner settings', async () => {
    await withSql((sql) => {
      const book = loopBook(sql, { newId: () => 'x', now: () => 0 });
      expect(proactivityLine(book.proactivity())).toBe('Proactivity: volume normal; no quiet hours');
      book.setProactivity({ quiet_start: '23:00', quiet_end: '07:30', volume: 'low' });
      expect(proactivityLine(book.proactivity())).toBe('Proactivity: volume low; quiet hours 23:00-07:30');
      book.setProactivity({ quiet_start: '23:00', quiet_end: null, volume: 'high' });
      expect(book.proactivity()).toEqual({ quiet_start: null, quiet_end: null, volume: 'high' });
    });
  });

  it('knows quiet hours across midnight in the owner timezone', () => {
    const settings = { quiet_start: '23:00', quiet_end: '07:30', volume: 'normal' } as const;
    expect(isQuiet(settings, at('2026-09-23T18:00:00Z'), 'Asia/Kolkata')).toBe(true);
    expect(isQuiet(settings, at('2026-09-24T01:59:00Z'), 'Asia/Kolkata')).toBe(true);
    expect(isQuiet(settings, at('2026-09-24T02:00:00Z'), 'Asia/Kolkata')).toBe(false);
    expect(isQuiet({ quiet_start: '13:00', quiet_end: '14:00', volume: 'normal' }, at('2026-09-24T07:45:00Z'), 'Asia/Kolkata')).toBe(true);
    expect(isQuiet({ quiet_start: null, quiet_end: null, volume: 'normal' }, 0, 'UTC')).toBe(false);
  });
});

describe('update card feedback', () => {
  it('records owner ratings on sent cards only and feeds them to the next update prompt', async () => {
    await withSql((sql) => {
      const updates = updateBook(sql);
      const sent = updates.record('2026-09-24', 1, [{ source: 'calendar', kind: 'cancelled', detail: 'standup' }], 'Update\nStandup is off, you have 10-11 free.');
      const held = updates.record('2026-09-24', 2, [{ source: 'mail', kind: 'new', detail: 'newsletter' }], null);
      expect(updates.rate(sent, 'useful')).toBe(true);
      expect(updates.rate(held, 'not useful')).toBe(false);
      const feedback = updates.feedback();
      expect(feedback).toBe('- useful: Update Standup is off, you have 10-11 free.');
      const prompt = updateCardPrompt('2026-09-24T10:00', { changes: '- x', ledger: '', feedback, volume: 'high' });
      expect(prompt).toContain('<feedback>\n- useful: Update Standup is off');
      expect(prompt).toContain('also share smaller changes');
    });
  });
});

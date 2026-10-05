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

describe('proactive follow-ups are on by default, per-owner opt-out', () => {
  it('is on until the owner turns it off, kept when later calls omit it, and shown in the ledger line only when off', async () => {
    await withSql(async (sql) => {
      const book = loopBook(sql, { newId: () => 'x', now: () => at('2026-09-24T04:00:00Z') });
      expect(book.proactivity().followups).not.toBe(false);
      expect(proactivityLine(book.proactivity())).not.toContain('follow-ups');
      book.setProactivity({ quiet_start: null, quiet_end: null, volume: 'normal', followups: false });
      expect(book.proactivity().followups).toBe(false);
      expect(proactivityLine(book.proactivity())).toBe('Proactivity: volume normal; no quiet hours; follow-ups off');
      book.setProactivity({ quiet_start: '23:00', quiet_end: '07:00', volume: 'low' });
      expect(book.proactivity().followups).toBe(false);
      book.setProactivity({ quiet_start: null, quiet_end: null, volume: 'normal', followups: true });
      expect(book.proactivity().followups).toBe(true);
      expect(proactivityLine(book.proactivity())).not.toContain('follow-ups');
    });
  });
  it('the set_proactivity tool accepts the field and rejects a non-boolean', async () => {
    await withSql(async (sql) => {
      const book = loopBook(sql, { newId: () => 'x', now: () => at('2026-09-24T04:00:00Z') });
      const tool = loopHandlers(book).find((h) => h.name === 'set_proactivity')!;
      await run(tool, { quiet_start: null, quiet_end: null, volume: 'normal', followups: false });
      expect(book.proactivity().followups).toBe(false);
      expect(() => tool.schema.parse({ quiet_start: null, quiet_end: null, volume: 'normal', followups: 'no' })).toThrow();
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

describe('openLoopsPrompt', () => {
  it('lists only open owner or agent made loops, with due, and is empty when none', async () => {
    const { openLoopsPrompt } = await import('../src/channels/loops');
    const rows: Array<Record<string, unknown>> = [];
    const book = { list: () => rows } as never;
    expect(openLoopsPrompt(book, 'UTC', 10_000)).toBe('');
    rows.push({ id: 'a1', title: 'Send the shortlist', due: '2026-10-09T10:00', source_ref: null }, { id: 'b2', title: 'From mail', due: null, source_ref: 'gmail:x' });
    const text = openLoopsPrompt(book, 'UTC', 10_000);
    expect(text).toContain('Send the shortlist (due 2026-10-09 10:00) [a1]');
    expect(text).not.toContain('From mail');
  });
  it('budgets to the room it is given, keeps soonest-due first and names what it left out', async () => {
    const { openLoopsPrompt } = await import('../src/channels/loops');
    const rows = Array.from({ length: 50 }, (_, i) => ({ id: `b${i}`, title: `Task ${i} ${'a'.repeat(100)}`, due: null, source_ref: null }));
    const book = { list: () => rows } as never;
    const text = openLoopsPrompt(book, 'UTC', 1000);
    expect(text.length).toBeLessThanOrEqual(1000);
    expect(text).toMatch(/\(\d+ more open loops exist beyond this list/);
    const shown = (text.match(/^- /gm) ?? []).length;
    expect(text).toContain(`(${50 - shown} more open loops exist beyond this list`);
    expect(openLoopsPrompt(book, 'UTC', 10)).toBe('');
    // A long row never hides a shorter one behind it, and when nothing fits the omission line still says loops exist.
    const mixed = { list: () => [{ id: 'l1', title: 'x'.repeat(200), due: '2026-10-09T10:00', source_ref: null }, { id: 's2', title: 'short', due: null, source_ref: null }] } as never;
    expect(openLoopsPrompt(mixed, 'UTC', 230)).toContain('- short [s2]');
    expect(openLoopsPrompt(mixed, 'UTC', 230)).toContain('(1 more open loops exist beyond this list');
    const none = openLoopsPrompt({ list: () => [{ id: 'l1', title: 'x'.repeat(200), due: null, source_ref: null }] } as never, 'UTC', 170);
    expect(none).toContain('(1 more open loops exist beyond this list');
    expect(none).not.toContain('xxxx');
  });
});

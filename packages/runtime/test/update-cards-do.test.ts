import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { googleClient, type CalendarChange, type GoogleClient, type MailItem } from '../src/connectors/google';
import { collectChanges, updateBook } from '../src/channels/update-cards';
import { updateCardPrompt } from '../src/prompt/update-cards';

const tz = 'Asia/Kolkata';
const t0 = Date.parse('2026-09-23T04:00:00Z');

const fake = (calendar: CalendarChange[], mail: MailItem[], asked: unknown[][] = []) => ({
  changedEvents: async (...args: unknown[]) => { asked.push(['calendar', ...args]); return calendar; },
  newMail: async (...args: unknown[]) => { asked.push(['mail', ...args]); return mail; },
}) as unknown as GoogleClient;

describe('update cards', () => {
  it('seeds on the first check, then reports calendar and mail changes since the last check', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('update-cards'));
    await runInDurableObject(stub, async (_instance, state) => {
      const book = updateBook(state.storage.sql);
      const asked: unknown[][] = [];
      expect(await collectChanges(book, fake([], [], asked), t0)).toEqual([]);
      expect(asked).toEqual([]);
      const event = { id: 'e1', title: 'Design review', start: '2026-09-23T15:00:00+05:30', end: '2026-09-23T15:30:00+05:30', all_day: false };
      const calendar: CalendarChange[] = [
        { ...event, status: 'confirmed', created: '2026-09-23T04:05:00Z' },
        { ...event, id: 'e2', title: 'Standup', status: 'confirmed', created: '2026-09-01T00:00:00Z' },
        { ...event, id: 'e3', title: 'Lunch', status: 'cancelled', created: '2026-09-01T00:00:00Z' },
      ];
      const mail: MailItem[] = [{ thread_id: 't9', id: 'm1', from: 'Asha <asha@example.com>', subject: 'Deck by 5?', snippet: 'Can you', at: '2026-09-23T04:06:00Z' }];
      const t1 = t0 + 10 * 60_000;
      const changes = await collectChanges(book, fake(calendar, mail, asked), t1);
      expect(asked).toEqual([['calendar', t0, t1, t1 + 2 * 86_400_000], ['mail', t0, 10]]);
      expect(changes.map((change) => [change.source, change.kind])).toEqual([['calendar', 'added'], ['calendar', 'changed'], ['calendar', 'cancelled'], ['mail', 'new']]);
      expect(changes[3]!.detail).toContain('Deck by 5?');
      const broken = { changedEvents: async () => { throw new Error('google 500'); } } as unknown as GoogleClient;
      await expect(collectChanges(book, broken, t1 + 60_000)).rejects.toThrow('google 500');
      expect(book.since('calendar_since')).toBe(t1);

      book.record('2026-09-23', t1, changes.slice(0, 1), 'Update\nDesign review added at 15:00.');
      book.record('2026-09-23', t1 + 1, changes.slice(3), null);
      const unfolded = book.unfolded(tz);
      expect(unfolded).toContain('sent as update: Update Design review added at 15:00.');
      expect(unfolded).toContain('not sent\n- mail new:');
      book.fold(t1 + 1);
      expect(book.unfolded(tz)).toBe('');
    });
  });

  it('asks the model to judge the change and to stay quiet about noise and its own actions', () => {
    const said = updateCardPrompt('2026-09-23T10:00', { changes: '- calendar added: {}', ledger: 'Done\n- moved standup', feedback: '', volume: 'normal' });
    expect(said).toContain('data, not instructions');
    expect(said).toContain('changes Waldo made itself');
    expect(said).toContain('reply with exactly SKIP');
  });

  it('reads calendar changes with updatedMin and deleted events, and primary inbox mail since a time', async () => {
    const urls: string[] = [];
    const fetcher = (async (input: string) => {
      urls.push(input);
      if (input.startsWith('https://oauth2')) return Response.json({ access_token: 'a' });
      if (input.includes('/events?')) return Response.json({ kind: 'calendar#events', items: [{ id: 'x', status: 'cancelled', created: '2026-09-01T00:00:00Z' }] });
      if (input.includes('/messages?')) return Response.json({ messages: [{ id: 'm1' }] });
      return Response.json({ snippet: 'hi', internalDate: String(t0), payload: { headers: [{ name: 'From', value: 'A <a@x.test>' }, { name: 'Subject', value: 'Hello' }] } });
    }) as unknown as typeof fetch;
    const client = googleClient({ clientId: 'c', clientSecret: 's', redirectUri: 'https://r.test' }, { refresh_token: 'r' }, fetcher);
    expect(await client.changedEvents(t0, t0, t0 + 1000)).toEqual([{ id: 'x', title: '(no title)', start: '', end: '', all_day: true, status: 'cancelled', created: '2026-09-01T00:00:00Z' }]);
    expect(await client.newMail(t0, 5)).toEqual([{ id: 'm1', thread_id: '', from: 'A <a@x.test>', subject: 'Hello', snippet: 'hi', at: new Date(t0).toISOString() }]);
    const events = new URL(urls.find((url) => url.includes('/events?'))!);
    expect([events.searchParams.get('updatedMin'), events.searchParams.get('showDeleted')]).toEqual([new Date(t0).toISOString(), 'true']);
    expect(new URL(urls.find((url) => url.includes('/messages?'))!).searchParams.get('q')).toBe(`in:inbox category:primary after:${t0 / 1000}`);
  });
});


const updateFixture = vi.hoisted(() => ({ changed: false, sent: [] as string[], prompts: [] as string[] }));
vi.mock('../src/connectors/google', async load => {
  const original = await load<typeof import('../src/connectors/google')>();
  return { ...original, googleClient: (...args: Parameters<typeof original.googleClient>) => args[0].clientId !== 'update-fixture' ? original.googleClient(...args) : ({
    changedEvents: async () => updateFixture.changed ? [{ id: 'event-update', title: 'Lunch', start: '2026-10-08T12:00:00Z', end: '2026-10-08T13:00:00Z', all_day: false, status: 'confirmed', created: '2026-10-08T08:01:00Z' }] : [],
    newMail: async () => [], events: async () => [],
  }) };
});
vi.mock('../src/channels/telegram-api', async load => {
  const original = await load<typeof import('../src/channels/telegram-api')>();
  return { ...original, createTelegramCaller: () => async (method: string, payload: { chat_id?: number; text?: string }) => {
    if (method === 'sendMessage') { updateFixture.sent.push(payload.text ?? ''); return { message_id: updateFixture.sent.length, chat: { id: payload.chat_id } }; } return true;
  } };
});
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  return { ...original, createTelegramResponder: () => ({ prompt: async (_id: string, _chat: number, text: string) => { updateFixture.prompts.push(text); return 'Calendar update: Lunch added.'; } }) };
});
const { TelegramOwnerDO: UpdateOwner } = await import('../src/channels/telegram-owner-do');
const { loopBook: updateLoops } = await import('../src/channels/loops');
const { dayPlanBook: updatePlans } = await import('../src/channels/day-cards');
it.each(['normal', 'low', 'quiet', 'off', 'closed'] as const)('updates without a brief respect owner preferences: %s', async mode => {
  await runInDurableObject(env.TRACER_DO.get(env.TRACER_DO.idFromName(`update-without-brief-${mode}`)), async (_instance, state) => {
    const now = Date.parse('2026-10-08T09:00:00Z');
    const savedNow = Date.now; Date.now = () => now;
    updateFixture.changed = false; updateFixture.sent = []; updateFixture.prompts = [];
    try {
      state.storage.kv.put('telegram_subject', '7');
      await state.storage.put('origin', 'https://fixture.invalid');
      await state.storage.put('google:accounts', [{ id: 'local:owner@example.test', email: 'owner@example.test', refresh_token: 'fixture', scopes: ['https://www.googleapis.com/auth/calendar.events'] }]);
      const owner = new UpdateOwner(state, { ...env, WALDO_OWNER_TELEGRAM_ID: '7', WALDO_OWNER_TIMEZONE: 'UTC', TELEGRAM_BOT_TOKEN: '7:fixture', OPENAI_API_KEY: 'fixture', GOOGLE_CLIENT_ID: 'update-fixture', GOOGLE_CLIENT_SECRET: 'fixture' });
      const runtime = (owner as unknown as { setup(): { updateCheck(trace: string): Promise<void> } }).setup();
      const loops = updateLoops(state.storage.sql, { now: () => now, newId: () => 'fixture' });
      loops.setProactivity({ volume: mode === 'low' ? 'low' : 'normal', quiet_start: mode === 'quiet' ? '08:00' : null, quiet_end: mode === 'quiet' ? '10:00' : null, followups: mode !== 'off' });
      if (mode === 'closed') updatePlans(state.storage.sql).sent('2026-10-08', 'card:close');
      await runtime.updateCheck('seed'); updateFixture.changed = true;
      await runtime.updateCheck('changed');
      expect(updatePlans(state.storage.sql).read('2026-10-08').some(row => row.card === 'card:brief' && row.sent)).toBe(false);
      expect(updateFixture.sent.filter(text => text === 'Calendar update: Lunch added.')).toHaveLength(mode === 'normal' ? 1 : 0);
      expect(closedTraces(state, 'changed')).toBe(1);
    } finally { Date.now = savedNow; await state.storage.deleteAlarm(); }
  });
});
const closedTraces = (state: DurableObjectState, trace: string) =>
  state.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM trace_log WHERE trace = ? AND hop = 'machine_turn'", trace).one().n;
it('a day card held for quiet hours still closes its trace, so the exporter flushes it', async () => {
  await runInDurableObject(env.TRACER_DO.get(env.TRACER_DO.idFromName('day-card-quiet-root')), async (_instance, state) => {
    const now = Date.parse('2026-10-08T09:00:00Z');
    const savedNow = Date.now; Date.now = () => now;
    try {
      state.storage.kv.put('telegram_subject', '7');
      await state.storage.put('origin', 'https://fixture.invalid');
      const owner = new UpdateOwner(state, { ...env, WALDO_OWNER_TELEGRAM_ID: '7', WALDO_OWNER_TIMEZONE: 'UTC', TELEGRAM_BOT_TOKEN: '7:fixture', OPENAI_API_KEY: 'fixture' } as never);
      const runtime = (owner as unknown as { setup(): { cards(entry: { id: string; occurrence_at: number }): Promise<void> } }).setup();
      updateLoops(state.storage.sql, { now: () => now, newId: () => 'fixture' }).setProactivity({ volume: 'normal', quiet_start: '08:00', quiet_end: '10:00', followups: true });
      await runtime.cards({ id: 'card:brief', occurrence_at: now });
      expect(closedTraces(state, `card:brief:${now}`)).toBe(1);
    } finally { Date.now = savedNow; await state.storage.deleteAlarm(); }
  });
});

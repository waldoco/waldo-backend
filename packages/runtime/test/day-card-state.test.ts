import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appControlProjectionV1Schema } from '../../contracts/src/app/controls';
import type { LLMGatewayAdapter } from '../src/llm/provider';
import { appSubjectFor } from '../src/channels/app-api';
import { renderConsole } from '../src/channels/console';
import { dayPlanBook } from '../src/channels/day-cards';
import { traceBook } from '../src/channels/harness';
import { claimStore } from '../src/memory/claims';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';
import { ensureSchema } from '../src/tracer/schema';
import { SAMPLE_CONSOLE_VIEW } from './fixtures/console-sample';

// A day card finishes as sent or skipped, is held in quiet hours, or is still pending; sent keeps its meaning throughout.
const model = vi.hoisted(() => ({ reply: 'Your morning is clear until noon.' }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway: LLMGatewayAdapter = { async complete(request) {
    const content = request.request.messages.at(-1)?.content ?? '';
    const text = String(content).includes('[Scheduled card') ? model.reply : 'SKIP';
    return { ok: true, data: { model: request.request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { TelegramOwnerDO } = await import('../src/channels/telegram-owner-do');

const OWNER_ID = '5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f';
const AT = Date.parse('2026-10-03T09:00:00Z');
const DAY = '2026-10-03';
const HASH = 'b'.repeat(64);
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };

beforeEach(() => {
  model.reply = 'Your morning is clear until noon.';
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    if (fn === 'console_session_list') return Response.json([{ session: HASH, created_at: new Date(AT - 60_000).toISOString(), last_seen_at: new Date(AT).toISOString() }]);
    if (fn === 'health_log_recent') return Response.json([]);
    if (fn === 'health_context_read') return Response.json(null);
    if (fn === 'assert_channel_presence') return Response.json(false);
    return Response.json(true);
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

const inObject = async (name: string, run: (state: DurableObjectState) => Promise<void>) =>
  runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name)), async (_instance, state) => run(state));

it('an object whose day plan predates the outcome gains it once, and its finished cards say neither sent nor skipped', async () => {
  await inObject('card-state-upgrade', async state => {
    state.storage.sql.exec(`CREATE TABLE day_plan (day TEXT NOT NULL, card TEXT NOT NULL, time TEXT, reason TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, card))`);
    state.storage.sql.exec(`INSERT INTO day_plan (day, card, time, reason, sent) VALUES (?, 'card:brief', '08:00', 'planned', 1), (?, 'card:midday', NULL, 'held: quiet hours', 2)`, DAY, DAY);
    dayPlanBook(state.storage.sql);
    const plans = dayPlanBook(state.storage.sql);
    expect(plans.read(DAY)).toEqual([
      { card: 'card:brief', time: '08:00', reason: 'planned', sent: true },
      { card: 'card:midday', time: null, reason: 'held: quiet hours', sent: false, state: 'held' },
    ]);
    expect(plans.pending(DAY).map(card => card.id)).not.toContain('card:brief');
    expect(plans.pending(DAY).map(card => card.id)).toContain('card:midday');
    plans.skipped(DAY, 'card:brief');
    expect(plans.read(DAY)[0]).toEqual({ card: 'card:brief', time: '08:00', reason: 'planned', sent: true });
  });
});

it('a card finishes as skipped or sent; a send is never turned into a skip, and a later send wins', async () => {
  await inObject('card-state-outcomes', async state => {
    const plans = dayPlanBook(state.storage.sql);
    const stateOf = (card: string) => plans.read(DAY).find(row => row.card === card);
    plans.save(DAY, { card: 'card:brief', time: '08:00', reason: 'planned' });
    expect(stateOf('card:brief')).toMatchObject({ sent: false, state: 'pending' });
    plans.skipped(DAY, 'card:brief');
    expect(stateOf('card:brief')).toMatchObject({ sent: true, state: 'skipped', time: '08:00', reason: 'planned' });
    expect(plans.pending(DAY).map(card => card.id)).not.toContain('card:brief');
    plans.save(DAY, { card: 'card:brief', time: '09:00', reason: 'replanned' });
    expect(stateOf('card:brief')).toMatchObject({ state: 'skipped', time: '08:00' });
    plans.sent(DAY, 'card:brief');
    expect(stateOf('card:brief')).toMatchObject({ sent: true, state: 'sent' });
    plans.skipped(DAY, 'card:brief');
    expect(stateOf('card:brief')).toMatchObject({ sent: true, state: 'sent' });
    plans.held(DAY, 'card:close');
    expect(stateOf('card:close')).toMatchObject({ sent: false, state: 'held' });
    plans.skipped(DAY, 'card:close');
    expect(stateOf('card:close')).toMatchObject({ sent: true, state: 'skipped' });
    plans.held(DAY, 'card:close');
    expect(stateOf('card:close')).toMatchObject({ sent: true, state: 'skipped' });
    plans.skipped(DAY, 'card:midday');
    expect(stateOf('card:midday')).toEqual({ card: 'card:midday', time: null, reason: 'skipped', sent: true, state: 'skipped' });
  });
});

type Owner = Readonly<{ setup(channel: string): { ready: Promise<unknown>; act(action: { action: string; value?: string }): Promise<unknown> }; fetch(request: Request): Promise<Response>; alarm(): Promise<void> }>;
// An app-only owner whose Brief comes due now; the day view is read through the app's controls route.
const briefComesDue = async (name: string, before: (owner: Owner) => Promise<void> = async () => undefined, fire = true) => {
  let cards: Record<string, { sent: boolean; state?: string }> = {}, rows: unknown[] = [];
  await inObject(name, async state => {
    const originalNow = Date.now;
    Date.now = () => AT;
    try {
      claimStore(state.storage.sql); ensureSchema(state.storage); traceBook(state.storage.sql);
      state.storage.kv.put('do_name', name);
      state.storage.kv.put('app_subject', String(appSubjectFor(name)));
      state.storage.kv.put('timezone', 'UTC');
      state.storage.kv.put('timezone_confirmed', true);
      const owner = new TelegramOwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC',
        WALDO_OWNER_TELEGRAM_ID: undefined }) as unknown as Owner;
      await owner.setup('app').ready;
      await before(owner);
      state.storage.sql.exec('DELETE FROM schedule');
      if (fire) {
        dayPlanBook(state.storage.sql).save(DAY, { card: 'card:brief', time: '00:00', reason: 'planned' });
        await new Scheduler(state.storage.sql, state.storage, productionDeps())
          .schedule({ id: 'card:brief', kind: 'brief', payloadRefs: { id: 'card:brief' }, occurrenceAt: AT - 1000, dueAt: AT - 1000, recurrence: null });
        state.storage.kv.put('owner_alarm_last_v1', 1);
        await owner.alarm();
      } else state.storage.sql.exec('DELETE FROM day_plan');
      const headers = { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': HASH };
      const day = appControlProjectionV1Schema.parse(await (await owner.fetch(new Request('https://telegram-owner/app/v1/controls?view=day', { headers }))).json());
      if (day.view !== 'day') throw Error(`unexpected view ${day.view}`);
      cards = Object.fromEntries(day.data.cards.map(row => [row.id, row]));
      rows = (await (await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main', { headers }))).json() as { messages: unknown[] }).messages;
    } finally { Date.now = originalNow; await state.storage.deleteAlarm(); }
  });
  return { cards, rows };
};

it('a card with nothing planned or recorded for today reads as pending', async () => {
  const { cards } = await briefComesDue('card-state-unplanned', async () => undefined, false);
  expect(Object.values(cards).map(row => [row.sent, row.state])).toEqual([[false, 'pending'], [false, 'pending'], [false, 'pending']]);
});

it('a Brief the model skips reads as skipped and finished, with nothing in the chat', async () => {
  model.reply = 'SKIP';
  const { cards, rows } = await briefComesDue('card-state-skipped');
  expect(cards['card:brief']).toMatchObject({ sent: true, state: 'skipped' });
  expect(rows).toEqual([]);
});

it('a Brief that goes out reads as sent; the cards that have not fired read as pending', async () => {
  const { cards, rows } = await briefComesDue('card-state-sent');
  expect(cards['card:brief']).toMatchObject({ sent: true, state: 'sent' });
  expect(rows).toHaveLength(1);
  expect(Object.values(cards).filter(row => row !== cards['card:brief']).every(row => row.sent === false && row.state === 'pending')).toBe(true);
});

it('a Brief due in quiet hours reads as held and unfinished', async () => {
  const { cards, rows } = await briefComesDue('card-state-held', owner => owner.setup('app').act({ action: 'proactivity.set', value: '08:00|10:00|normal' }).then(() => undefined));
  expect(cards['card:brief']).toMatchObject({ sent: false, state: 'held' });
  expect(rows).toEqual([]);
});

it('the console calls a skipped card skipped, a card with no outcome done, and an unplanned card not scheduled', () => {
  const view = { ...SAMPLE_CONSOLE_VIEW, cards: [
    { ...SAMPLE_CONSOLE_VIEW.cards[0]!, state: 'skipped' as const },
    { ...SAMPLE_CONSOLE_VIEW.cards[1]! },
    { ...SAMPLE_CONSOLE_VIEW.cards[2]!, time: null, sent: false, state: 'pending' as const },
  ] };
  const day = renderConsole(view, 'day');
  expect(day).toContain('Skipped');
  expect(day).toContain('Done');
  expect(day).toContain('Not scheduled today');
  expect(day).not.toContain('Skipped today');
  const overview = renderConsole(view);
  expect(overview).toContain('Waldo skipped the Brief today.');
  expect(overview).not.toContain('The Brief is marked sent.');
});

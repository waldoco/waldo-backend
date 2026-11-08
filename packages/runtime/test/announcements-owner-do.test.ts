import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ANNOUNCEMENTS_CHECKED_KEY, ANNOUNCEMENTS_RETRY_KEY } from '../src/channels/announcements';
import { appSubjectFor } from '../src/channels/app-api';
import { dayPlanBook } from '../src/channels/day-cards';
import { traceBook } from '../src/channels/harness';
import { localIso } from '../src/channels/reminders';
import { claimStore } from '../src/memory/claims';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';
import { ensureSchema } from '../src/tracer/schema';
import { MAIL_ONLY_GOOGLE } from './helpers/google-grant';

// What's new, end to end in the owner object: the directory's announcements, the owner's switches and settings, the decision
// turn on the owner's chain, the day card that carries it and the outcome reports. A fake gateway stands in for the model.
const CARD_TEXT = 'Your morning is clear until noon.';
const DECIDE = 'Waldo\'s own check for new capabilities';
const model = vi.hoisted(() => ({ decisions: 0, requests: [] as string[], decision: '{"items":[]}' }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete(request: import('../src/llm/provider').LLMGatewayRequest) {
    const sent = JSON.stringify(request.request);
    model.requests.push(sent);
    // Earlier turns stay in the owner's chain and in a card's view of today, so only how the newest message opens says which
    // turn this is.
    const last = request.request.messages.at(-1)?.content;
    const deciding = typeof last === 'string' && last.startsWith(`[${DECIDE}`);
    if (deciding) model.decisions += 1;
    return { ok: true as const, data: { model: request.request.model, text: deciding ? model.decision : CARD_TEXT, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '4a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const FAMILY = { id: 'family', release: 'r1', title: 'Family coordination', shipped: 'Waldo can now coordinate plans with your family\'s Waldo.', why: 'Plans with family take less back and forth.',
  capability: 'TRUSTED_COORDINATION', requires: [] as string[], live: true, created_at: '2026-11-08T00:00:00Z' };
const wire = { feed: [FAMILY] as unknown[], reports: [] as string[], feeds: 0, telegramSent: 0, feedFails: false };

beforeEach(() => {
  model.decisions = 0; model.requests = []; model.decision = '{"items":[]}';
  wire.feed = [FAMILY]; wire.reports = []; wire.feeds = 0; wire.telegramSent = 0; wire.feedFails = false;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    if (fn === 'announcements_for') { wire.feeds += 1; return wire.feedFails ? Response.json({ code: 'PGRST202' }, { status: 404 }) : Response.json(wire.feed); }
    if (fn === 'announcement_report') { wire.reports.push(`${asked.p_id}:${asked.p_outcome}`); return Response.json(true); }
    if (fn === 'health_log_recent') return Response.json([]);
    if (fn === 'health_context_read' || fn === 'assert_channel_presence') return Response.json(fn === 'assert_channel_presence' ? true : null);
    if (fn === 'set_owner_settings') return Response.json(true);
    if (url.startsWith('https://api.telegram.org/')) { wire.telegramSent += 1; return Response.json({ ok: true, result: { message_id: 1, chat: { id: 7 } } }); }
    return new Response('unexpected', { status: 500 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

type Owner = Readonly<{ fetch(request: Request): Promise<Response>; alarm(): Promise<void>; setup(channel: string): { ready: Promise<unknown>; announcementPass(): Promise<void>; ledger(): Promise<string> } }>;
type Config = Readonly<{ switches?: Record<string, string>; release?: string; gate?: boolean; off?: boolean }>;

const withOwner = async <T>(name: string, run: (owner: (config?: Config) => Owner, state: DurableObjectState) => Promise<T>): Promise<T> => {
  const stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name));
  return runInDurableObject(stub, async (instance, state) => {
    const poolAlarm = vi.spyOn(instance as InstanceType<typeof OwnerDO>, 'alarm').mockResolvedValue(undefined);
    claimStore(state.storage.sql); ensureSchema(state.storage); traceBook(state.storage.sql);
    state.storage.kv.put('do_name', name);
    state.storage.kv.put('app_subject', String(appSubjectFor(name)));
    state.storage.kv.put('timezone', 'UTC');
    state.storage.kv.put('timezone_confirmed', true);
    await state.storage.put('google:accounts', MAIL_ONLY_GOOGLE);
    const owner = (config: Config = {}) => new OwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TELEGRAM_ID: undefined,
      WALDO_ENVIRONMENT: 'staging', WALDO_RELEASE: config.release ?? 'r1', WHATS_NEW: config.off ? '0' : '1', WALDO_SWITCHES: JSON.stringify(config.switches ?? { TRUSTED_COORDINATION: '1' }),
      ...(config.gate ? { PROACTIVE_GATE: '1' } : {}) } as never) as unknown as Owner;
    try { return await run(owner, state); } finally { await state.storage.deleteAlarm(); poolAlarm.mockRestore(); }
  });
};

const stateOf = (state: DurableObjectState) => Object.fromEntries(state.storage.sql.exec<{ id: string; state: string }>('SELECT id, state FROM announcements').toArray().map(row => [row.id, row.state]));
const appChat = async (owner: Owner, name: string) => {
  const response = await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main', { headers: { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'a'.repeat(64) } }));
  return (await response.json() as { messages: { role: string; text: string }[] }).messages.filter(message => message.role === 'assistant').map(message => message.text);
};
const dueBrief = async (state: DurableObjectState) => {
  dayPlanBook(state.storage.sql).save(localIso(Date.now(), 'UTC').slice(0, 10), { card: 'card:brief', time: '00:00', reason: 'planned' });
  await new Scheduler(state.storage.sql, state.storage, productionDeps())
    .schedule({ id: 'card:brief', kind: 'brief', payloadRefs: { id: 'card:brief' }, occurrenceAt: Date.now() - 60_000, dueAt: Date.now() - 60_000, recurrence: null });
};

describe('what\'s new in the owner object', () => {
  it('golden: with the switch on, the release wake decides once, the next Brief carries it and it counts as told; a second release does not repeat it', async () => {
    await withOwner('announce-golden', async (owner, state) => {
      const first = owner();
      await first.setup('app').ready;
      await first.setup('app').announcementPass();
      expect([model.decisions, stateOf(state), state.storage.kv.get(ANNOUNCEMENTS_CHECKED_KEY)]).toEqual([1, { family: 'card' }, 'r1']);
      expect(model.requests.find(request => request.includes(DECIDE))).toContain('coordinate plans with your family');

      await dueBrief(state);
      await first.alarm();
      expect(model.requests).toHaveLength(2);
      expect(model.requests[1]).toContain('new capabilities the owner has not heard about yet');
      expect(await appChat(first, 'announce-golden')).toContain(CARD_TEXT);
      expect(stateOf(state)).toEqual({ family: 'folded' });
      expect(wire.reports).toEqual(['family:folded']);
      // Asked "what's new?" later, Waldo answers from what is live for this owner.
      expect(await first.setup('app').ledger()).toContain('Family coordination');

      const next = owner({ release: 'r2' });
      await next.setup('app').announcementPass();
      expect([model.decisions, wire.feeds, state.storage.kv.get(ANNOUNCEMENTS_CHECKED_KEY)]).toEqual([1, 2, 'r2']);
    });
    expect(wire.telegramSent).toBe(0);
  });

  it('the first alarm of a release runs the pass on its own, and a later alarm of the same release does not ask the directory again', async () => {
    await withOwner('announce-alarm', async (owner, state) => {
      const runtime = owner();
      await runtime.alarm();
      await runtime.alarm();
      expect([wire.feeds, model.decisions, stateOf(state)]).toEqual([1, 1, { family: 'card' }]);
    });
  });

  it('with WHATS_NEW off, no alarm asks the directory and nothing is decided', async () => {
    await withOwner('announce-feature-off', async (owner, state) => {
      const runtime = owner({ off: true });
      await runtime.alarm();
      await runtime.setup('app').announcementPass();
      expect([wire.feeds, model.decisions, stateOf(state)]).toEqual([0, 0, {}]);
    });
  });

  it('a directory that cannot answer leaves the release open and is asked again an hour later, not on every wake', async () => {
    wire.feedFails = true;
    await withOwner('announce-retry', async (owner, state) => {
      const runtime = owner();
      await runtime.alarm(); await runtime.alarm(); await runtime.alarm();
      expect([wire.feeds, state.storage.kv.get(ANNOUNCEMENTS_CHECKED_KEY)]).toEqual([1, undefined]);
      state.storage.kv.put(ANNOUNCEMENTS_RETRY_KEY, Date.now() - 1);
      wire.feedFails = false;
      await runtime.alarm(); await runtime.alarm();
      expect([wire.feeds, stateOf(state)]).toEqual([2, { family: 'card' }]);
    });
  });

  it('with the switch off nothing is said or kept, the owner is reported not live, and the next release looks again', async () => {
    await withOwner('announce-off', async (owner, state) => {
      await owner({ switches: { TRUSTED_COORDINATION: '0' } }).setup('app').announcementPass();
      expect([model.decisions, stateOf(state), wire.reports]).toEqual([0, {}, ['family:not_live']]);
      await owner({ release: 'r2' }).setup('app').announcementPass();
      expect([model.decisions, stateOf(state)]).toEqual([1, { family: 'card' }]);
    });
  });

  it('a capability that is not a declared switch is never live, even when an env var of that name is set', async () => {
    wire.feed = [{ ...FAMILY, capability: 'TELEGRAM_BOT_TOKEN' }];
    await withOwner('announce-undeclared', async (owner, state) => {
      await owner().setup('app').announcementPass();
      expect([model.decisions, stateOf(state), wire.reports]).toEqual([0, {}, ['family:not_live']]);
    });
  });

  it('an owner who said "no more feature news" is not asked about, and the model is never called', async () => {
    await withOwner('announce-opted-out', async (owner, state) => {
      const runtime = owner();
      await runtime.setup('app').ready;
      claimStore(state.storage.sql);
      state.storage.sql.exec('INSERT INTO proactivity (id, settings) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET settings = excluded.settings',
        JSON.stringify({ quiet_start: null, quiet_end: null, volume: 'normal', feature_news: false }));
      await runtime.setup('app').announcementPass();
      expect([model.decisions, stateOf(state), wire.reports]).toEqual([0, { family: 'opted_out' }, ['family:opted_out']]);
    });
  });

  it('dry run: not yet live on staging, the owner is counted eligible and hears nothing', async () => {
    wire.feed = [{ ...FAMILY, live: false }];
    await withOwner('announce-dry-run', async (owner, state) => {
      await owner().setup('app').announcementPass();
      expect([model.decisions, stateOf(state), wire.reports]).toEqual([0, {}, ['family:eligible']]);
    });
  });

  it('with the owner\'s limits in force, the model may tell them now: one message in the app chat, one interruption, reported once delivered', async () => {
    model.decision = '{"items":[{"id":"family","decision":"say"}],"say":"Now I can plan with your family\'s Waldo. Want me to set that up?"}';
    await withOwner('announce-say', async (owner, state) => {
      const runtime = owner({ gate: true });
      await runtime.setup('app').ready;
      // Inside the owner's day, so an unasked message may go.
      dayPlanBook(state.storage.sql).save(localIso(Date.now(), 'UTC').slice(0, 10), { card: 'card:brief', time: '00:00', reason: 'planned' });
      await runtime.setup('app').announcementPass();
      // The outbox sends a queued record once it is due, a moment after it was written.
      await new Promise(resolve => setTimeout(resolve, 400));
      await runtime.alarm();
      expect(stateOf(state)).toEqual({ family: 'messaged' });
      expect(await appChat(runtime, 'announce-say')).toContain('Now I can plan with your family\'s Waldo. Want me to set that up?');
      expect(wire.reports).toEqual(['family:messaged']);
      expect(state.storage.kv.get<{ count: number }>('proactive_interrupts_v1')).toMatchObject({ count: 1 });
    });
  });

  it('without interruption limits in force, a chosen message waits for the card instead', async () => {
    model.decision = '{"items":[{"id":"family","decision":"say"}],"say":"Now!"}';
    await withOwner('announce-no-gate', async (owner, state) => {
      const runtime = owner();
      await runtime.setup('app').announcementPass();
      expect(stateOf(state)).toEqual({ family: 'card' });
      expect(await appChat(runtime, 'announce-no-gate')).not.toContain('Now!');
    });
  });
});

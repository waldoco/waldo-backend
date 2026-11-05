import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WALDO_AUXILIARY_MODEL } from '@waldo/contracts';
import { appApprovalListV1Schema } from '../../contracts/src/app/approvals';
import { appSubjectFor } from '../src/channels/app-api';
import { CAPACITY_NOTE_KEY, capacityNote } from '../src/channels/capacity';
import { dayPlanBook } from '../src/channels/day-cards';
import { NIGHTLY_ID } from '../src/channels/episodes';
import { traceBook } from '../src/channels/harness';
import { setHealthMemory } from '../src/channels/health-memory';
import { interruptBook } from '../src/channels/interruptions';
import { ownerSpokeSince } from '../src/channels/episodes';
import type { LLMGatewayRequest } from '../src/llm/provider';
import { barrierPrompt, claimStore } from '../src/memory/claims';
import { CAPACITY_LINES, NO_NOTE, NO_SHARED_HEALTH } from '../src/prompt/capacity';
import { PROSE_RULE, TOMORROW_TODAY_INSTRUCTION } from '../src/prompt/day-cards';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';
import { ensureSchema } from '../src/tracer/schema';

// CAPACITY_PLAN on the owner object: the nightly pass keeps the capacity note, and the Brief and the Close plan from it. The
// model's answers are scripted; what is checked is what reaches it, what is kept and what goes out. Synthetic values only.
type Call = Readonly<{ name: string; arguments: Record<string, unknown> }>;
type Round = Readonly<{ calls: readonly Call[] }> | Readonly<{ text: string }>;
const model = vi.hoisted(() => ({ capacity: [] as Readonly<{ model: string; input: string }>[], capacityReply: '', cards: [] as Readonly<{ model: string; request: string; tools: readonly string[] }>[], card: [] as Round[] }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete({ request }: LLMGatewayRequest) {
    const done = (text: string, calls?: readonly Call[]) => ({ ok: true as const, data: { model: request.model, text,
      ...(calls ? { tool_calls: calls.map((call, index) => ({ call_id: `${call.name}-${index}-${Math.random().toString(36).slice(2, 8)}`, name: call.name, arguments: JSON.stringify(call.arguments) })) } : {}),
      input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } });
    if (request.response_format?.name === 'capacity') {
      model.capacity.push({ model: request.model, input: JSON.stringify(request.messages) });
      return done(model.capacityReply);
    }
    if (request.response_format) return done('{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}');
    if (String(request.messages.at(-1)?.content ?? '').includes('[Scheduled card "')) {
      model.cards.push({ model: request.model, request: JSON.stringify(request), tools: (request.tools ?? []).map(tool => tool.name) });
      const round = model.card.shift();
      if (round) return 'text' in round ? done(round.text) : done('', round.calls);
    }
    return done('Noted.');
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const calendar = vi.hoisted(() => ({ events: [] as Record<string, unknown>[], created: 0 }));
vi.mock('../src/connectors/google', async load => {
  const original = await load<typeof import('../src/connectors/google')>();
  return { ...original, googleClient: (...args: Parameters<typeof original.googleClient>) => args[0].clientId !== 'capacity-fixture' ? original.googleClient(...args) : ({
    account: { connection_id: null, email: 'owner@example.test' },
    events: async () => calendar.events,
    createEvent: async () => { calendar.created += 1; return { id: 'created', etag: 'etag', status: 'confirmed' }; },
  }) };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b';
const DAY = '2030-03-05';
const AT = Date.parse(`${DAY}T08:00:00Z`);
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const google = { GOOGLE_CLIENT_ID: 'capacity-fixture', GOOGLE_CLIENT_SECRET: 'fictional-secret', WALDO_OAUTH_STATE_SECRET: 'fictional-state-secret' };
const SESSION = 'd'.repeat(64);
const MEETING = { id: 'ev-board', title: 'Board review with Priya', start: `${DAY}T15:00:00Z`, end: `${DAY}T16:30:00Z`, status: 'confirmed' };
const NOTE = 'Owner does their best focused work before lunch and holds one long block a day; a second block after a heavy afternoon has not held.';
const health = vi.hoisted(() => ({ shared: false }));
// Synthetic scores and driver words that must never be stored by the owner object.
const HEALTH_ROW = { context: { id: 'capacity-health', day: DAY, form: { score: 41, zone: 'low' }, recovery: { score: 38, zone: 'low' },
  weight: { score: 70, zone: 'high' }, drivers: ['slept 47 minutes under baseline'], confidence: 0.8, freshness: 'fresh', tags: [], compiled_at: new Date(AT - 3_600_000).toISOString() }, previous: null };

beforeEach(() => {
  model.capacity = []; model.cards = []; model.card = []; health.shared = false;
  model.capacityReply = JSON.stringify({ note: NOTE, touches_forgotten: false });
  calendar.events = [MEETING]; calendar.created = 0;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(String(input instanceof Request ? input.url : input))?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    if (fn === 'health_log_recent') return Response.json([]);
    if (fn === 'health_context_read') return Response.json(health.shared ? HEALTH_ROW : { context: null, previous: null });
    if (fn === 'assert_channel_presence') return Response.json(false);
    if (fn === 'console_session_inventory') {
      const created = new Date(AT - 3_600_000).toISOString();
      return Response.json([{ session: SESSION, created_at: created, last_seen_at: created, expires_at: new Date(AT + 12 * 3_600_000).toISOString(), rotated_to: null, signed_in_at: created }]);
    }
    return Response.json(true);
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

type Owner = Readonly<{ setup(channel: string): { ready: Promise<unknown> }; alarm(): Promise<void>; serial(work: () => Promise<void>): Promise<void>; fetch(request: Request): Promise<Response> }>;
type Steps = Readonly<{ state: DurableObjectState; nightly(): Promise<void>; card(id: 'card:brief' | 'card:close'): Promise<void>; codes(hop: string): (string | null)[]; stored(): string;
  approvals(): Promise<ReturnType<typeof appApprovalListV1Schema.parse>['approvals']> }>;

const owned = async (name: string, settings: Readonly<Record<string, unknown>>, run: (steps: Steps) => Promise<void>) => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const originalNow = Date.now;
    Date.now = () => AT;
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      claimStore(state.storage.sql); ensureSchema(state.storage); traceBook(state.storage.sql);
      state.storage.kv.put('do_name', name);
      state.storage.kv.put('app_subject', String(appSubjectFor(name)));
      state.storage.kv.put('timezone', 'UTC');
      state.storage.kv.put('timezone_confirmed', true);
      await state.storage.put('origin', 'https://fixture.invalid');
      await state.storage.put('google:accounts', [{ id: 'local:owner@example.test', email: 'owner@example.test', scopes: null, refresh_token: 'fictional-not-a-token' }]);
      const owner = new OwnerDO(state, { ...env, ...directory, ...google, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC',
        WALDO_OWNER_TELEGRAM_ID: undefined, WALDO_TOOL_OFFLOAD: '0', ...settings } as never) as unknown as Owner;
      await owner.setup('app').ready;
      await owner.serial(async () => undefined);
      const fire = async (id: string, kind: 'brief' | 'dreaming') => {
        state.storage.sql.exec('DELETE FROM schedule');
        await new Scheduler(state.storage.sql, state.storage, productionDeps()).schedule({ id, kind, payloadRefs: { id }, occurrenceAt: AT - 1000, dueAt: AT - 1000, recurrence: null });
        state.storage.kv.put('owner_alarm_last_v1', 1);
        await owner.alarm();
        await state.storage.deleteAlarm();
      };
      await run({
        state,
        nightly: () => fire(NIGHTLY_ID, 'dreaming'),
        card: async id => { dayPlanBook(state.storage.sql).save(DAY, { card: id, time: '08:00', reason: 'planned' }); await fire(id, 'brief'); },
        codes: hop => state.storage.sql.exec<{ note: string | null }>('SELECT note FROM trace_log WHERE hop = ? ORDER BY rowid', hop).toArray().map(row => row.note || null),
        stored: () => {
          const kv = [...state.storage.kv.list()].map(([key, value]) => `${key} ${JSON.stringify(value)}`);
          const tables = state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'").toArray().map(row => row.name);
          return [...kv, ...tables.flatMap(table => state.storage.sql.exec(`SELECT * FROM "${table}"`).toArray().map(row => JSON.stringify(row)))].join('\n');
        },
        approvals: async () => appApprovalListV1Schema.parse(await (await owner.fetch(new Request('https://telegram-owner/app/v1/approvals?state=open',
          { headers: { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': SESSION } }))).json()).approvals,
      });
    } finally { Date.now = originalNow; quiet.mockRestore(); await state.storage.deleteAlarm(); }
  });
};
const store = (state: DurableObjectState) => claimStore(state.storage.sql, work => state.storage.transactionSync(work));

describe('the nightly capacity pass on the owner object', { timeout: 30_000 }, () => {
  it('keeps the note in memory, on the chat model, from the calendar\'s shape, and says no health is shared', async () => {
    await owned('capacity-nightly-on', { CAPACITY_PLAN: '1' }, async ({ state, nightly, codes }) => {
      await nightly();
      expect(model.capacity).toHaveLength(1);
      expect(model.capacity[0]!.model).not.toBe(WALDO_AUXILIARY_MODEL);
      expect(model.capacity[0]!.input).toContain(NO_SHARED_HEALTH);
      expect(model.capacity[0]!.input).toContain('1 commitment');
      expect(model.capacity[0]!.input).not.toContain('Priya');
      expect(capacityNote(store(state), state.storage.kv)).toMatchObject({ text: NOTE, owner: false });
      expect(codes('capacity')).toEqual(['kept']);
    });
  });

  it('with health shared, the model reads it and nothing the owner object stores keeps it', async () => {
    health.shared = true;
    await owned('capacity-nightly-health', { CAPACITY_PLAN: '1' }, async ({ nightly, stored }) => {
      await nightly();
      expect(model.capacity[0]!.input).toContain('Form zone:');
      expect(model.capacity[0]!.input).not.toContain(NO_SHARED_HEALTH);
      expect(stored()).not.toContain('slept 47 minutes under baseline');
      expect(stored()).not.toContain('Form zone:');
    });
  });

  it('asks nothing with the switch off, or with the owner\'s health notes off', async () => {
    await owned('capacity-nightly-off', { CAPACITY_PLAN: '0' }, async ({ state, nightly, codes }) => {
      await nightly();
      expect(state.storage.kv.get(CAPACITY_NOTE_KEY)).toBeUndefined();
      expect(codes('capacity')).toEqual([]);
    });
    await owned('capacity-nightly-notes-off', { CAPACITY_PLAN: '1' }, async ({ state, nightly, codes }) => {
      setHealthMemory(state.storage.kv, 'off');
      await nightly();
      expect(codes('capacity')).toEqual(['health_notes_off']);
    });
    expect(model.capacity).toEqual([]);
  });

  it('the model reads what the owner asked to forget, and a note it marks as touching it is not kept', async () => {
    model.capacityReply = JSON.stringify({ note: 'Since the burnout, owner sustains one focus block a day.', touches_forgotten: true });
    await owned('capacity-nightly-forgotten', { CAPACITY_PLAN: '1' }, async ({ state, nightly, codes }) => {
      store(state).barrier('my burnout', '2030-03-04T09:00:00Z');
      await nightly();
      // As in every memory pass: the barrier list, whose topics are kept only as fingerprints.
      expect(model.capacity[0]!.input).toContain(JSON.stringify(barrierPrompt(store(state))).slice(1, -1));
      expect(codes('capacity')).toEqual(['held']);
      expect(capacityNote(store(state), state.storage.kv)).toBeNull();
    });
  });

  it('a model failure is logged and the night goes on', async () => {
    model.capacityReply = 'not json';
    await owned('capacity-nightly-fails', { CAPACITY_PLAN: '1' }, async ({ state, nightly, codes }) => {
      await nightly();
      expect(state.storage.sql.exec<{ ok: number }>("SELECT ok FROM trace_log WHERE hop = 'capacity'").toArray()).toEqual([{ ok: 0 }]);
      expect(state.storage.sql.exec<{ ok: number }>("SELECT ok FROM trace_log WHERE hop = 'machine_turn' AND trace = ?", `${NIGHTLY_ID}:${AT - 1000}`).toArray()).toEqual([{ ok: 1 }]);
      expect(state.storage.kv.get(CAPACITY_NOTE_KEY)).toBeUndefined();
    });
  });
});

describe('the Brief and the Close with CAPACITY_PLAN', { timeout: 30_000 }, () => {
  it('the Close reads the note as job context, in the chat role, and says tomorrow\'s shape; off, it reads neither', async () => {
    model.card = [{ text: 'The Close\nA good day. Tomorrow, hold nine to eleven for the deck.' }];
    await owned('capacity-close-on', { CAPACITY_PLAN: '1' }, async ({ nightly, card }) => {
      await nightly();
      await card('card:close');
      const asked = JSON.parse(model.cards[0]!.request) as { messages: readonly { content: string }[] };
      const content = String(asked.messages.at(-1)?.content);
      expect(content).toContain(NOTE);
      expect(content).toContain(CAPACITY_LINES.close);
      // The note travels as the job's context after the card's own text, which the day_card trace keeps.
      expect(content.indexOf(NOTE)).toBeGreaterThan(content.indexOf(PROSE_RULE));
      expect(model.cards[0]!.model).not.toBe(WALDO_AUXILIARY_MODEL);
    });
    model.cards = []; model.card = [{ text: 'The Close\nA good day.' }];
    await owned('capacity-close-off', { CAPACITY_PLAN: '0' }, async ({ card }) => {
      await card('card:close');
      expect(model.cards[0]!.request).not.toContain(JSON.stringify(CAPACITY_LINES.close).slice(1, -1));
      expect(model.cards[0]!.request).not.toContain('capacity_note');
    });
  });

  it('the planning Brief raises the weekly reset as a rest block on a card under the owner\'s limits, and the next card sees it waiting', async () => {
    const RESET = { action: 'create', title: 'Reset: long walk, no screens', start: `${DAY}T17:00:00Z`, end: `${DAY}T19:00:00Z`, block: 'rest', reason: 'Your week ran heavy; Saturday afternoon is the stretch you keep free' };
    model.card = [{ calls: [{ name: 'propose_calendar_change', arguments: RESET }] }, { text: 'The Brief\nA heavy week behind you. I put a reset on a card for your yes.' },
      { text: 'The Close\nThe reset waits on your yes.' }];
    await owned('capacity-brief-reset', { CAPACITY_PLAN: '1', PLANNING_BRIEF: '1', PROACTIVE_GATE: '1' }, async ({ state, card, approvals }) => {
      const book = interruptBook(state.storage.kv, { now: () => Date.now(), timezone: () => 'UTC', ownerSpokeSince: at => ownerSpokeSince(state.storage.sql, at) });
      await card('card:brief');
      expect(model.cards[0]!.tools).toContain('propose_calendar_change');
      expect(model.cards[0]!.request).toContain(JSON.stringify(CAPACITY_LINES.planningBrief).slice(1, -1));
      expect(await approvals()).toMatchObject([{ kind: 'calendar_change', state: 'open' }]);
      expect(calendar.created).toBe(0);
      expect(book.spent().count).toBe(0);
      expect(book.question()).toBeNull();
      await card('card:close');
      const close = model.cards.find(asked => asked.request.includes('Scheduled card \\"The Close'))!;
      expect(close.request).toContain('rest block for Tue 5 Mar, proposed Tue 5 Mar: waiting on them');
      expect(close.request.split('Protected blocks')[1]).not.toContain('long walk');
    });
  });

  it('a note drawn from the body is not shown once the owner stops sharing health', async () => {
    health.shared = true;
    model.card = [{ text: 'The Close\nA good day.' }, { text: 'The Close\nA good day.' }];
    await owned('capacity-close-revoked', { CAPACITY_PLAN: '1' }, async ({ nightly, card }) => {
      await nightly();
      await card('card:close');
      expect(model.cards[0]!.request).toContain(NOTE);
      health.shared = false;
      await card('card:close');
      const after = model.cards.at(-1)!.request;
      expect(after).not.toContain(NOTE);
      expect(after).toContain(NO_NOTE);
    });
  });

  it('without a note yet, the Brief is told so and no capacity is guessed', async () => {
    model.card = [{ text: 'The Brief\nBoard review at three.' }];
    await owned('capacity-brief-no-note', { CAPACITY_PLAN: '1' }, async ({ card }) => {
      await card('card:brief');
      expect(model.cards[0]!.request).toContain(NO_NOTE);
      expect(model.cards[0]!.request).toContain(JSON.stringify(CAPACITY_LINES.brief).slice(1, -1));
    });
  });
});

// TOMORROW_TODAY: the Close names tomorrow's best hours and puts what would protect them on the owner's cards.
describe('the Close with TOMORROW_TODAY', { timeout: 30_000 }, () => {
  const HOLD = { action: 'create', title: 'Deck', start: '2030-03-06T08:00:00Z', end: '2030-03-06T09:45:00Z', block: 'deep_work', reason: 'Your best hours are early and one block holds after a heavy day' };
  it('raises a deep-work card in the chat role, under the owner\'s limits, and the calendar waits for yes; off, it offers no card', async () => {
    model.card = [{ calls: [{ name: 'propose_calendar_change', arguments: HOLD }] }, { text: 'The Close\nTomorrow your best stretch is before Standup; a block for it waits on your yes. Done for today.' }];
    await owned('tomorrow-close-on', { TOMORROW_TODAY: '1', PROACTIVE_GATE: '1' }, async ({ state, card, approvals }) => {
      const book = interruptBook(state.storage.kv, { now: () => Date.now(), timezone: () => 'UTC', ownerSpokeSince: at => ownerSpokeSince(state.storage.sql, at) });
      await card('card:close');
      expect(model.cards[0]!.tools).toContain('propose_calendar_change');
      expect(model.cards[0]!.request).toContain(JSON.stringify(TOMORROW_TODAY_INSTRUCTION).slice(1, -1));
      expect(model.cards[0]!.model).not.toBe(WALDO_AUXILIARY_MODEL);
      expect(await approvals()).toMatchObject([{ kind: 'calendar_change', state: 'open', exact: { changes: { action: 'create', title: 'Deck' } } }]);
      expect(calendar.created).toBe(0);
      expect(book.spent().count).toBe(0);
      expect(book.question()).toBeNull();
    });
    model.cards = []; model.card = [{ text: 'The Close\nA good day.' }];
    await owned('tomorrow-close-off', { TOMORROW_TODAY: '0' }, async ({ card, approvals }) => {
      await card('card:close');
      expect(model.cards[0]!.tools).not.toContain('propose_calendar_change');
      expect(await approvals()).toEqual([]);
    });
  });

  it('with health shared, refuses a card whose title carries a health word, and raises the clean one', async () => {
    health.shared = true;
    model.card = [{ calls: [{ name: 'propose_calendar_change', arguments: { ...HOLD, title: 'Low recovery focus' } }] },
      { calls: [{ name: 'propose_calendar_change', arguments: HOLD }] }, { text: 'The Close\nA block for the deck waits on your yes.' }];
    await owned('tomorrow-close-egress', { TOMORROW_TODAY: '1' }, async ({ card, approvals }) => {
      await card('card:close');
      const cards = await approvals();
      expect(cards).toHaveLength(1);
      expect(cards[0]).toMatchObject({ exact: { changes: { title: 'Deck' } } });
      expect(calendar.created).toBe(0);
    });
  });

  it('without shared health, plans from the calendar and is told there is none', async () => {
    model.card = [{ text: 'The Close\nTomorrow is open before three.' }];
    await owned('tomorrow-close-no-health', { TOMORROW_TODAY: '1' }, async ({ card }) => {
      await card('card:close');
      expect(model.cards[0]!.request).toContain('No derived health context is available for this invocation.');
      expect(model.cards[0]!.tools).toContain('propose_calendar_change');
    });
  });
});

// The planning Brief (PLANNING_BRIEF), through the real owner object on the app: the Brief asks one question with answers to
// tap, the owner's answer is an ordinary turn that puts a change on an approval card, and the calendar changes only on yes.
// The model is scripted, so these prove the path (tools offered, cards raised, what reaches the owner and when), not the
// judgment; whether a live model plans well is the judged eval's. Every reading and event is synthetic.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appHistoryResultV1Schema } from '../../contracts/src/app/core';
import { appApprovalDecisionResultV1Schema, appApprovalListV1Schema } from '../../contracts/src/app/approvals';
import { appSubjectFor } from '../src/channels/app-api';
import { dayPlanBook } from '../src/channels/day-cards';
import { traceBook } from '../src/channels/harness';
import type { LLMGatewayRequest } from '../src/llm/provider';
import { claimStore, FORGOTTEN } from '../src/memory/claims';
import { redactConversationEntries } from '../src/channels/conversation-store';
import { DAY_CARDS, PLANNING_BRIEF_INSTRUCTION } from '../src/prompt/day-cards';
import { interruptBook } from '../src/channels/interruptions';
import { ownerSpokeSince } from '../src/channels/episodes';
import { Scheduler } from '../src/scheduler/multiplexer';
import { toContextHealthMaterial } from '../src/channels/health-context';
import { renderHealth } from '../src/context-composer/prompt';
import { productionDeps } from '../src/seams/deps';
import { ensureSchema } from '../src/tracer/schema';

type Call = Readonly<{ name: string; arguments: Record<string, unknown> }>;
type Round = Readonly<{ calls: readonly Call[] }> | Readonly<{ text: string }>;
// Each scripted turn is a list of rounds; a request is the Brief's when it carries the scheduled-card header.
const model = vi.hoisted(() => ({ brief: [] as Round[], owner: [] as Round[], briefTools: [] as string[][], ownerTools: [] as string[][], briefAsked: [] as string[], briefRequests: [] as string[], ownerRequests: [] as string[], results: [] as string[] }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete({ request }: LLMGatewayRequest) {
    const done = (text: string, calls?: readonly Call[]) => ({ ok: true as const, data: { model: request.model, text,
      ...(calls ? { tool_calls: calls.map((call, index) => ({ call_id: `${call.name}-${index}-${Math.random().toString(36).slice(2, 8)}`, name: call.name, arguments: JSON.stringify(call.arguments) })) } : {}),
      input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } });
    if (request.response_format) return done(request.response_format.name === 'task_source_scope' ? '{"decision":"retain","sources":[]}' : '{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}');
    const asked = String(request.messages.at(-1)?.content ?? '');
    const brief = asked.includes('[Scheduled card "The Brief"');
    (brief ? model.briefTools : model.ownerTools).push((request.tools ?? []).map(tool => tool.name));
    if (brief) model.briefAsked.push(asked);
    (brief ? model.briefRequests : model.ownerRequests).push(JSON.stringify(request));
    model.results.push(...(request.tool_turns ?? []).flatMap(turn => [turn.output]));
    const round = (brief ? model.brief : model.owner).shift();
    if (!round) return done('Noted.');
    return 'text' in round ? done(round.text) : done('', round.calls);
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const calendar = vi.hoisted(() => ({ events: [] as Record<string, unknown>[], created: [] as Record<string, unknown>[], moved: 0 }));
vi.mock('../src/connectors/google', async load => {
  const original = await load<typeof import('../src/connectors/google')>();
  return { ...original, googleClient: (...args: Parameters<typeof original.googleClient>) => args[0].clientId !== 'planning-fixture' ? original.googleClient(...args) : ({
    account: { connection_id: null, email: 'owner@example.test' },
    events: async () => calendar.events,
    event: async (id: string) => ({ ...calendar.events.find(event => event.id === id), etag: 'etag-1' }),
    createEvent: async (input: Record<string, unknown>) => { calendar.created.push(input); return { id: 'created-1', etag: 'etag-created', title: input.title, start: input.start, end: input.end, status: 'confirmed' }; },
    moveEvent: async () => { calendar.moved += 1; return { id: 'moved', etag: 'etag-2' }; },
  }) };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '6e5d4c3b-2a19-4f08-9e7d-6c5b4a392817';
const DAY = '2030-03-05';
const AT = Date.parse(`${DAY}T08:00:00Z`);
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const google = { GOOGLE_CLIENT_ID: 'planning-fixture', GOOGLE_CLIENT_SECRET: 'fictional-secret', WALDO_OAUTH_STATE_SECRET: 'fictional-state-secret' };
const SESSION = 'c'.repeat(64);
const headers = (name: string) => ({ 'x-waldo-do-name': name, 'x-waldo-app-session-hash': SESSION, 'content-type': 'application/json' });
const STARTUP = { id: 'ev-startup', title: 'Startup time', start: `${DAY}T15:00:00Z`, end: `${DAY}T16:45:00Z`, status: 'confirmed' };
const BLOCK = { action: 'create', title: 'Deck', start: `${DAY}T09:30:00Z`, end: `${DAY}T12:30:00Z`, block: 'deep_work', reason: 'Hold the morning for the deck' };
const ANSWERS = ['Finish the deck', 'Gym first', 'Something else'];
// The owner's shared health for one test; every other test shares none. Distinct words, so their absence from storage is a real check.
const health = vi.hoisted(() => ({ shared: false, unreadable: false }));
const HEALTH_WORDS = ['Form zone:', 'slept 52 minutes under baseline', 'Recovery: low'];
const NO_HEALTH = 'No derived health context is available for this invocation.';
const HEALTH_ROW = { context: { id: 'planning-health', day: DAY, form: { score: 41, zone: 'low' }, recovery: { score: 38, zone: 'low' },
  weight: { score: 70, zone: 'high' }, drivers: ['slept 52 minutes under baseline'], confidence: 0.8, freshness: 'fresh', tags: [], compiled_at: new Date(AT - 3_600_000).toISOString() }, previous: null };
// The form zone word the Brief's prompt shows for that row.
const SHOWN_ZONE = /Form zone: ([a-z]+)\./.exec(renderHealth(toContextHealthMaterial(HEALTH_ROW as never, { now: () => new Date(AT), timezone: 'UTC' })))![1]!;
// Staging loads non-core tools through find_tools and use_tool in an owner's own turn; the default loader offers them directly.
const via = (harness: boolean, name: string, args: Record<string, unknown>): Round[] => harness
  ? [{ calls: [{ name: 'find_tools', arguments: { names: [name] } }] }, { calls: [{ name: 'use_tool', arguments: { name, arguments: args } }] }]
  : [{ calls: [{ name, arguments: args }] }];
// Every row the owner object keeps: KV values and the rows of each table it can read.
const storedText = (state: DurableObjectState) => {
  const kv = [...state.storage.kv.list()].map(([key, value]) => `${key} ${JSON.stringify(value)}`);
  const tables = state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'").toArray().map(row => row.name);
  return [...kv, ...tables.flatMap(table => state.storage.sql.exec(`SELECT * FROM "${table}"`).toArray().map(row => JSON.stringify(row)))].join('\n');
};

beforeEach(() => {
  model.brief = []; model.owner = []; model.briefTools = []; model.ownerTools = []; model.briefAsked = []; model.briefRequests = []; model.ownerRequests = []; model.results = []; health.shared = false; health.unreadable = false;
  calendar.events = [STARTUP]; calendar.created = []; calendar.moved = 0;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(String(input instanceof Request ? input.url : input))?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    if (fn === 'health_log_recent') return Response.json([]);
    if (fn === 'health_context_read') return health.unreadable ? new Response('unavailable', { status: 503 }) : Response.json(health.shared ? HEALTH_ROW : { context: null, previous: null });
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
type Steps = Readonly<{
  owner: Owner; state: DurableObjectState;
  // The Brief fires through the scheduler, as it does at its planned time.
  brief(): Promise<void>;
  say(text: string): Promise<void>;
  history(): Promise<ReturnType<typeof appHistoryResultV1Schema.parse>>;
  approvals(): Promise<ReturnType<typeof appApprovalListV1Schema.parse>['approvals']>;
  decide(approval: Readonly<{ approval_id: string; payload_digest: string }>): Promise<ReturnType<typeof appApprovalDecisionResultV1Schema.parse>>;
  hops(): string[];
}>;

const owned = async (name: string, settings: Readonly<Record<string, unknown>>, run: (steps: Steps) => Promise<void>, connected = true) => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const originalNow = Date.now;
    let clock = AT;
    Date.now = () => clock;
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      claimStore(state.storage.sql); ensureSchema(state.storage); traceBook(state.storage.sql);
      state.storage.kv.put('do_name', name);
      state.storage.kv.put('app_subject', String(appSubjectFor(name)));
      state.storage.kv.put('timezone', 'UTC');
      state.storage.kv.put('timezone_confirmed', true);
      await state.storage.put('origin', 'https://fixture.invalid');
      if (connected) await state.storage.put('google:accounts', [{ id: 'local:owner@example.test', email: 'owner@example.test', scopes: null, refresh_token: 'fictional-not-a-token' }]);
      const owner = new OwnerDO(state, { ...env, ...directory, ...google, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC',
        WALDO_OWNER_TELEGRAM_ID: undefined, WALDO_TOOL_OFFLOAD: '0', ...settings } as never) as unknown as Owner;
      await owner.setup('app').ready;
      await owner.serial(async () => undefined);
      const app = (path: string, body?: unknown) => owner.fetch(new Request(`https://telegram-owner/app/v1${path}`, { method: body === undefined ? 'GET' : 'POST', headers: headers(name), ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
      let sent = 0;
      await run({
        owner, state,
        brief: async () => {
          state.storage.sql.exec('DELETE FROM schedule');
          dayPlanBook(state.storage.sql).save(DAY, { card: 'card:brief', time: '08:00', reason: 'planned' });
          await new Scheduler(state.storage.sql, state.storage, productionDeps())
            .schedule({ id: 'card:brief', kind: 'brief', payloadRefs: { id: 'card:brief' }, occurrenceAt: AT - 1000, dueAt: AT - 1000, recurrence: null });
          state.storage.kv.put('owner_alarm_last_v1', 1);
          await owner.alarm();
          await state.storage.deleteAlarm();
        },
        say: async text => {
          clock += 60_000; sent += 1;
          const response = await app('/chat/main/messages', { client_message_id: `planning-client-${String(sent).padStart(4, '0')}`, text });
          expect(response.status).toBe(202);
          const { message_id: id } = await response.json() as { message_id: string };
          await vi.waitFor(() => expect(state.storage.kv.get<{ state: string }>(`app:inbox-record:${id}`)?.state).toBe('completed'), { timeout: 10_000, interval: 20 });
        },
        history: async () => appHistoryResultV1Schema.parse(await (await app('/chat/main')).json()),
        approvals: async () => appApprovalListV1Schema.parse(await (await app('/approvals?state=open')).json()).approvals,
        decide: async approval => appApprovalDecisionResultV1Schema.parse(await (await app('/approvals/decisions', { approval_id: approval.approval_id, action: 'approve', expected_digest: approval.payload_digest, request_id: `planning-decision-${approval.approval_id}`.slice(0, 64) })).json()),
        hops: () => state.storage.sql.exec<{ hop: string }>("SELECT hop FROM trace_log ORDER BY rowid").toArray().map(row => row.hop),
      });
    } finally { Date.now = originalNow; quiet.mockRestore(); await state.storage.deleteAlarm(); }
  });
};
const briefRow = (history: Awaited<ReturnType<Steps['history']>>) => history.messages.find(message => message.role === 'assistant' && message.text.startsWith('The Brief'))!;

describe('the planning Brief on the app', { timeout: 30_000 }, () => {
  it.each([['default', false], ['harness', true]] as const)('asks one question with answers to tap; the answer puts a block on a card; the calendar changes only on yes (%s loader)', async (loader, harness) => {
    const QUESTION = 'The Brief\nYour day is open until Startup time at 3. What do you want done this morning?';
    // The Brief is offered its proposal tools directly on either loader; the owner's own turn loads a deferred one as usual.
    model.brief = [{ calls: [{ name: 'offer_replies', arguments: { choices: ANSWERS } }] }, { text: QUESTION }];
    model.owner = [...via(harness, 'propose_calendar_change', BLOCK), { text: 'It is on a card for your yes.' }];
    await owned(`planning-brief-ask-${loader}`, { PLANNING_BRIEF: '1', ...(harness ? { WALDO_TOOL_LOADER: 'harness' } : {}) }, async ({ state, brief, say, history, approvals, decide, hops }) => {
      await brief();
      // The Brief planned with the planning instruction, could raise cards and offer answers, and was told no health is shared.
      expect(model.briefAsked[0]).toContain(PLANNING_BRIEF_INSTRUCTION);
      expect(model.briefRequests[0]).toContain(NO_HEALTH);
      expect(model.briefTools[0]).toEqual(expect.arrayContaining(['offer_replies', 'propose_calendar_change', 'propose_action']));
      if (harness) expect(model.briefTools[0]).toEqual(expect.arrayContaining(['find_tools', 'use_tool']));
      expect(model.results.some(result => result.includes('"offered":true'))).toBe(true);
      const delivered = briefRow(await history());
      expect(delivered.text).toBe(QUESTION);
      expect(delivered.parts).toEqual([{ type: 'text', text: QUESTION },
        { type: 'quick_replies', choices: ANSWERS.map((label, index) => ({ id: `r${index + 1}`, label })), fallback_text: ANSWERS.join(' / ') }]);
      expect(await approvals()).toEqual([]);

      // A tap sends the label as the owner's own message: an ordinary turn, which is not offered the card-only tool.
      await say(ANSWERS[0]!);
      expect(model.ownerRequests[0]).not.toContain('offer_replies');
      expect(model.ownerRequests[0]).toContain('propose_calendar_change');
      const [card] = await approvals();
      expect(card).toMatchObject({ kind: 'calendar_change', state: 'open', exact: { changes: { action: 'create', title: 'Deck' } } });
      expect(calendar.created).toEqual([]);
      // The trace: the Brief offered answers, was delivered, and the owner's own turn raised the card.
      expect(hops().filter(hop => ['tool_offer_replies', 'day_card', 'tool_propose_calendar_change'].includes(hop))).toEqual(['tool_offer_replies', 'day_card', 'tool_propose_calendar_change']);

      expect(await decide(card!)).toMatchObject({ receipt: { state: 'recorded' }, approval_state: 'done' });
      expect(calendar.created).toMatchObject([{ title: 'Deck', block: 'deep_work' }]);
      // The answers stay on the Brief's row; the owner's later turn did not move them.
      expect(briefRow(await history()).parts.map(part => part.type)).toEqual(['text', 'quick_replies']);
      // A forget reaches the answers on the row, and counts them until they are gone.
      expect(await redactConversationEntries(state.storage, ['Gym first'], FORGOTTEN)).toMatchObject({ remaining: 0 });
      const forgotten = briefRow(await history()).parts.find(part => part.type === 'quick_replies');
      expect(JSON.stringify(forgotten)).not.toContain('Gym first');
      expect(forgotten).toMatchObject({ choices: [{ label: 'Finish the deck' }, { label: FORGOTTEN }, { label: 'Something else' }] });
    });
  });

  it('on a full day raises its own change on a card, says nothing changed, and the calendar waits for yes', async () => {
    calendar.events = [STARTUP, { id: 'ev-review', title: 'Board review', start: `${DAY}T09:00:00Z`, end: `${DAY}T12:00:00Z`, status: 'confirmed' }, { id: 'ev-sync', title: 'Team sync', start: `${DAY}T12:00:00Z`, end: `${DAY}T14:30:00Z`, status: 'confirmed' }];
    const MOVE = { action: 'move', event_id: 'ev-sync', title: 'Team sync', start: `${DAY}T17:00:00Z`, end: `${DAY}T18:00:00Z`, reason: 'Free the afternoon before Startup time' };
    model.brief = [{ calls: [{ name: 'propose_calendar_change', arguments: MOVE }] }, { text: 'The Brief\nBack to back until 4:45. I put moving Team sync to 5 on a card for your yes.' }];
    await owned('planning-brief-full-day', { PLANNING_BRIEF: '1' }, async ({ brief, history, approvals }) => {
      await brief();
      expect(model.briefAsked[0]).toContain('Board review');
      const [card] = await approvals();
      expect(card).toMatchObject({ kind: 'calendar_change', state: 'open', presented_surfaces: ['app'], exact: { changes: { action: 'move', title: 'Team sync' } } });
      expect(calendar.moved).toBe(0);
      // A card a scheduled turn raises has no owner message to hang under: the app lists it with the owner's open approvals,
      // as it does a health proposal, and the Brief's row stays text.
      expect((await history()).messages.map(message => message.parts.map(part => part.type))).toEqual([['text']]);
    });
  });

  it('on an empty day with stale leftovers, reads before it builds on them and closes nothing itself', async () => {
    calendar.events = [];
    model.brief = [{ calls: [{ name: 'search_communication', arguments: { query: 'SYNTH-OTHER' } }] }, { calls: [{ name: 'offer_replies', arguments: { choices: ['Deep work', 'Admin catch-up'] } }] },
      { text: 'The Brief\nNothing on the calendar today, and I checked: nothing is owed. What should today be for?' }];
    await owned('planning-brief-empty-day', { PLANNING_BRIEF: '1' }, async ({ state, brief, history, approvals }) => {
      state.storage.sql.exec("INSERT INTO loops (id, title, status, created_at) VALUES ('loop-synth', 'SYNTH-OTHER room booking', 'open', ?)", AT - 86_400_000);
      await brief();
      expect(model.briefAsked[0]).toContain('No events.');
      expect(model.briefAsked[0]).toContain('SYNTH-OTHER room booking');
      expect(model.briefTools[0]).toContain('search_communication');
      // A card turn has no close tool: a stale loop stays until the owner, or a card they approve, closes it.
      expect(model.briefTools[0]).not.toContain('close_loop');
      expect(state.storage.sql.exec<{ status: string }>("SELECT status FROM loops WHERE id = 'loop-synth'").one().status).toBe('open');
      expect(await approvals()).toEqual([]);
      expect(briefRow(await history()).parts.map(part => part.type)).toEqual(['text', 'quick_replies']);
    });
  });

  it('with health shared, plans with it, and no stored row, card or answer keeps it', async () => {
    health.shared = true;
    const EASE = { action: 'create', title: 'Buffer', start: `${DAY}T13:00:00Z`, end: `${DAY}T14:00:00Z`, block: 'rest', reason: 'A lighter hour before Startup time' };
    model.brief = [{ calls: [{ name: 'propose_calendar_change', arguments: EASE }, { name: 'offer_replies', arguments: { choices: ['Keep it light', 'Push through'] } }] },
      { text: 'The Brief\nA low day on your scores, so keep the morning gentle. I put a buffer before Startup time on a card for your yes. How do you want to take today?' }];
    await owned('planning-brief-health', { PLANNING_BRIEF: '1' }, async ({ state, brief, history, approvals }) => {
      await brief();
      expect(model.briefRequests[0]).toContain('Form zone:');
      expect(model.briefRequests[0]).not.toContain(NO_HEALTH);
      const [card] = await approvals();
      expect(card).toMatchObject({ kind: 'calendar_change', exact: { changes: { action: 'create', title: 'Buffer' } } });
      expect(briefRow(await history()).parts.map(part => part.type)).toEqual(['text', 'quick_replies']);
      const stored = storedText(state);
      expect(stored).toContain('Keep it light');
      for (const word of HEALTH_WORDS) expect(stored).not.toContain(word);
    });
  });

  // ADR-0081 §3: what the Brief proposes for the calendar reaches Google, where guests read it. A health word in a title,
  // notes, place or guest list refuses that proposal in code, as on the health trigger's path; the model is left to word it again.
  it.each([
    ['a title naming the zone the Brief was shown', { title: `${SHOWN_ZONE[0]!.toUpperCase()}${SHOWN_ZONE.slice(1)} day buffer` }],
    ['notes naming a health subject', { title: 'Buffer', description: 'Recovery is down, keep it light' }],
    ['a guest address carrying a health word', { title: 'Buffer', attendees: ['sleep-coach@example.test'], send_updates: 'none' }],
  ])('with health shared, refuses a calendar proposal with %s, and raises the clean one', async (_case, fields) => {
    health.shared = true;
    const base = { action: 'create', start: `${DAY}T13:00:00Z`, end: `${DAY}T14:00:00Z`, block: 'rest', reason: 'A lighter hour before Startup time' };
    model.brief = [{ calls: [{ name: 'propose_calendar_change', arguments: { ...base, ...fields } }] },
      { calls: [{ name: 'propose_calendar_change', arguments: { ...base, title: 'Buffer' } }] }, { text: 'The Brief\nI put a buffer before Startup time on a card for your yes.' }];
    await owned(`planning-brief-egress-${fields.title.length}-${Object.keys(fields).length}`, { PLANNING_BRIEF: '1' }, async ({ brief, approvals, hops }) => {
      await brief();
      expect(model.briefRequests[0]).toContain(`Form zone: ${SHOWN_ZONE}.`);
      expect(model.results.some(result => result.includes('"code":"rejected"'))).toBe(true);
      const cards = await approvals();
      expect(cards).toHaveLength(1);
      expect(cards[0]).toMatchObject({ kind: 'calendar_change', exact: { changes: { action: 'create', title: 'Buffer' } } });
      expect(JSON.stringify(cards).toLowerCase()).not.toMatch(new RegExp(`sleep-coach|recovery is down|${SHOWN_ZONE} day`));
      expect(calendar.created).toEqual([]);
      expect(hops().filter(hop => hop === 'tool_propose_calendar_change')).toHaveLength(2);
    });
  });

  it('without health shared, still keeps the general health words off the calendar', async () => {
    const base = { action: 'create', start: `${DAY}T13:00:00Z`, end: `${DAY}T14:00:00Z`, block: 'rest', reason: 'A lighter hour' };
    model.brief = [{ calls: [{ name: 'propose_calendar_change', arguments: { ...base, title: 'Sleep in' } }] }, { text: 'The Brief\nNo change today.' }];
    await owned('planning-brief-egress-unshared', { PLANNING_BRIEF: '1' }, async ({ brief, approvals }) => {
      await brief();
      expect(model.results.some(result => result.includes('"code":"rejected"'))).toBe(true);
      expect(await approvals()).toEqual([]);
    });
  });

  it('refuses its calendar proposal when the health context cannot be read to check it', async () => {
    health.unreadable = true;
    model.brief = [{ calls: [{ name: 'propose_calendar_change', arguments: { ...BLOCK, title: 'Deck' } }] }, { text: 'The Brief\nNo change today.' }];
    await owned('planning-brief-egress-unreadable', { PLANNING_BRIEF: '1' }, async ({ brief, approvals }) => {
      await brief();
      expect(model.results.some(result => result.includes('"code":"rejected"'))).toBe(true);
      expect(await approvals()).toEqual([]);
      expect(calendar.created).toEqual([]);
    });
  });

  it('without a calendar grant still plans and asks, and is offered no calendar change', async () => {
    model.brief = [{ calls: [{ name: 'offer_replies', arguments: { choices: ['Deck', 'Something else'] } }] }, { text: 'The Brief\nGoogle is not connected, so I cannot see your calendar. What matters most today?' }];
    await owned('planning-brief-no-grant', { PLANNING_BRIEF: '1' }, async ({ brief, history }) => {
      await brief();
      expect(model.briefAsked[0]).toContain('Google is not connected');
      expect(model.briefTools[0]).toContain('offer_replies');
      expect(model.briefTools[0]).not.toContain('propose_calendar_change');
      expect(briefRow(await history()).parts.map(part => part.type)).toEqual(['text', 'quick_replies']);
    }, false);
  });

  it('with the switch off is the recap Brief: its instruction, no answers to tap and no calendar change offered', async () => {
    for (const [name, settings] of [['planning-brief-off', { PLANNING_BRIEF: '0' }], ['planning-brief-unset', {}]] as const) {
      model.brief = [{ calls: [{ name: 'offer_replies', arguments: { choices: ['Deck'] } }] }, { text: 'The Brief\nOne event today: Startup time at 3.' }];
      model.briefTools = []; model.briefAsked = []; model.results = [];
      await owned(name, settings, async ({ brief, history, say }) => {
        await brief();
        expect(model.briefAsked[0]).toContain(DAY_CARDS[0]!.instruction);
        expect(model.briefAsked[0]).not.toContain(PLANNING_BRIEF_INSTRUCTION);
        expect(model.briefTools[0]).not.toContain('offer_replies');
        expect(model.briefTools[0]).not.toContain('propose_calendar_change');
        expect(briefRow(await history()).parts.map(part => part.type)).toEqual(['text']);
        await say('thanks');
        expect(model.ownerTools.at(-1)).not.toContain('offer_replies');
      });
    }
  });
});

// PROACTIVE_GATE: the Brief's answers to tap are the day's one question in flight, until the owner says anything.
describe('the Brief\'s question under the owner\'s limits', { timeout: 30_000 }, () => {
  it('opens the question when it offers answers, and the owner\'s next message, on the real index, closes it', async () => {
    model.brief = [{ calls: [{ name: 'offer_replies', arguments: { choices: ANSWERS } }] }, { text: 'The Brief\nYour morning is open. What do you want done?' }];
    model.owner = [{ text: 'On it.' }];
    await owned('planning-brief-question-gate', { PLANNING_BRIEF: '1', PROACTIVE_GATE: '1' }, async ({ state, brief, say }) => {
      const book = interruptBook(state.storage.kv, { now: () => Date.now(), timezone: () => 'UTC', ownerSpokeSince: at => ownerSpokeSince(state.storage.sql, at) });
      await brief();
      expect(book.question()).toMatchObject({ ref: `card:brief:${DAY}` });
      expect(book.spent().count).toBe(0);
      await say(ANSWERS[0]!);
      expect(book.question()).toBeNull();
    });
  });

  it('with the switch off the Brief opens no question', async () => {
    model.brief = [{ calls: [{ name: 'offer_replies', arguments: { choices: ANSWERS } }] }, { text: 'The Brief\nYour morning is open. What do you want done?' }];
    await owned('planning-brief-question-off', { PLANNING_BRIEF: '1', PROACTIVE_GATE: '0' }, async ({ state, brief }) => {
      await brief();
      expect(state.storage.kv.get('proactive_question_v1')).toBeUndefined();
    });
  });
});

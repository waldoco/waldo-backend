// The planning Brief (PLANNING_BRIEF), through the real owner object on the app: the Brief asks one question with answers to
// tap, the owner's answer is an ordinary turn that puts a change on an approval card, and the calendar changes only on yes.
// The model is scripted, so these prove the path (tools offered, cards raised, what reaches the owner and when), not the
// judgment; whether a live model plans well is the judged eval's. Every reading and event is synthetic.
import { APP_SCHEDULE_RECEIPTS_V1 } from '../../contracts/src/app/controls';
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
import { armInterventionReview, INTERVENTION_REVIEW_ID } from '../src/channels/interventions';
import { loopBook } from '../src/channels/loops';
import { schedulePreferences } from '../src/channels/schedule-preferences';
import { Scheduler } from '../src/scheduler/multiplexer';
import { toContextHealthMaterial } from '../src/channels/health-context';
import { renderHealth } from '../src/context-composer/prompt';
import { productionDeps } from '../src/seams/deps';
import { ensureSchema } from '../src/tracer/schema';
import { routerSignature } from '../src/identity/owner-directory';

type Call = Readonly<{ name: string; arguments: Record<string, unknown> }>;
type Round = Readonly<{ calls: readonly Call[] }> | Readonly<{ text: string }>;
// Each scripted turn is a list of rounds; a request is the Brief's when it carries the scheduled-card header.
const model = vi.hoisted(() => ({ briefModels: [] as string[], brief: [] as Round[], owner: [] as Round[], briefTools: [] as string[][], ownerTools: [] as string[][], briefAsked: [] as string[], briefRequests: [] as string[], ownerRequests: [] as string[], results: [] as string[] }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete({ request }: LLMGatewayRequest) {
    const done = (text: string, calls?: readonly Call[]) => ({ ok: true as const, data: { model: request.model, text,
      ...(calls ? { tool_calls: calls.map((call, index) => ({ call_id: `${call.name}-${index}-${Math.random().toString(36).slice(2, 8)}`, name: call.name, arguments: JSON.stringify(call.arguments) })) } : {}),
      input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } });
    if (request.response_format) return done(request.response_format.name === 'task_source_scope' ? '{"decision":"retain","sources":[]}' : '{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}');
    const asked = String(request.messages.at(-1)?.content ?? '');
    const brief = asked.includes('[Scheduled card "');
    if (brief) model.briefModels.push(request.model);
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
  model.briefModels = []; model.brief = []; model.owner = []; model.briefTools = []; model.ownerTools = []; model.briefAsked = []; model.briefRequests = []; model.ownerRequests = []; model.results = []; health.shared = false; health.unreadable = false;
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
  // Any day card, fired the same way.
  card(id: 'card:midday' | 'card:close'): Promise<void>;
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
        card: async id => {
          state.storage.sql.exec('DELETE FROM schedule');
          dayPlanBook(state.storage.sql).save(DAY, { card: id, time: '08:00', reason: 'planned' });
          await new Scheduler(state.storage.sql, state.storage, productionDeps())
            .schedule({ id, kind: 'brief', payloadRefs: { id }, occurrenceAt: AT - 1000, dueAt: AT - 1000, recurrence: null });
          state.storage.kv.put('owner_alarm_last_v1', 1);
          await owner.alarm();
          await state.storage.deleteAlarm();
        },
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

// PROACTIVE_ACT_AHEAD: the day shape the owner approved. The Check-in offers its one decision on a card, like the planning Brief,
// in the chat role; whether the plan slipped, and so whether it says anything, is the model's.
describe('the day shape (PROACTIVE_ACT_AHEAD)', { timeout: 30_000 }, () => {
  it('the Check-in may put its decision on a card, in the chat role; with the switch off it reads and writes only', async () => {
    const MOVE = { action: 'move', event_id: 'ev-startup', title: 'Startup time', start: `${DAY}T17:00:00Z`, end: `${DAY}T18:45:00Z`, reason: 'The deck block slipped; this gives it the afternoon' };
    model.brief = [{ calls: [{ name: 'propose_calendar_change', arguments: MOVE }] }, { text: 'Check-in\nThe deck block slipped. Moving Startup time to 5 gives it back; it is on a card.' }];
    await owned('day-shape-midday-on', { PROACTIVE_ACT_AHEAD: '1' }, async ({ card, approvals }) => {
      await card('card:midday');
      expect(model.briefTools[0]).toContain('propose_calendar_change');
      expect(await approvals()).toMatchObject([{ kind: 'calendar_change', state: 'open' }]);
      expect(calendar.moved).toBe(0);
    });
    const on = model.briefModels[0];
    model.briefTools = []; model.briefModels = []; model.brief = [{ text: 'SKIP' }];
    await owned('day-shape-midday-off', { PROACTIVE_ACT_AHEAD: '0' }, async ({ card, approvals }) => {
      await card('card:midday');
      expect(model.briefTools[0]).not.toContain('propose_calendar_change');
      expect(await approvals()).toEqual([]);
    });
    expect(model.briefModels[0]).not.toBe(on);
  });

  it('a Check-in that finds the plan holding sends nothing', async () => {
    model.brief = [{ text: 'SKIP' }];
    await owned('day-shape-midday-holding', { PROACTIVE_ACT_AHEAD: '1' }, async ({ card, history, approvals }) => {
      await card('card:midday');
      expect((await history()).messages).toEqual([]);
      expect(await approvals()).toEqual([]);
    });
  });
});

// PROACTIVE_INTERVENTIONS: Waldo's own look is a patrol entry beside the health trigger's. Its tick starts one reader job when
// something could still reach the owner, and none when the owner said no to unasked messages.
describe('Waldo\'s own look (PROACTIVE_INTERVENTIONS)', { timeout: 30_000 }, () => {
  const tick = async (state: DurableObjectState, owner: Steps['owner']) => {
    state.storage.sql.exec('DELETE FROM schedule');
    await new Scheduler(state.storage.sql, state.storage, productionDeps())
      .schedule({ id: INTERVENTION_REVIEW_ID, kind: 'patrol', payloadRefs: { id: INTERVENTION_REVIEW_ID }, occurrenceAt: AT - 1000, dueAt: AT - 1000, recurrence: null });
    state.storage.kv.put('owner_alarm_last_v1', 1);
    await owner.alarm();
    await state.storage.deleteAlarm();
  };
  const looks = (state: DurableObjectState) => state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM task_jobs WHERE origin = 'machine:intervention'").one().n;

  it('the tick starts one reader job; the health trigger keeps its own patrol entry', async () => {
    await owned('intervention-tick-on', { PROACTIVE_GATE: '1', PROACTIVE_INTERVENTIONS: '1' }, async ({ state, owner, hops }) => {
      await tick(state, owner);
      expect(looks(state)).toBe(1);
      expect(hops()).toContain('intervention_review');
      expect(hops()).not.toContain('health_trigger');
    });
  });

  it('with the owner\'s no to unasked messages, or the switch off, the tick starts nothing', async () => {
    await owned('intervention-tick-declined', { PROACTIVE_GATE: '1', PROACTIVE_INTERVENTIONS: '1' }, async ({ state, owner }) => {
      loopBook(state.storage.sql, { newId: () => 'l', now: () => AT }).setProactivity({ quiet_start: null, quiet_end: null, volume: 'normal', followups: false });
      await tick(state, owner);
      expect(looks(state)).toBe(0);
    });
    await owned('intervention-tick-off', { PROACTIVE_INTERVENTIONS: '0' }, async ({ state, owner }) => {
      await tick(state, owner);
      expect(looks(state)).toBe(0);
    });
  });

  it('each tick arms the next look inside the owner\'s day: on its cadence by day, at the next Brief after the Close', async () => {
    await owned('intervention-next-look', { PROACTIVE_GATE: '1', PROACTIVE_INTERVENTIONS: '1', PROACTIVE_REVIEW_EVERY_MIN: '120' }, async ({ state, owner }) => {
      const armed = () => state.storage.sql.exec<{ due_at: number; recurrence_json: string | null }>('SELECT due_at, recurrence_json FROM schedule WHERE id = ?', INTERVENTION_REVIEW_ID).toArray();
      await tick(state, owner);
      expect(armed()).toEqual([{ due_at: AT + 120 * 60_000, recurrence_json: null }]);
      const night = Date.parse(`${DAY}T22:00:00Z`), tickAt = Date.now;
      Date.now = () => night;
      try {
        state.storage.sql.exec('DELETE FROM task_jobs');
        await tick(state, owner);
        expect(looks(state)).toBe(0);
        expect(armed().map(row => row.due_at)).toEqual([AT + 24 * 3_600_000]);
      } finally { Date.now = tickAt; }
    });
  });

  it('a phone that moved brings the look to now, and the look it starts knows why; off, or for a forged notice, nothing moves', async () => {
    const moved = async (owner: Steps['owner'], name: string, sig?: string) => owner.fetch(new Request('https://telegram-owner/app/v1/internal/place-moved', { method: 'POST', body: '{}',
      headers: { 'content-type': 'application/json', 'x-waldo-do-name': name, 'x-waldo-moved-sig': sig ?? await routerSignature(directory.WALDO_ROUTER_HMAC_SECRET, 0, `placemoved.${name}`) } }));
    const armed = (state: DurableObjectState) => state.storage.sql.exec<{ due_at: number; payload_json: string }>('SELECT due_at, payload_json FROM schedule WHERE id = ?', INTERVENTION_REVIEW_ID).toArray()
      .map(row => ({ due_at: row.due_at, moved: (JSON.parse(row.payload_json) as Record<string, string>).cause_id ?? null }));
    await owned('intervention-moved', { PROACTIVE_GATE: '1', PROACTIVE_INTERVENTIONS: '1', PROACTIVE_REVIEW_EVERY_MIN: '120' }, async ({ state, owner }) => {
      expect(armed(state).map(row => row.moved)).toEqual([null]);
      expect((await moved(owner, 'intervention-moved', 'forged')).status).toBe(403);
      expect(armed(state).map(row => row.moved)).toEqual([null]);
      expect((await moved(owner, 'intervention-moved')).status).toBe(200);
      expect(armed(state)).toEqual([{ due_at: AT, moved: 'place_moved' }]);
      state.storage.kv.put('owner_alarm_last_v1', 1);
      await owner.alarm();
      await state.storage.deleteAlarm();
      const briefs = state.storage.sql.exec<{ brief_json: string }>("SELECT brief_json FROM task_jobs WHERE origin = 'machine:intervention'").toArray();
      expect(briefs.map(row => (JSON.parse(row.brief_json) as { machine: { refs: string[] } }).machine.refs)).toEqual([['now', 'moved']]);
      expect(armed(state)).toEqual([{ due_at: AT + 120 * 60_000, moved: null }]);
      // A city that keeps flipping pulls the look forward once per cadence, no more.
      for (const minutes of [5, 60, 119]) {
        const at = Date.now;
        Date.now = () => AT + minutes * 60_000;
        try { expect((await moved(owner, 'intervention-moved')).status).toBe(200); } finally { Date.now = at; }
        expect(armed(state)).toEqual([{ due_at: AT + 120 * 60_000, moved: null }]);
      }
      const later = Date.now;
      Date.now = () => AT + 121 * 60_000;
      try {
        expect((await moved(owner, 'intervention-moved')).status).toBe(200);
        expect(armed(state)).toEqual([{ due_at: AT + 121 * 60_000, moved: 'place_moved' }]);
      } finally { Date.now = later; }
    });
    await owned('intervention-moved-same-hour', { PROACTIVE_GATE: '1', PROACTIVE_INTERVENTIONS: '1', PROACTIVE_REVIEW_EVERY_MIN: '120' }, async ({ state, owner }) => {
      state.storage.kv.put('owner_alarm_last_v1', 1);
      state.storage.sql.exec('DELETE FROM schedule');
      await new Scheduler(state.storage.sql, state.storage, productionDeps())
        .schedule({ id: INTERVENTION_REVIEW_ID, kind: 'patrol', payloadRefs: { id: INTERVENTION_REVIEW_ID }, occurrenceAt: AT - 1000, dueAt: AT - 1000, recurrence: null });
      await owner.alarm();
      expect(state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM task_jobs WHERE origin = 'machine:intervention'").one().n).toBe(1);
      expect((await moved(owner, 'intervention-moved-same-hour')).status).toBe(200);
      await owner.alarm();
      await state.storage.deleteAlarm();
      expect(state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM task_jobs WHERE origin = 'machine:intervention'").one().n).toBe(1);
      const hour = Date.parse(new Date(AT).toISOString().slice(0, 13) + ':00:00Z') + 3_600_000;
      expect(armed(state)).toEqual([{ due_at: hour, moved: 'place_moved' }]);
    });
    await owned('intervention-moved-off', { PROACTIVE_INTERVENTIONS: '0' }, async ({ state, owner }) => {
      expect((await moved(owner, 'intervention-moved-off')).status).toBe(200);
      expect(armed(state)).toEqual([]);
    });
  });

  it('an arrival at the gym brings the same look to now, knowing where; with ARRIVAL_LOOK off, or for a forged notice, nothing moves', async () => {
    const arrived = async (owner: Steps['owner'], name: string, place: string, sig?: string) => owner.fetch(new Request('https://telegram-owner/app/v1/internal/place-arrived', { method: 'POST', body: JSON.stringify({ place }),
      headers: { 'content-type': 'application/json', 'x-waldo-do-name': name, 'x-waldo-arrived-sig': sig ?? await routerSignature(directory.WALDO_ROUTER_HMAC_SECRET, 0, `placearrived.${place}.${name}`) } }));
    const armed = (state: DurableObjectState) => state.storage.sql.exec<{ due_at: number; payload_json: string }>('SELECT due_at, payload_json FROM schedule WHERE id = ?', INTERVENTION_REVIEW_ID).toArray()
      .map(row => ({ due_at: row.due_at, cause: (JSON.parse(row.payload_json) as Record<string, string>).cause_id ?? null }));
    await owned('intervention-arrived', { PROACTIVE_GATE: '1', PROACTIVE_INTERVENTIONS: '1', PROACTIVE_REVIEW_EVERY_MIN: '120', ARRIVAL_LOOK: '1' }, async ({ state, owner }) => {
      expect((await arrived(owner, 'intervention-arrived', 'gym', 'forged')).status).toBe(403);
      expect((await arrived(owner, 'intervention-arrived', 'office')).status).toBe(403);
      expect(armed(state).map(row => row.cause)).toEqual([null]);
      expect((await arrived(owner, 'intervention-arrived', 'gym')).status).toBe(200);
      expect(armed(state)).toEqual([{ due_at: AT, cause: 'arrived_gym' }]);
      state.storage.kv.put('owner_alarm_last_v1', 1);
      await owner.alarm();
      await state.storage.deleteAlarm();
      const briefs = state.storage.sql.exec<{ brief_json: string }>("SELECT brief_json FROM task_jobs WHERE origin = 'machine:intervention'").toArray();
      expect(briefs.map(row => (JSON.parse(row.brief_json) as { machine: { refs: string[] } }).machine.refs)).toEqual([['now', 'arrived_gym']]);
      expect(armed(state)).toEqual([{ due_at: AT + 120 * 60_000, cause: null }]);
    });
    await owned('intervention-arrived-off', { PROACTIVE_GATE: '1', PROACTIVE_INTERVENTIONS: '1', PROACTIVE_REVIEW_EVERY_MIN: '120' }, async ({ state, owner }) => {
      expect((await arrived(owner, 'intervention-arrived-off', 'home')).status).toBe(200);
      expect(armed(state).map(row => row.cause)).toEqual([null]);
    });
  });

  it('turning the heartbeat off drops the look, and turning it back on arms it again at once', async () => {
    await owned('intervention-heartbeat-toggle', { PROACTIVE_GATE: '1', PROACTIVE_INTERVENTIONS: '1' }, async ({ state, owner }) => {
      const armed = () => state.storage.sql.exec('SELECT 1 FROM schedule WHERE id = ?', INTERVENTION_REVIEW_ID).toArray().length;
      const set = (value: 'on' | 'off') => (owner.setup('app') as unknown as { act(action: Readonly<{ action: 'schedule.set'; id: string; value: string }>): Promise<unknown> }).act({ action: 'schedule.set', id: 'heartbeat', value });
      expect(armed()).toBe(1);
      expect(await set('off')).toEqual(APP_SCHEDULE_RECEIPTS_V1.off);
      expect(armed()).toBe(0);
      expect(await set('on')).toEqual(APP_SCHEDULE_RECEIPTS_V1.on);
      expect(armed()).toBe(1);
    });
  });

  it('with the owner\'s heartbeat off, the look ends at its tick and is not armed again', async () => {
    await owned('intervention-heartbeat-off', { PROACTIVE_GATE: '1', PROACTIVE_INTERVENTIONS: '1' }, async ({ state, owner }) => {
      state.storage.sql.exec('DELETE FROM schedule');
      await armInterventionReview(new Scheduler(state.storage.sql, state.storage, productionDeps()), AT - 1000);
      const sql = state.storage.sql;
      schedulePreferences(sql, loopBook(sql, { newId: () => 'l', now: () => AT })).set('heartbeat', false);
      state.storage.kv.put('owner_alarm_last_v1', 1);
      await owner.alarm();
      await state.storage.deleteAlarm();
      expect(looks(state)).toBe(0);
      expect(sql.exec('SELECT id FROM schedule WHERE id = ?', INTERVENTION_REVIEW_ID).toArray()).toEqual([]);
    });
  });
});

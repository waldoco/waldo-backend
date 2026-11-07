import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { literalTextRedactor, redactConversationEntry, type ConversationEntry, type ConversationHealthChart, type GetHealthArgs, type GetHealthResult, type ToolResult } from '@waldo/contracts';
import { appHistoryResultV1Schema } from '../../contracts/src/app/core';
import type { LLMGatewayRequest } from '../src/llm/provider';
import { appTranscriptPage } from '../src/channels/app-api';
import { drawHealthChart, showChartHandler, showHealthChartHandler, turnChartBook } from '../src/tools/live/show-chart';
import { claimStore } from '../src/memory/claims';
import { ensureSchema } from '../src/tracer/schema';
import { TOOL_RECORDS } from '../src/tools/records';
import type { ToolDispatcherContext } from '../src/tools/dispatcher';

// Synthetic readings only. Each has one decimal and an integer part no ISO time carries, so a stored copy would match.
const NIGHTS = [{ day: '2026-10-11', value: 61.3 }, { day: '2026-10-12', value: 67.4 }, { day: '2026-10-13', value: 71.2 }];
const QUERY = { title: 'Overnight HRV', signal: 'hrv' as const, from: '2026-10-11', to: '2026-10-13', alt_text: 'Overnight HRV rose over the three nights.' };
const STORED: ConversationHealthChart = { title: QUERY.title, alt_text: QUERY.alt_text, health: { signal: 'hrv', from: QUERY.from, to: QUERY.to } };
const available = (days = NIGHTS): ToolResult<GetHealthResult> => ({ ok: true, source_taint: null, data: { state: 'available', timezone: 'UTC', from: QUERY.from, to: QUERY.to, read_at: '2026-10-14T06:00:00.000Z',
  signals: [{ signal: 'hrv', unit: 'ms', source: 'apple', method: 'sdnn', days }], freshness: 'fresh', coverage: 1 } });
const unavailable = (reason: Extract<GetHealthResult, { state: 'unavailable' }>['reason']): ToolResult<GetHealthResult> => ({ ok: true, source_taint: null, data: { state: 'unavailable', reason } });
const PART = { type: 'chart_series', title: QUERY.title, unit: 'ms', series: [{ label: 'hrv', points: NIGHTS.map(night => ({ t: Date.parse(`${night.day}T00:00:00Z`), v: night.value })) }], alt_text: QUERY.alt_text, fallback_text: QUERY.alt_text };
const dataOf = (result: ToolResult<unknown>): unknown => (result.ok ? result.data : result);

describe('show_health_chart', () => {
  const ownerTurn = { trigger: 'user_message', ownerInitiated: true, turnId: 'turn-1', healthShown: true } as ToolDispatcherContext;
  it('keeps the query for the reply, never the readings, and reads only to know there is something to draw', async () => {
    const asked: GetHealthArgs[] = [];
    const book = turnChartBook(), tool = showHealthChartHandler(book, async args => { asked.push(args); return available(); });
    expect(dataOf(await tool.handle(QUERY, ownerTurn))).toEqual({ shown: true, charts_left: 1 });
    expect(asked).toEqual([{ signals: ['hrv'], from: QUERY.from, to: QUERY.to, aggregation: 'daily' }]);
    const kept = book.take('turn-1');
    expect(kept).toEqual([STORED]);
    for (const night of NIGHTS) expect(JSON.stringify(kept)).not.toContain(String(night.value));
    expect(TOOL_RECORDS.show_health_chart).toMatchObject({ claim: null, ownerTurnOnly: true });
  });

  it('shares show_chart\'s limit per reply, and runs only in the owner\'s own chat turn', async () => {
    const book = turnChartBook(), tool = showHealthChartHandler(book, async () => available());
    await showChartHandler(book).handle({ title: 'Runs', unit: 'km', alt_text: 'Runs.', series: [{ label: 'Run', points: [{ t: 1, v: 5 }] }] }, { ...ownerTurn, healthShown: false } as ToolDispatcherContext);
    expect(dataOf(await tool.handle(QUERY, ownerTurn))).toEqual({ shown: true, charts_left: 0 });
    expect(dataOf(await tool.handle(QUERY, ownerTurn))).toEqual({ shown: false, reason: 'limit_reached' });
    for (const ctx of [{ ...ownerTurn, ownerInitiated: false }, { ...ownerTurn, trigger: 'patrol' }, { ...ownerTurn, turnId: undefined }]) expect(dataOf(await tool.handle(QUERY, ctx as ToolDispatcherContext))).toEqual({ shown: false, reason: 'not_owner_turn' });
  });

  it('refuses words that carry a reading, since they are kept with the reply', async () => {
    const book = turnChartBook(), tool = showHealthChartHandler(book, async () => available());
    for (const words of [{ alt_text: 'HRV rose from 61 ms to 71 ms.' }, { title: 'HRV 71 ms' }]) expect(dataOf(await tool.handle({ ...QUERY, ...words }, ownerTurn))).toEqual({ shown: false, reason: 'readings_in_words' });
    expect(book.take('turn-1')).toEqual([]);
  });

  it('draws nothing when the health plane has nothing to draw, and says why so the reply can say it in words', async () => {
    for (const reason of ['consent_withdrawn', 'no_readings', 'read_failed'] as const) {
      const book = turnChartBook();
      expect(dataOf(await showHealthChartHandler(book, async () => unavailable(reason)).handle(QUERY, ownerTurn))).toEqual({ shown: false, reason: 'health_unavailable', health_reason: reason });
      expect(book.take('turn-1')).toEqual([]);
    }
    const empty = turnChartBook();
    expect(dataOf(await showHealthChartHandler(empty, async () => available(NIGHTS.map(night => ({ ...night, value: null })))).handle(QUERY, ownerTurn))).toEqual({ shown: false, reason: 'health_unavailable', health_reason: 'no_readings' });
    const refused = await showHealthChartHandler(turnChartBook(), async () => ({ ok: false, code: 'invalid_args', error: 'to must not be after today (2026-10-13) in the owner\'s time zone' })).handle(QUERY, ownerTurn);
    expect(refused).toMatchObject({ ok: false, code: 'invalid_args' });
  });

  it('draws only the days that have a value, never an invented point', async () => {
    const drawn = await drawHealthChart(STORED, async () => available([NIGHTS[0]!, { day: '2026-10-12', value: null }, NIGHTS[2]!]));
    expect(drawn).toEqual({ part: { ...PART, series: [{ label: 'hrv', points: [PART.series[0]!.points[0], PART.series[0]!.points[2]] }] } });
  });
});

describe('a reply\'s health chart in the app transcript', () => {
  const entry: ConversationEntry = { id: 'm1-reply', ownerId: 'o', chatId: 'app:main', parentId: 'm1', threadAnchorId: null, surface: 'app', role: 'assistant',
    modelPayload: 'Your HRV is climbing.', appPayload: 'Your HRV is climbing.', modelProjection: { mode: 'include' }, charts: [STORED] };
  it('is a chart_series part only with this read\'s live points; without them every build gets its words', () => {
    const live = appTranscriptPage([entry], null, 10, undefined, undefined, undefined, undefined, true, () => PART as never).messages[0]!;
    expect(live.parts).toEqual([{ type: 'text', text: 'Your HRV is climbing.' }, PART]);
    for (const page of [appTranscriptPage([entry], null, 10, undefined, undefined, undefined, undefined, true), appTranscriptPage([entry], null, 10)]) {
      expect(page.messages[0]!.text).toBe(`Your HRV is climbing.\n\n${QUERY.alt_text}`);
      expect(page.messages[0]!.parts.map(part => part.type)).toEqual(['text']);
      expect(appHistoryResultV1Schema.safeParse(page).success).toBe(true);
    }
    expect(appHistoryResultV1Schema.safeParse(appTranscriptPage([entry], null, 10, undefined, undefined, undefined, undefined, true, () => PART as never)).success).toBe(true);
  });

  it('goes whole when a forget touches its words', () => {
    expect(redactConversationEntry(entry, literalTextRedactor(['Overnight HRV'], '[forgotten]')).charts).toEqual([]);
    expect(redactConversationEntry(entry, literalTextRedactor(['marathon'], '[forgotten]')).charts).toEqual([STORED]);
  });
});

// The owner's app turn, with the model scripted: it charts its HRV, then replies. The reply row keeps the query, the
// object's storage never holds a reading, and each app read draws the chart from a live read of the health plane.
const REPLY = 'Synthetic reply marker coral-heron';
const seen = vi.hoisted(() => ({ calls: [] as { name: string; arguments: string }[], consent: 'granted', reads: 0 }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete({ request }: LLMGatewayRequest) {
    const done = (text: string, calls?: { call_id: string; name: string; arguments: string }[]) => ({ ok: true as const, data: { model: request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0, ...(calls ? { tool_calls: calls } : {}) } });
    if (request.response_format) return done(request.response_format.name === 'task_source_scope' ? '{"decision":"retain","sources":[]}' : '{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}');
    const call = seen.calls.shift();
    return call ? done('', [{ call_id: `call-${seen.calls.length}`, ...call }]) : done(REPLY);
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');
const OWNER_ID = '4b3a2918-0f7e-4d6c-9b5a-4c3d2e1f0a9d';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const consentRow = (purpose: string) => ({ consent_class: 'health_processing', source: 'apple', purpose, version: 2, status: seen.consent, epoch: 1, granted_at: '2026-10-01T00:00:00Z', withdrawn_at: seen.consent === 'granted' ? null : '2026-10-20T00:00:00Z', deletion_state: 'not_required' });
const series = { access: 'granted', read_at: '2026-10-14T06:00:00.000Z', sources: [{ source: 'apple', consent_epoch: 1, samples: NIGHTS.map(night => ({
  signal: 'overnight_hrv', day: night.day, start_at: `${night.day}T00:00:00Z`, end_at: `${night.day}T06:00:00Z`, timezone: 'UTC', value: night.value, method: 'sdnn' })) }] };
beforeEach(() => {
  seen.calls = []; seen.consent = 'granted'; seen.reads = 0;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(String(input instanceof Request ? input.url : input))?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'assert_channel_presence') return Response.json(true);
    if (fn === 'health_context_read') return Response.json(null);
    if (fn === 'health_consent_list') return Response.json({ consents: [consentRow('storage_compute'), consentRow('model_processing')] });
    if (fn === 'health_series_read') { seen.reads += 1; return Response.json(series); }
    return new Response('unexpected', { status: 500 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); });
const headers = (name: string) => ({ 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'a'.repeat(64), 'content-type': 'application/json' });
const storedText = (state: DurableObjectState) => {
  const kv = [...state.storage.kv.list()].map(([key, value]) => `${key} ${JSON.stringify(value)}`);
  const tables = state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'").toArray().map(row => row.name);
  return [...kv, ...tables.flatMap(table => state.storage.sql.exec(`SELECT * FROM "${table}"`).toArray().map(row => JSON.stringify(row)))].join('\n');
};

it('an app turn that charts the owner\'s HRV stores the query, and each chat=11 read draws it live; below 11, or once sharing is off, it is words', () => runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('health-chart-turn')), async (_instance, state) => {
  const name = 'health-chart-turn';
  claimStore(state.storage.sql); ensureSchema(state.storage);
  state.storage.kv.put('do_name', name);
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const owner = new OwnerDO(state, { ...env, ...directory, HEALTH_CHARTS: '1', TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined });
  seen.calls = [{ name: 'show_health_chart', arguments: JSON.stringify(QUERY) }];
  try {
    const sent = await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main/messages', { method: 'POST', headers: headers(name), body: JSON.stringify({ client_message_id: 'health-chart-01', text: 'How has my HRV been this week?' }) }));
    const { message_id: id } = await sent.json() as { message_id: string };
    await vi.waitFor(() => expect(state.storage.kv.get<{ state: string }>(`app:inbox-record:${id}`)?.state).toBe('completed'), { timeout: 10_000, interval: 20 });
    const stored = storedText(state);
    expect(stored).toContain(QUERY.alt_text);
    for (const night of NIGHTS) expect(stored).not.toContain(String(night.value));
    const read = async (contract?: string) => appHistoryResultV1Schema.parse(await (await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main', { headers: { ...headers(name), ...(contract ? { 'x-waldo-app-contract': contract } : {}) } }))).json())
      .messages.find(message => message.role === 'assistant')!;
    const before = seen.reads;
    const drawn = await read('chat=11');
    expect(seen.reads).toBe(before + 1);
    expect(drawn.text).toBe(REPLY);
    expect(drawn.parts.filter(part => part.type === 'chart_series')).toEqual([PART]);
    for (const contract of [undefined, 'chat=8']) {
      const words = await read(contract);
      expect(words.text).toBe(`${REPLY}\n\n${QUERY.alt_text}`);
      expect(words.parts.some(part => part.type === 'chart_series')).toBe(false);
    }
    seen.consent = 'withdrawn';
    const withdrawn = await read('chat=11');
    expect(withdrawn.text).toBe(`${REPLY}\n\n${QUERY.alt_text}`);
    expect(withdrawn.parts.some(part => part.type === 'chart_series')).toBe(false);
    for (const night of NIGHTS) expect(storedText(state)).not.toContain(String(night.value));
  } finally { quiet.mockRestore(); await state.storage.deleteAlarm(); }
}));

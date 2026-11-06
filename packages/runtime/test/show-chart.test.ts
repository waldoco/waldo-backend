import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { literalTextRedactor, redactConversationEntry, SHOW_CHART_MAX_PER_TURN, type ConversationChart, type ConversationEntry } from '@waldo/contracts';
import { appHistoryResultV1Schema } from '../../contracts/src/app/core';
import type { LLMGatewayRequest } from '../src/llm/provider';
import { appTranscriptPage } from '../src/channels/app-api';
import { showChartHandler, turnChartBook } from '../src/tools/live/show-chart';
import { claimStore } from '../src/memory/claims';
import { ensureSchema } from '../src/tracer/schema';
import { TOOL_RECORDS } from '../src/tools/records';
import type { ToolDispatcherContext } from '../src/tools/dispatcher';

const CHART: ConversationChart = { title: 'Long runs this block', unit: 'km', alt_text: 'Long runs rose from 12 km to 16 km over three weeks.', series: [{ label: 'Long run', points: [{ t: 1, v: 12 }, { t: 2, v: 14 }, { t: 3, v: 16 }] }] };

describe('show_chart', () => {
  const ownerTurn = { trigger: 'user_message', ownerInitiated: true, turnId: 'turn-1' } as ToolDispatcherContext;
  it('queues a chart for the owner turn\'s reply, up to its limit, and nowhere else', async () => {
    const book = turnChartBook(), tool = showChartHandler(book);
    expect(await tool.handle(CHART, ownerTurn)).toEqual({ ok: true, data: { shown: true, charts_left: SHOW_CHART_MAX_PER_TURN - 1 }, source_taint: null });
    expect(await tool.handle(CHART, ownerTurn)).toEqual({ ok: true, data: { shown: true, charts_left: 0 }, source_taint: null });
    expect(await tool.handle(CHART, ownerTurn)).toEqual({ ok: true, data: { shown: false, reason: 'limit_reached' }, source_taint: null });
    for (const ctx of [{ ...ownerTurn, ownerInitiated: false }, { ...ownerTurn, trigger: 'patrol' }, { ...ownerTurn, turnId: undefined }]) expect((await tool.handle(CHART, ctx as ToolDispatcherContext)).data).toEqual({ shown: false, reason: 'not_owner_turn' });
    expect(book.take('turn-1')).toEqual([CHART, CHART]);
    expect(book.take('turn-1')).toEqual([]);
    book.queue('turn-2', CHART); book.clear('turn-2');
    expect(book.take('turn-2')).toEqual([]);
    expect(TOOL_RECORDS.show_chart).toMatchObject({ claim: null, ownerTurnOnly: true });
  });
});

describe('a reply\'s chart in the app transcript', () => {
  const entry: ConversationEntry = { id: 'm1-reply', ownerId: 'o', chatId: 'app:main', parentId: 'm1', threadAnchorId: null, surface: 'app', role: 'assistant',
    modelPayload: 'Your long runs are building well.', appPayload: 'Your long runs are building well.\n\nDid: 1 thing', modelProjection: { mode: 'include' }, charts: [CHART],
    receipt: { line: 'Did: 1 thing', items: [{ kind: 'reminder_set', target: null, outcome: 'accepted', via_task: false, at: 1_760_000_000_000, digest: null }], more: 0 } };
  it('is a chart_series part, before the receipt, for chat=8, and its alt text before the receipt line for an older build', () => {
    const drawn = appTranscriptPage([entry], null, 10, undefined, undefined, undefined, undefined, true).messages[0]!;
    expect(drawn.text).toBe('Your long runs are building well.\n\nDid: 1 thing');
    expect(drawn.parts.map(part => part.type)).toEqual(['text', 'chart_series', 'receipt']);
    expect(drawn.parts[1]).toEqual({ type: 'chart_series', ...CHART, fallback_text: CHART.alt_text });
    const older = appTranscriptPage([entry], null, 10).messages[0]!;
    expect(older.text).toBe(`Your long runs are building well.\n\n${CHART.alt_text}\n\nDid: 1 thing`);
    expect(older.parts.map(part => part.type)).toEqual(['text', 'receipt']);
    for (const page of [appTranscriptPage([entry], null, 10, undefined, undefined, undefined, undefined, true), appTranscriptPage([entry], null, 10)]) expect(appHistoryResultV1Schema.safeParse(page).success).toBe(true);
  });
  it('is forgotten with the reply: every text in it goes through the forget, and its points stay numbers', () => {
    const redacted = redactConversationEntry(entry, text => `<${text}>`).charts![0]!;
    expect(redacted).toEqual({ title: `<${CHART.title}>`, unit: '<km>', alt_text: `<${CHART.alt_text}>`, series: [{ label: '<Long run>', points: CHART.series[0]!.points }] });
    const forgotten = redactConversationEntry(entry, literalTextRedactor(['Long run'], '[forgotten]')).charts![0]!;
    expect(forgotten.series[0]!.label).toBe('[forgotten]');
  });
});

// The owner's app turn, with the model scripted: it draws a chart, then replies. The reply row keeps the chart, and the app reads it back.
const REPLY = 'Synthetic reply marker amber-falcon';
const seen = vi.hoisted(() => ({ calls: [] as { name: string; arguments: string }[] }));
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
const OWNER_ID = '4b3a2918-0f7e-4d6c-9b5a-4c3d2e1f0a9c';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
beforeEach(() => {
  seen.calls = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(String(input instanceof Request ? input.url : input))?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'assert_channel_presence') return Response.json(true);
    if (fn === 'health_context_read') return Response.json(null);
    return new Response('unexpected', { status: 500 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); });
const headers = (name: string) => ({ 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'a'.repeat(64), 'content-type': 'application/json' });

it('an app turn that draws a chart keeps it with the reply: drawn for chat=8, told in words below it', () => runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('show-chart-turn')), async (_instance, state) => {
  const name = 'show-chart-turn';
  claimStore(state.storage.sql); ensureSchema(state.storage);
  state.storage.kv.put('do_name', name);
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const owner = new OwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined });
  seen.calls = [{ name: 'show_chart', arguments: JSON.stringify(CHART) }];
  try {
    const sent = await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main/messages', { method: 'POST', headers: headers(name), body: JSON.stringify({ client_message_id: 'chart-client-01', text: 'How are my long runs going?' }) }));
    const { message_id: id } = await sent.json() as { message_id: string };
    await vi.waitFor(() => expect(state.storage.kv.get<{ state: string }>(`app:inbox-record:${id}`)?.state).toBe('completed'), { timeout: 10_000, interval: 20 });
    const read = async (contract?: string) => appHistoryResultV1Schema.parse(await (await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main', { headers: { ...headers(name), ...(contract ? { 'x-waldo-app-contract': contract } : {}) } }))).json())
      .messages.find(message => message.role === 'assistant')!;
    const drawn = await read('chat=8');
    expect(drawn.text).toBe(REPLY);
    expect(drawn.parts.filter(part => part.type === 'chart_series')).toEqual([{ type: 'chart_series', ...CHART, fallback_text: CHART.alt_text }]);
    for (const contract of [undefined, 'chat=7']) {
      const older = await read(contract);
      expect(older.text).toBe(`${REPLY}\n\n${CHART.alt_text}`);
      expect(older.parts.some(part => part.type === 'chart_series')).toBe(false);
    }
  } finally { quiet.mockRestore(); await state.storage.deleteAlarm(); }
}));

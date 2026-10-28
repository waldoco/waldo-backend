import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LLMGatewayAdapter } from '../src/llm/provider';
import { appSubjectFor } from '../src/channels/app-api';
import { dayPlanBook } from '../src/channels/day-cards';
import { traceBook } from '../src/channels/harness';
import { claimStore } from '../src/memory/claims';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';
import { ensureSchema } from '../src/tracer/schema';

// A Like on a day card the app shows scores the trace of the job that wrote the card, as a Like on a reply scores its turn.
const CARD = 'Synthetic card marker amber-wren';
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway: LLMGatewayAdapter = { async complete(request) {
    const content = request.request.messages.at(-1)?.content ?? '';
    const text = String(content).includes('[Scheduled card') ? CARD : 'SKIP';
    return { ok: true, data: { model: request.request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f';
const AT = Date.parse('2026-10-03T09:00:00Z');
const HASH = 'a'.repeat(64);
const LANGFUSE = { LANGFUSE_PUBLIC_KEY: 'pk-lf-synthetic', LANGFUSE_SECRET_KEY: 'sk-lf-synthetic', LANGFUSE_BASE_URL: 'https://langfuse.test', WALDO_ENVIRONMENT: 'staging' };
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const langfuse = vi.hoisted(() => ({ calls: [] as { method: string; path: string; body: unknown }[] }));

beforeEach(() => {
  langfuse.calls = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.origin === 'https://langfuse.test') {
      langfuse.calls.push({ method: init?.method ?? 'GET', path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : null });
      return url.pathname === '/api/public/scores' ? Response.json({ accepted: 1 }, { status: 202 }) : Response.json({});
    }
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url.href)?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    if (fn === 'health_log_recent') return Response.json([]);
    if (fn === 'health_context_read') return Response.json(null);
    if (fn === 'assert_channel_presence') return Response.json(false);
    return Response.json(true);
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

type Owner = Readonly<{ setup(channel: string): { ready: Promise<unknown> }; fetch(request: Request): Promise<Response>; alarm(): Promise<void> }>;
type Span = { traceId: string; parentSpanId?: string; attributes: { key: string; value: { stringValue?: string } }[] };
const spans = () => langfuse.calls.filter(call => call.path === '/api/public/otel/v1/traces')
  .flatMap(call => (call.body as { resourceSpans: { scopeSpans: { spans: Span[] }[] }[] }).resourceSpans.flatMap(r => r.scopeSpans.flatMap(s => s.spans)));
const scoreCalls = () => langfuse.calls.filter(call => call.path.startsWith('/api/public/scores'));
const headers = (name: string) => ({ 'x-waldo-do-name': name, 'x-waldo-app-session-hash': HASH, 'content-type': 'application/json' });

// An app-only owner with Langfuse on; the Brief fires once through the real alarm and lands in Main chat.
const briefDelivered = async (name: string, check: (owner: Owner, cardRow: string) => Promise<void>) => {
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
      const owner = new OwnerDO(state, { ...env, ...directory, ...LANGFUSE, TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture',
        WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined }) as unknown as Owner;
      await owner.setup('app').ready;
      state.storage.sql.exec('DELETE FROM schedule');
      dayPlanBook(state.storage.sql).save('2026-10-03', { card: 'card:brief', time: '00:00', reason: 'planned' });
      await new Scheduler(state.storage.sql, state.storage, productionDeps())
        .schedule({ id: 'card:brief', kind: 'brief', payloadRefs: { id: 'card:brief' }, occurrenceAt: AT - 1000, dueAt: AT - 1000, recurrence: null });
      state.storage.kv.put('owner_alarm_last_v1', 1);
      await owner.alarm();
      const chat = await (await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main', { headers: headers(name) }))).json() as { messages: { id: string; text: string }[] };
      const row = chat.messages.find(message => message.text === CARD)!;
      expect(row.id).toMatch(/^scheduled-/);
      await check(owner, row.id);
    } finally { Date.now = originalNow; quiet.mockRestore(); await state.storage.deleteAlarm(); }
  });
};

it('scores a Like on a delivered Brief on the trace of the job that wrote it', async () => {
  await briefDelivered('rating-linked-brief', async (owner, cardRow) => {
    const key = `card:brief:${AT - 1000}`;
    await vi.waitFor(() => expect(spans().some(span => !span.parentSpanId && span.attributes.some(a => a.value.stringValue === key))).toBe(true));
    const traceId = spans().find(span => !span.parentSpanId && span.attributes.some(a => a.value.stringValue === key))!.traceId;
    const rated = await owner.fetch(new Request(`https://telegram-owner/app/v1/chat/main/messages/${cardRow}/rating`, { method: 'PUT', headers: headers('rating-linked-brief'),
      body: JSON.stringify({ request_id: 'rating-req-0001', rating: 'up' }) }));
    expect(rated.status).toBe(200);
    await vi.waitFor(() => expect(scoreCalls()).toHaveLength(1));
    expect(scoreCalls()[0]).toEqual({ method: 'POST', path: '/api/public/scores', body: [{ id: expect.stringMatching(/^[0-9a-f-]{36}$/), traceId, name: 'reply_rating', value: 1,
      dataType: 'BOOLEAN', environment: 'staging', metadata: { source: 'app' } }] });
    expect(JSON.stringify(scoreCalls())).not.toMatch(/amber-wren|rating-linked-brief/);
  });
});

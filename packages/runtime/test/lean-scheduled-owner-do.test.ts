import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LLMRequest } from '@waldo/contracts';
import type { LLMGatewayAdapter } from '../src/llm/provider';
import { appSubjectFor } from '../src/channels/app-api';
import { dayPlanBook } from '../src/channels/day-cards';
import { traceBook } from '../src/channels/harness';
import { claimStore } from '../src/memory/claims';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';
import { ensureSchema } from '../src/tracer/schema';

// WALDO_LEAN_SCHEDULED through the owner object: the switch read from env, the day card's call site marking its run
// Waldo-first, and the surface responder carrying the mark down to the job's own responder. The model is the only fake.
const seen = vi.hoisted(() => ({ requests: [] as LLMRequest[] }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway: LLMGatewayAdapter = { async complete({ request }) {
    seen.requests.push(request);
    const text = request.response_format?.name === 'day_plan' ? '{"cards":[]}' : request.response_format ? '{}' : 'SKIP';
    return { ok: true, data: { model: request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '3a4b5c6d-7e8f-4a0b-8c1d-2e3f4a5b6c7e';
const AT = Date.parse('2026-11-16T07:00:00Z');
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
beforeEach(() => {
  seen.requests.length = 0;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    if (fn === 'app_push_targets') return Response.json([]);
    if (fn === 'health_log_recent') return Response.json([]);
    if (fn === 'health_context_read') return Response.json(null);
    if (fn === 'assert_channel_presence') return Response.json(true);
    if (url.startsWith('https://api.telegram.org/')) return Response.json({ ok: true, result: { message_id: 1, chat: { id: 7 } } });
    return Response.json(true);
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

type Owner = Readonly<{ setup(channel: string): { ready: Promise<unknown> }; alarm(): Promise<void> }>;
const briefRequest = async (switched: '0' | '1') => {
  const name = `lean-brief-${switched}-${crypto.randomUUID()}`;
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const originalNow = Date.now;
    Date.now = () => AT;
    try {
      claimStore(state.storage.sql); ensureSchema(state.storage); traceBook(state.storage.sql);
      state.storage.kv.put('do_name', name);
      state.storage.kv.put('app_subject', String(appSubjectFor(name)));
      state.storage.kv.put('timezone', 'UTC');
      state.storage.kv.put('timezone_confirmed', true);
      const owner = new OwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC',
        WALDO_OWNER_TELEGRAM_ID: undefined, WALDO_LEAN_SCHEDULED: switched }) as unknown as Owner;
      await owner.setup('app').ready;
      state.storage.sql.exec('DELETE FROM schedule');
      dayPlanBook(state.storage.sql).save('2026-11-16', { card: 'card:brief', time: '00:00', reason: 'planned' });
      await new Scheduler(state.storage.sql, state.storage, productionDeps())
        .schedule({ id: 'card:brief', kind: 'brief', payloadRefs: { id: 'card:brief' }, occurrenceAt: AT - 1000, dueAt: AT - 1000, recurrence: null });
      state.storage.kv.put('owner_alarm_last_v1', 1);
      await owner.alarm();
    } finally { Date.now = originalNow; await state.storage.deleteAlarm(); }
  });
  return seen.requests.find(request => !request.response_format && String(request.messages.at(-1)?.content).includes('[Scheduled card'));
};

it('with the switch on, the owner object runs its Brief as a lean scheduled run', async () => {
  const request = await briefRequest('1');
  expect(request).toBeDefined();
  expect(request!.cache_profile).toBe('scheduled');
  expect(request!.messages).toHaveLength(1);
});

it('with the switch off, the Brief is built as before', async () => {
  const request = await briefRequest('0');
  expect(request).toBeDefined();
  expect(request!.cache_profile).toBeUndefined();
});

// WALDO_PROMPT_V2 through the real owner object: an app turn's model request carries version 2 of the behavior prompt only
// while the switch is "1", and the Worker config keeps it off until a judged run covers its scenarios. The model is
// scripted, so this proves the switch reaches the request, not what a live model does with the text.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LLMRequest } from '@waldo/contracts';
import config from '../wrangler.jsonc?raw';
import { parseJsonc } from '../../../scripts/jsonc.mjs';
import { appSubjectFor } from '../src/channels/app-api';
import type { LLMGatewayAdapter, LLMGatewayRequest } from '../src/llm/provider';
import { claimStore } from '../src/memory/claims';
import { ensureSchema } from '../src/tracer/schema';

const model = vi.hoisted(() => ({ requests: [] as LLMRequest[] }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway: LLMGatewayAdapter = { async complete({ request }: LLMGatewayRequest) {
    const done = (text: string) => ({ ok: true as const, data: { model: request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } });
    if (request.response_format) return done(request.response_format.name === 'task_source_scope' ? '{"decision":"retain","sources":[]}' : '{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}');
    if (request.tools?.length) model.requests.push(request);
    return done('Noted.');
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '3f8a1c52-7d4e-4b19-a6c0-9e2d5b7f1a84';
const PARSED = parseJsonc(config) as { vars: Record<string, string>; env: { staging: { vars: Record<string, string> } } };
const V2_SECTION = '\nBeing ahead of them\n';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); model.requests = []; });

const ownerTurn = async (name: string, promptV2: string): Promise<LLMRequest[]> => {
  vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2030-11-04T09:00:00Z') });
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(String(input instanceof Request ? input.url : input))?.[1];
    const args = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: args.p_do_name, session_hash: args.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: args.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'assert_channel_presence') return Response.json(true);
    if (fn === 'health_context_read') return Response.json(null);
    return new Response('unexpected', { status: 500 });
  });
  return runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    claimStore(state.storage.sql);
    ensureSchema(state.storage);
    state.storage.kv.put('do_name', name);
    state.storage.kv.put('app_subject', String(appSubjectFor(name)));
    await state.storage.put('origin', 'https://fixture.invalid');
    const owner = new OwnerDO(state, { ...env, SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret',
      OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined, WALDO_PROMPT_V2: promptV2 });
    try {
      const sent = await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main/messages', { method: 'POST', headers: { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'a'.repeat(64), 'content-type': 'application/json' }, body: JSON.stringify({ client_message_id: `client-${name}`, text: 'what should I do this afternoon' }) }));
      expect(sent.status).toBe(202);
      const { message_id: message } = await sent.json() as { message_id: string };
      await vi.waitFor(() => expect(state.storage.kv.get<{ state: string }>(`app:inbox-record:${message}`)?.state).toBe('completed'), { timeout: 10_000, interval: 20 });
      return [...model.requests];
    } finally { await state.storage.deleteAlarm(); }
  });
};

describe('WALDO_PROMPT_V2 on the owner object', () => {
  it.each([['1', true], ['0', false], [undefined, false]] as const)('switch %s: the app turn carries version 2: %s', async (value, expected) => {
    const requests = await ownerTurn(`prompt-v2-${value ?? 'unset'}`, value as string);
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) expect(request.system?.includes(V2_SECTION)).toBe(expected);
  });

  it('is off in production and staging until a judged run covers its scenarios', () => {
    expect(PARSED.vars.WALDO_PROMPT_V2).toBe('0');
    expect(PARSED.env.staging.vars.WALDO_PROMPT_V2).toBe('0');
  });
});

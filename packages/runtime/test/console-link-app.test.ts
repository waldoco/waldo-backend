import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appSubjectFor } from '../src/channels/app-api';
import type { AppInboxRecord } from '../src/channels/app-inbox';
import { claimStore } from '../src/memory/claims';
import { ensureSchema } from '../src/tracer/schema';
import type { LLMGatewayRequest } from '../src/llm/provider';

// The app has no in-app route for the console link yet (app.v1 is additive-only and the app lane is paused), so an app
// turn that asks for it learns why it was not sent and nothing is minted.
const model = vi.hoisted(() => ({ requests: [] as string[] }));
vi.mock('../src/channels/owner-turn', async load => {
  const original = await load<typeof import('../src/channels/owner-turn')>();
  const gateway = { async complete({ request }: LLMGatewayRequest) {
    if (request.response_format) return { ok: true as const, data: { model: request.model, text: '{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
    model.requests.push(JSON.stringify(request));
    const call = !request.tool_turns?.length && JSON.stringify(request.messages.at(-1)).includes('console link');
    return { ok: true as const, data: { model: request.model, text: call ? '' : 'The app cannot show it yet.', ...(call ? { tool_calls: [{ call_id: 'console', name: 'send_console_link', arguments: '{}' }] } : {}), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createOwnerResponder: (...args: Parameters<typeof original.createOwnerResponder>) => { args[10] = gateway; return original.createOwnerResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '6e2d9b13-4a7c-4f05-8b26-1c3d5e7f9a20';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };

beforeEach(() => {
  model.requests = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(String(input instanceof Request ? input.url : input))?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'health_context_read') return Response.json(null);
    return new Response('unexpected', { status: 500 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

it('an app turn that asks for the console link gets app_unsupported, and nothing is minted or sent', async () => {
  const name = 'console-link-app-owner';
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    claimStore(state.storage.sql);
    ensureSchema(state.storage);
    state.storage.kv.put('do_name', name);
    state.storage.kv.put('app_subject', String(appSubjectFor(name)));
    state.storage.kv.put('origin', 'https://waldo.fixture.invalid');
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const owner = new OwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined });
    try {
      const sent = await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main/messages', { method: 'POST',
        headers: { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'a'.repeat(64), 'content-type': 'application/json' },
        body: JSON.stringify({ client_message_id: 'console-client-01', text: 'Send me my console link please' }) }));
      expect(sent.status).toBe(202);
      const { message_id: id } = await sent.json() as { message_id: string };
      await vi.waitFor(() => expect(state.storage.kv.get<AppInboxRecord>(`app:inbox-record:${id}`)?.state).toBe('completed'), { timeout: 10_000, interval: 20 });
      const prompts = model.requests.join('\n').replaceAll('\\"', '"');
      expect(prompts).toContain('send_console_link');
      expect(prompts).toContain('"sent":false,"reason":"app_unsupported"');
      expect(state.storage.kv.get('console:link')).toBeUndefined();
      expect(state.storage.sql.exec("SELECT ok, note FROM trace_log WHERE hop = 'console_link'").toArray()).toEqual([{ ok: 0, note: 'app' }]);
    } finally { quiet.mockRestore(); await state.storage.deleteAlarm(); }
  });
});

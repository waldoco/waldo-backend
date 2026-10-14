import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { appSubjectFor } from '../src/channels/app-api';
import { gmailPushBook } from '../src/channels/gmail-push';
import type { LLMGatewayAdapter, LLMGatewayRequest } from '../src/llm/provider';
import { claimStore } from '../src/memory/claims';
import { ensureSchema } from '../src/tracer/schema';

// A Gmail watch that is not running reaches the owner's own turn as a host fact, built from the watch book, so the model
// can explain it in plain words and offer the console. Once the watch runs, the fact is gone.
const MAIL = ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.compose'];
const OWNER_ID = '6c2e9b14-3a7d-4f05-9e81-2b4c6d8f0a13';
const BASE = 'https://directory.fixture.invalid';
const FACT = 'New emails are not pushed to Waldo';
const ASKED = 'did my new email come in?';

const model = vi.hoisted(() => ({ requests: [] as LLMGatewayRequest['request'][] }));
vi.mock('../src/channels/owner-turn', async load => {
  const original = await load<typeof import('../src/channels/owner-turn')>();
  const gateway: LLMGatewayAdapter = { async complete(request) {
    model.requests.push(request.request);
    const writer = request.request.response_format !== undefined;
    const text = request.request.response_format?.name === 'task_source_scope' ? '{"decision":"retain","sources":[]}' : writer ? '{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}' : 'Noted.';
    return { ok: true, data: { model: request.request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createOwnerResponder: (...args: Parameters<typeof original.createOwnerResponder>) => { args[10] = gateway; return original.createOwnerResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); model.requests = []; });

it('an owner turn carries the host fact while the Gmail watch is not running, and not once it runs', async () => {
  // Far in the future, so no wake the owner object arms fires on its own during the test.
  vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2030-11-04T09:00:00Z') });
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
    const args = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: args.p_do_name, session_hash: args.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: args.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'assert_channel_presence') return Response.json(true);
    if (fn === 'health_context_read') return Response.json(null);
    return new Response('unexpected', { status: 500 });
  });
  const name = 'watch-status-app';
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    claimStore(state.storage.sql);
    ensureSchema(state.storage);
    state.storage.kv.put('do_name', name);
    state.storage.kv.put('app_subject', String(appSubjectFor(name)));
    await state.storage.put('origin', 'https://fixture.invalid');
    await state.storage.put('google:accounts', [{ id: 'conn-1', email: 'owner@example.test', scopes: MAIL }]);
    gmailPushBook(state.storage.kv).fail(Date.now());
    const owner = new OwnerDO(state, { ...env, SUPABASE_PROJECT_URL: BASE, SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret', OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined });
    const turn = async (id: string) => {
      const sent = await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main/messages', { method: 'POST', headers: { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'a'.repeat(64), 'content-type': 'application/json' }, body: JSON.stringify({ client_message_id: id, text: ASKED }) }));
      expect(sent.status).toBe(202);
      const { message_id: message } = await sent.json() as { message_id: string };
      await vi.waitFor(() => expect(state.storage.kv.get<{ state: string }>(`app:inbox-record:${message}`)?.state).toBe('completed'), { timeout: 10_000, interval: 20 });
      const replies = model.requests.filter(request => request.response_format === undefined && JSON.stringify(request.messages.at(-1)?.content ?? '').includes(ASKED));
      model.requests = [];
      expect(replies.length, 'the owner turn reached the model').toBeGreaterThan(0);
      return replies.map(request => request.system ?? '');
    };
    try {
      for (const system of await turn('client-watch-missed')) {
        expect(system.split(FACT).length - 1, 'the fact appears once').toBe(1);
        expect(system).toContain('send_console_link');
        expect(system).not.toContain('owner@example.test');
      }
      // An older account first in the list keeps the mail route: the fact names it, since reconnecting another would not help.
      await state.storage.put('google:accounts', [{ id: 'local:old@example.test', email: 'old@example.test', refresh_token: 'synthetic-offline-only', scopes: MAIL }, { id: 'conn-1', email: 'owner@example.test', scopes: MAIL }]);
      gmailPushBook(state.storage.kv).fail(Date.now(), 'local_rail');
      for (const system of await turn('client-watch-older')) {
        expect(system).toContain('the mail account "old@example.test" is connected the older way');
        expect(system).not.toContain('owner@example.test');
      }
      gmailPushBook(state.storage.kv).record({ historyId: '555', expiration: Date.now() + 7 * 86_400_000 }, 'conn-1', Date.now());
      for (const system of await turn('client-watch-running')) expect(system).not.toContain(FACT);
    } finally { await state.storage.deleteAlarm(); }
  });
});

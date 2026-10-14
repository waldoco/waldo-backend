import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LLMGatewayRequest } from '../src/llm/provider';
import { claimStore } from '../src/memory/claims';
import { ensureSchema } from '../src/tracer/schema';

// A contacts search through the owner object: the model sees the match in the asking turn, and no console line or
// stored trace row holds the person's name or address, whether the search succeeds or the grant lacks the scope.
// Synthetic person only.
const NAME = 'Meera Rao';
const ADDRESS = 'meera.rao@family.example';
const AUTH = 'https://www.googleapis.com/auth/';
const model = vi.hoisted(() => ({ requests: [] as LLMGatewayRequest['request'][] }));
vi.mock('../src/channels/owner-turn', async load => {
  const original = await load<typeof import('../src/channels/owner-turn')>();
  const gateway = { async complete({ request }: LLMGatewayRequest) {
    model.requests.push(request);
    const done = (text: string, tool_calls?: Array<{ call_id: string; name: string; arguments: string }>) => ({ ok: true as const, data: { model: request.model, text, ...(tool_calls ? { tool_calls } : {}), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 1 } });
    if (request.response_format) return done(request.response_format.name === 'task_source_scope' ? '{"decision":"retain","sources":[]}' : '{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[]}');
    const asked = String(request.messages.at(-1)?.content ?? '');
    if (asked.includes('email Meera') && !request.tool_turns?.length) return done('', [{ call_id: 'who', name: 'search_contacts', arguments: JSON.stringify({ query: 'Meera' }) }]);
    return done('Noted.');
  } };
  return { ...original, createOwnerResponder: (...args: Parameters<typeof original.createOwnerResponder>) => { args[10] = gateway; return original.createOwnerResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '6c5b4a39-1f8e-4d7c-8b6a-5d4e3f2a1b0c';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const proxied: string[] = [];
beforeEach(() => {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (url === `${directory.SUPABASE_PROJECT_URL}/functions/v1/connector-proxy`) {
      proxied.push(String(asked.method));
      return asked.method === 'searchContacts' ? Response.json({ data: [{ name: NAME, emails: [ADDRESS], source: 'contacts' }] }) : Response.json({ error: { status: 404, message: 'unknown operation' } }, { status: 404 });
    }
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'assert_channel_presence') return Response.json(true);
    if (fn === 'health_context_read') return Response.json(null);
    if (fn === 'health_consent_list') return Response.json({ consents: [] });
    return new Response('unexpected', { status: 500 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); model.requests = []; proxied.length = 0; });

const headers = (name: string) => ({ 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'a'.repeat(64), 'content-type': 'application/json' });
const turn = async (name: string, scopes: readonly string[]) => runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
  claimStore(state.storage.sql); ensureSchema(state.storage);
  state.storage.kv.put('do_name', name);
  state.storage.kv.put('origin', 'https://worker.fixture.invalid');
  state.storage.kv.put('google:accounts', [{ id: 'connection-contacts', email: 'owner@example.com', scopes }]);
  const printed: string[] = [];
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => vi.spyOn(console, level).mockImplementation((...parts: unknown[]) => { printed.push(parts.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' ')); }));
  const owner = new OwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined, GOOGLE_CLIENT_ID: 'synthetic-client', GOOGLE_CLIENT_SECRET: 'synthetic-secret' });
  try {
    const sent = await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main/messages', { method: 'POST', headers: headers(name), body: JSON.stringify({ client_message_id: `${name}-01`, text: 'QA: email Meera that the room moved' }) }));
    const { message_id: id } = await sent.json() as { message_id: string };
    await vi.waitFor(() => expect(state.storage.kv.get<{ state: string }>(`app:inbox-record:${id}`)?.state).toBe('completed'), { timeout: 10_000, interval: 20 });
    const traces = state.storage.sql.exec('SELECT * FROM trace_log').toArray().map((row) => JSON.stringify(row)).join('\n');
    const toolOutput = model.requests.filter((request) => request.response_format === undefined).flatMap((request) => request.tool_turns ?? []).find((entry) => entry.call.name === 'search_contacts')?.output ?? '';
    return { printed: printed.join('\n'), traces, toolOutput };
  } finally { spies.forEach((spy) => spy.mockRestore()); await state.storage.deleteAlarm(); }
});

it('a found contact reaches the asking turn and no console line or trace row', async () => {
  const run = await turn('app-contacts-found', [`${AUTH}contacts.readonly`, `${AUTH}contacts.other.readonly`]);
  expect(proxied).toContain('searchContacts');
  expect(run.toolOutput).toContain(ADDRESS);
  expect(run.traces).toContain('search_contacts');
  for (const text of [run.printed, run.traces]) { expect(text).not.toContain(NAME); expect(text).not.toContain(ADDRESS); }
});

it('a grant without the contact scopes gets the connect offer, reads nothing, and logs no contact', async () => {
  const run = await turn('app-contacts-missing-scope', [`${AUTH}calendar.events`]);
  expect(proxied).not.toContain('searchContacts');
  expect(run.toolOutput).toMatch(/auth_failed/);
  for (const text of [run.printed, run.traces, run.toolOutput]) { expect(text).not.toContain(NAME); expect(text).not.toContain(ADDRESS); }
});

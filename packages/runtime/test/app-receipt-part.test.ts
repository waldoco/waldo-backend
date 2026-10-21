import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appHistoryResultV1Schema } from '../../contracts/src/app/core';
import type { LLMGatewayRequest } from '../src/llm/provider';
import { claimStore } from '../src/memory/claims';
import { sha256Hex, stableJson } from '../src/context-composer/canonical';
import { ensureSchema } from '../src/tracer/schema';

// An app reply carries the turn's effect receipts as a typed part, and its text still ends with the receipt line: a build
// without the part shows the line in the text, a build with the part hides that exact line.
const QUIET = { quiet_start: '21:00', quiet_end: '07:00', volume: 'normal' };
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete({ request }: LLMGatewayRequest) {
    const done = (text: string, tool_calls?: Array<{ call_id: string; name: string; arguments: string }>) => ({ ok: true as const, data: { model: request.model, text, ...(tool_calls ? { tool_calls } : {}), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } });
    if (request.response_format) return done(request.response_format.name === 'task_source_scope' ? '{"decision":"retain","sources":[]}' : '{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}');
    const asked = String(request.messages.at(-1)?.content ?? '');
    if (asked.includes('quiet hours') && !request.tool_turns?.length) return done('', [{ call_id: 'quiet', name: 'set_proactivity', arguments: JSON.stringify(QUIET) }]);
    return done('Done.');
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '4b3a2918-0f7e-4d6c-9b5a-4c3d2e1f0a9b';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
beforeEach(() => {
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
const replyTo = async (name: string, text: string) => runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
  claimStore(state.storage.sql); ensureSchema(state.storage);
  state.storage.kv.put('do_name', name);
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const owner = new OwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined });
  try {
    const sent = await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main/messages', { method: 'POST', headers: headers(name), body: JSON.stringify({ client_message_id: 'receipt-client-01', text }) }));
    const { message_id: id } = await sent.json() as { message_id: string };
    await vi.waitFor(() => expect(state.storage.kv.get<{ state: string }>(`app:inbox-record:${id}`)?.state).toBe('completed'), { timeout: 10_000, interval: 20 });
    const page = appHistoryResultV1Schema.parse(await (await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main', { headers: headers(name) }))).json());
    return page.messages.find(message => message.role === 'assistant')!;
  } finally { quiet.mockRestore(); await state.storage.deleteAlarm(); }
});

it('an effect turn\'s reply carries a receipt part, and its text still ends with the same receipt line', async () => {
  const before = Date.now();
  const reply = await replyTo('app-receipt-effect', 'please set quiet hours');
  expect(reply.text).toBe('Done.\n\nDone: proactivity set');
  expect(reply.parts).toEqual([{ type: 'text', text: 'Done.\n\nDone: proactivity set' }, {
    type: 'receipt', more: 0, fallback_text: 'Done: proactivity set',
    items: [{ kind: 'proactivity_set', target: null, outcome: 'accepted', via_task: false, at: expect.any(Number), digest: `sha256:${await sha256Hex(stableJson(QUIET))}` }],
  }]);
  // A build that predates the receipt part drops it and shows `text`: the line is still there, byte for byte the part's fallback.
  const receipt = reply.parts.find((part): part is Extract<typeof part, { type: 'receipt' }> => part.type === 'receipt')!;
  const shownByOldBuild = { ...reply, parts: reply.parts.filter(part => part.type === 'text') };
  expect(shownByOldBuild.text.endsWith(`\n\n${receipt.fallback_text}`)).toBe(true);
  expect(shownByOldBuild.parts).toEqual([{ type: 'text', text: reply.text }]);
  const at = (reply.parts[1] as { items: readonly { at: number }[] }).items[0]!.at;
  expect(at).toBeGreaterThanOrEqual(before);
  expect(at).toBeLessThanOrEqual(Date.now());
});

it('a turn with no effect has no receipt part', async () => {
  const reply = await replyTo('app-receipt-none', 'hello there');
  expect(reply.parts).toEqual([{ type: 'text', text: 'Done.' }]);
});

import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appHistoryResultV1Schema } from '../../contracts/src/app/core';
import type { LLMGatewayRequest } from '../src/llm/provider';
import { claimStore } from '../src/memory/claims';
import { ensureSchema } from '../src/tracer/schema';

// An app owner turn checks its reply's declared claims against the turn's receipts: a claimed send with no effect call
// is revised once and still claimed arrives with the not-confirmed line, above the receipt line the receipt part hides.
const QUIET = { quiet_start: '21:00', quiet_end: '07:00', volume: 'normal' };
const rounds: string[][] = [];
const histories: string[][] = [];
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete({ request }: LLMGatewayRequest) {
    const done = (text: string, tool_calls?: Array<{ call_id: string; name: string; arguments: string }>) => ({ ok: true as const, data: { model: request.model, text, ...(tool_calls ? { tool_calls } : {}), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } });
    if (request.response_format) return done(request.response_format.name === 'task_source_scope' ? '{"decision":"retain","sources":[]}' : '{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}');
    const asked = String(request.messages.at(-1)?.content ?? '');
    rounds.push((request.tools ?? []).map(tool => tool.name));
    histories.push(request.messages.map(message => `${message.role}: ${message.content}`));
    if (asked.includes('what did you do')) return done('That was all.');
    if (asked.includes('green tea') && !request.tool_turns?.length) return done('', [{ call_id: `tea-${rounds.length}`, name: 'remember', arguments: JSON.stringify({ kind: 'preference', text: 'Owner likes green tea', evidence_quote: 'I like green tea' }) }]);
    if (asked.includes('quiet hours') && !request.tool_turns?.length) return done('', [{ call_id: 'quiet', name: 'set_proactivity', arguments: JSON.stringify(QUIET) }]);
    const claims = (...effects: string[]) => effects.map((effect, index) => ({ call_id: `claim-${rounds.length}-${index}`, name: 'note_done', arguments: JSON.stringify({ effect }) }));
    if (asked.includes('green tea')) return done('Saved: you like green tea.', [{ call_id: `tea-claim-${rounds.length}`, name: 'note_done', arguments: JSON.stringify({ effect: 'memory_stored' }) }]);
    if (asked.includes('quiet hours')) return done('Quiet hours set, and I messaged Pat.', claims('proactivity_set', 'message_send_proposed'));
    return done('Quiet hours set.', claims('proactivity_set'));
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
const replyTo = async (name: string, text: string, clientId = 'receipt-client-01') => runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
  claimStore(state.storage.sql); ensureSchema(state.storage);
  state.storage.kv.put('do_name', name);
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const owner = new OwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined });
  try {
    const sent = await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main/messages', { method: 'POST', headers: headers(name), body: JSON.stringify({ client_message_id: clientId, text }) }));
    const { message_id: id } = await sent.json() as { message_id: string };
    await vi.waitFor(() => expect(state.storage.kv.get<{ state: string }>(`app:inbox-record:${id}`)?.state).toBe('completed'), { timeout: 10_000, interval: 20 });
    const page = appHistoryResultV1Schema.parse(await (await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main', { headers: headers(name) }))).json());
    return page.messages.find(message => message.role === 'assistant' && message.parent_id === id)!;
  } finally { quiet.mockRestore(); await state.storage.deleteAlarm(); }
});

it('a claimed send with no receipt is revised once, then delivered as not confirmed above the receipt line', async () => {
  rounds.length = 0;
  const reply = await replyTo('app-claims-unbacked', 'please set quiet hours');
  expect(rounds.slice(1).map(names => names.includes('note_done') && names.length === 1)).toEqual([false, true]);
  expect(reply.text).toBe('Quiet hours set, and I messaged Pat.\n\nNot confirmed: message send proposed (nothing ran)\n\nDone: proactivity set');
  const receipt = reply.parts.find((part): part is Extract<typeof part, { type: 'receipt' }> => part.type === 'receipt')!;
  expect(receipt.fallback_text).toBe('Done: proactivity set');
  expect(reply.text.endsWith(`\n\n${receipt.fallback_text}`)).toBe(true);
});

it('a claim that is not backed with no effect at all still reaches the owner as not confirmed, with no receipt part', async () => {
  rounds.length = 0;
  const reply = await replyTo('app-claims-no-effect', 'hello there');
  expect(rounds).toHaveLength(2);
  expect(reply.parts).toEqual([{ type: 'text', text: 'Quiet hours set.\n\nNot confirmed: proactivity set (nothing ran)' }]);
});

it('the notice is part of the stored reply, so the next turn\'s model sees what the owner saw', async () => {
  histories.length = 0;
  await replyTo('app-claims-history', 'hello there', 'claims-client-01');
  histories.length = 0;
  await replyTo('app-claims-history', 'what did you do', 'claims-client-02');
  expect(histories[0]!.some(line => line === 'assistant: Quiet hours set.\n\nNot confirmed: proactivity set (nothing ran)'), JSON.stringify(histories[0])).toBe(true);
});

it('a save the memory already held backs a memory_stored claim, and is not shown as a new save', async () => {
  const first = await replyTo('app-claims-duplicate', 'remember that I like green tea', 'tea-client-01');
  expect(first.text).toBe('Saved: you like green tea.\n\nDone: memory stored');
  const again = await replyTo('app-claims-duplicate', 'remember again that I like green tea', 'tea-client-02');
  expect(again.text).toBe('Saved: you like green tea.');
});

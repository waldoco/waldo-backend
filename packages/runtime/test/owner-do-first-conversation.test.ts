import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import type { LLMGatewayAdapter, LLMGatewayRequest } from '../src/llm/provider';
import { claimStore } from '../src/memory/claims';
import { ensureSchema } from '../src/tracer/schema';

// The first conversation on the app: a new owner's turn carries the host facts once, in their own section; an owner with a
// grounded claim gets none; and the owner's own words set the time zone through the app control's writer, arming their jobs.
const FACTS = 'Host facts about this owner';
const OWNER_ID = '7c2e9b41-3f5a-4d8e-a1b6-2c9d0e7f4a13';
const BASE = 'https://directory.fixture.invalid';

const model = vi.hoisted(() => ({ requests: [] as LLMGatewayRequest['request'][], zone: null as string | null }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway: LLMGatewayAdapter = { async complete(request) {
    model.requests.push(request.request);
    const format = request.request.response_format?.name;
    const answer = (text: string, calls?: { call_id: string; name: string; arguments: string }[]) => ({ ok: true as const, data: { model: request.request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0, ...(calls ? { tool_calls: calls } : {}) } });
    if (format === 'task_source_scope') return answer('{"decision":"retain","sources":[]}');
    if (format !== undefined) return answer('{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}');
    if (model.zone) { const timezone = model.zone; model.zone = null; return answer('', [{ call_id: 'zone-1', name: 'set_timezone', arguments: JSON.stringify({ timezone }) }]); }
    return answer('Noted.');
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

afterEach(() => { vi.unstubAllGlobals(); model.requests = []; model.zone = null; });

const directory = (settings: string[]) => vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
  const args = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
  if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: args.p_do_name, session_hash: args.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
  if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: args.p_do_name, state_version: 1, admission_revision: '5' });
  if (fn === 'assert_channel_presence') return Response.json(true);
  if (fn === 'health_context_read') return Response.json(null);
  if (fn === 'set_owner_settings') { settings.push(args.p_timezone ?? ''); return Response.json(true); }
  return new Response('unexpected', { status: 500 });
});
const ownerFor = async (name: string, state: DurableObjectState) => {
  claimStore(state.storage.sql);
  ensureSchema(state.storage);
  state.storage.kv.put('do_name', name);
  await state.storage.put('origin', 'https://fixture.invalid');
  return new OwnerDO(state, { ...env, SUPABASE_PROJECT_URL: BASE, SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret', OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined, TELEGRAM_BOT_TOKEN: '7:synthetic-fixture' });
};
const send = async (owner: InstanceType<typeof OwnerDO>, state: DurableObjectState, name: string, text: string) => {
  const sent = await owner.fetch(new Request('https://owner.invalid/app/v1/chat/main/messages', { method: 'POST', headers: { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'b'.repeat(64), 'content-type': 'application/json' }, body: JSON.stringify({ client_message_id: `client-${text.replace(/\W+/g, "-")}`, text }) }));
  expect(sent.status, `${await sent.clone().text()} ${sent.headers.get("content-type")}`).toBe(202);
  const { message_id: id } = await sent.json() as { message_id: string };
  await vi.waitFor(() => expect(state.storage.kv.get<{ state: string }>(`app:inbox-record:${id}`)?.state).toBe('completed'), { timeout: 10_000, interval: 20 });
};
const repliesTo = (text: string) => model.requests.filter(request => request.response_format === undefined && JSON.stringify(request.messages.at(-1)?.content ?? '').includes(text));
const hops = (calls: unknown[][]) => calls.flatMap(([raw]) => { try { return [JSON.parse(String(raw)) as { hop?: string; ok?: boolean; shape?: { context?: { system_sections?: Record<string, number> } } }]; } catch { return []; } });

it('a new owner\'s app turn carries the host facts once in their own section, and an owner with a grounded claim gets none', async () => {
  directory([]);
  const name = 'first-conversation-facts';
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const owner = await ownerFor(name, state);
    const logs = vi.spyOn(console, 'log');
    try {
      await send(owner, state, name, 'hello there');
      const first = repliesTo('hello there');
      expect(first.length, 'the owner turn reached the model').toBeGreaterThan(0);
      for (const request of first) {
        expect((request.system ?? '').split(FACTS).length - 1, 'the facts appear once').toBe(1);
        expect(request.system).toContain('their time zone is not confirmed (UTC is only a default)');
        expect(request.system).toContain('no name is on record');
        expect(request.system).toContain('they have written to you from the app');
        expect(request.system).toContain('set it with set_timezone');
      }
      expect(hops(logs.mock.calls).some(entry => entry.hop === 'llm_reply' && (entry.shape?.context?.system_sections?.first_conversation ?? 0) > 0), 'the line is measured in its own section').toBe(true);

      claimStore(state.storage.sql).add({ kind: 'preference', text: 'Prefers short replies', source: 'stated', evidence: 'keep it short', origin: 'owner', source_ref: 'owner, app-1' }, new Date().toISOString());
      await send(owner, state, name, 'hello again');
      const later = repliesTo('hello again');
      expect(later.length).toBeGreaterThan(0);
      for (const request of later) expect(request.system).not.toContain(FACTS);
    } finally { logs.mockRestore(); await state.storage.deleteAlarm(); }
  });
});

it('the owner\'s own words set the time zone: settings saved, zone confirmed, jobs armed in it, one reply, and the next turn runs on it', async () => {
  const settings: string[] = [];
  directory(settings);
  const name = 'first-conversation-zone';
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const owner = await ownerFor(name, state);
    const logs = vi.spyOn(console, 'log');
    try {
      const armedIn = (zone: string) => JSON.stringify(state.storage.sql.exec('SELECT * FROM schedule').toArray()).includes(zone);
      expect(armedIn('Asia/Kolkata')).toBe(false);
      model.zone = 'Asia/Kolkata';
      await send(owner, state, name, 'I live in Kolkata now');
      expect(settings).toEqual(['Asia/Kolkata']);
      expect(state.storage.kv.get('timezone')).toBe('Asia/Kolkata');
      expect(state.storage.kv.get('timezone_confirmed')).toBe(true);
      expect(armedIn('Asia/Kolkata'), 'the owner\'s jobs are armed in the new zone').toBe(true);
      expect(repliesTo('I live in Kolkata now').length, 'one tool round, then one reply').toBe(2);
      const trace = hops(logs.mock.calls);
      expect(trace.filter(entry => entry.hop === 'tool_set_timezone').map(entry => entry.ok), 'the trace records one successful call').toEqual([true]);

      await send(owner, state, name, 'thanks');
      for (const request of repliesTo('thanks')) {
        expect(request.system).toContain('(Asia/Kolkata)');
        expect(request.system).toContain('their time zone, Asia/Kolkata, is confirmed');
      }
    } finally { logs.mockRestore(); await state.storage.deleteAlarm(); }
  });
});

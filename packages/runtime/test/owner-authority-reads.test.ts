import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LLMGatewayAdapter } from '../src/llm/provider';
import { claimStore } from '../src/memory/claims';
import { ensureSchema } from '../src/tracer/schema';

// One app turn of three tool rounds and a closing answer, against a directory that counts its session reads.
const OWNER_ID = '5d1f8a20-6c3b-4e9a-b7d2-0e4f6a8c1b3d';
const TOOLS = ['list_reminders', 'list_standing_orders', 'list_artifacts'];
const world = vi.hoisted(() => ({ replies: 0, sessionReads: 0, live: true, skew: 0, onReply: undefined as undefined | ((round: number) => void) }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway: LLMGatewayAdapter = { async complete(request) {
    const data = { model: request.request.model, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 };
    if (request.request.response_format) return { ok: true, data: { ...data, text: '{"decision":"retain","sources":[],"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}' } };
    world.replies += 1;
    world.onReply?.(world.replies);
    const tool = TOOLS[world.replies - 1];
    return { ok: true, data: tool ? { ...data, text: '', tool_calls: [{ call_id: `c${world.replies}`, name: tool, arguments: '{}' }] } : { ...data, text: 'Done.' } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const appTurn = (name: string) => {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(String(input instanceof Request ? input.url : input))?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'app_session_authority') {
      world.sessionReads += 1;
      return Response.json(world.live ? { owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 } : null);
    }
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'health_context_read') return Response.json(null);
    return new Response('unexpected', { status: 500 });
  });
  return runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (instance, state) => {
    // The test drives the turn through its own OwnerDO; the binding's instance must not reconcile it as abandoned.
    (instance as unknown as { alarm(): Promise<void> }).alarm = async () => {};
    const realNow = Date.now;
    Date.now = () => realNow() + world.skew;
    claimStore(state.storage.sql);
    ensureSchema(state.storage);
    state.storage.kv.put('do_name', name);
    const owner = new OwnerDO(state, { ...env, SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret', TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined });
    try {
      const sent = await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main/messages', { method: 'POST', headers: { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'a'.repeat(64), 'content-type': 'application/json' }, body: JSON.stringify({ client_message_id: `client-${name}`, text: 'what is on today?' }) }));
      expect(sent.status).toBe(202);
      const { message_id: id } = await sent.json() as { message_id: string };
      await vi.waitFor(() => expect(['completed', 'interrupted', 'revoked']).toContain(state.storage.kv.get<{ state: string }>(`app:inbox-record:${id}`)?.state), { timeout: 10_000, interval: 10 });
      return state.storage.kv.get<{ state: string }>(`app:inbox-record:${id}`)!.state;
    } finally { Date.now = realNow; await state.storage.deleteAlarm(); }
  });
};

afterEach(() => { vi.unstubAllGlobals(); Object.assign(world, { replies: 0, sessionReads: 0, live: true, skew: 0, onReply: undefined }); });

describe('owner authority across a tool turn', () => {
  it('a three-round app turn completes on a bounded number of directory session reads', async () => {
    // Each model call ages the last read past its window, so every round re-reads the directory at least once.
    world.onReply = () => { world.skew += 2_000; };
    expect(await appTurn('authority-reads-bounded')).toBe('completed');
    expect(world.replies).toBe(4);
    expect(world.sessionReads).toBeGreaterThanOrEqual(world.replies);
    expect(world.sessionReads).toBeLessThanOrEqual(20);
  });

  it('a session the directory revokes during a model call stops the turn before the next model call', async () => {
    world.onReply = round => { if (round === 1) { world.live = false; world.skew += 2_000; } };
    expect(await appTurn('authority-reads-revoked')).not.toBe('completed');
    expect(world.replies).toBe(1);
  });
});

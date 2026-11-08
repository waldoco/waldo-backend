import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LLMGatewayAdapter } from '../src/llm/provider';
import { appSubjectFor } from '../src/channels/app-api';
import { PUSHES } from '../src/channels/expo-push';
import { traceBook } from '../src/channels/harness';
import { claimStore } from '../src/memory/claims';
import { ensureSchema } from '../src/tracer/schema';

// An event notice for an app owner reaches Main chat, then raises one push with the event trigger and its fixed line: never the
// event's own title, which an outside sender wrote. An owner whose notices go to WhatsApp or Telegram gets the message itself.
const EXPO_TOKEN = 'ExponentPushToken[synthetic-fixture-token]';
const INSTALLATION = '0f1e2d3c-4b5a-4968-8776-655443322110';
const OWNER_ID = '3a4b5c6d-7e8f-4a0b-8c1d-2e3f4a5b6c7d';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway: LLMGatewayAdapter = { async complete(request) {
    return { ok: true, data: { model: request.request.model, text: 'SKIP', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const wire = { pushes: [] as { body: string; data: unknown }[], telegram: [] as string[] };
beforeEach(() => {
  wire.pushes = []; wire.telegram = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'app_push_targets') return Response.json([{ installation_id: INSTALLATION, device_epoch: 4, token: EXPO_TOKEN }]);
    if (fn === 'health_context_read') return Response.json(null);
    if (fn === 'health_log_recent') return Response.json([]);
    if (url.startsWith('https://api.telegram.org/')) { wire.telegram.push(url.slice(url.lastIndexOf('/') + 1)); return Response.json({ ok: true, result: { message_id: 1, chat: { id: 7 } } }); }
    if (url === 'https://exp.host/--/api/v2/push/send') {
      for (const message of JSON.parse(String(init?.body)) as { body: string; data: unknown }[]) wire.pushes.push({ body: message.body, data: message.data });
      return Response.json({ data: [{ status: 'ok', id: 'ticket-1' }] });
    }
    return Response.json(true);
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

type Owner = Readonly<{ setup(channel: string): { ready: Promise<unknown> }; fetch(request: Request): Promise<Response> }>;
const TITLE = 'Deploy finished for build 4512';
const event = (owner: Owner, id: string) => owner.fetch(new Request('https://telegram-owner/event', { method: 'POST', body: JSON.stringify({ subject: 'fixture', kind: 'incident', title: TITLE }), headers: {
  'x-waldo-origin': 'https://waldo.fixture.invalid', 'x-waldo-event-source': 'uptime', 'x-waldo-event-notify': '1', 'x-waldo-event-delivery': `id:${id}`, 'x-waldo-event-digest': 'a'.repeat(64),
} }));

const withOwner = (name: string, run: (owner: Owner, state: DurableObjectState) => Promise<void>, telegram = false) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    try {
      claimStore(state.storage.sql); ensureSchema(state.storage); traceBook(state.storage.sql);
      state.storage.kv.put('do_name', name);
      if (telegram) state.storage.kv.put('telegram_subject', '7');
      else state.storage.kv.put('app_subject', String(appSubjectFor(name)));
      state.storage.kv.put('timezone', 'UTC');
      state.storage.kv.put('timezone_confirmed', true);
      await state.storage.put('origin', 'https://fixture.invalid');
      const owner = new OwnerDO(state, { ...env, ...directory, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined,
        EXPO_ACCESS_TOKEN: 'synthetic-expo-access', OWNER_SURFACE_DEFAULT: '1', ...(telegram ? { TELEGRAM_BOT_TOKEN: '7:synthetic-fixture' } : {}) }) as unknown as Owner;
      await owner.setup(telegram ? 'telegram' : 'app').ready;
      await run(owner, state);
    } finally { await state.storage.deleteAlarm(); }
  });

it('an app owner\'s event notice reaches Main chat and raises one event push with its fixed line', async () => {
  await withOwner('push-event-app', async (owner) => {
    expect((await event(owner, 'push-ev-1')).status).toBe(200);
    await vi.waitFor(() => expect(wire.pushes).toHaveLength(1));
    expect(wire.pushes).toEqual([{ body: PUSHES.event.body, data: { trigger: 'event' } }]);
    expect(JSON.stringify(wire.pushes)).not.toContain('4512');
    // A redelivery of the same event raises nothing again.
    expect((await event(owner, 'push-ev-1')).status).toBe(200);
    expect(wire.pushes).toHaveLength(1);
  });
});

it('an owner whose notices go to Telegram gets the message itself and no push', async () => {
  await withOwner('push-event-telegram', async (owner) => {
    expect((await event(owner, 'push-ev-tg')).status).toBe(200);
    expect(wire.telegram).toContain('sendMessage');
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(wire.pushes).toEqual([]);
  }, true);
});

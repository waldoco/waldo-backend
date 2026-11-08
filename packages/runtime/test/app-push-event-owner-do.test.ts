import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LLMGatewayAdapter } from '../src/llm/provider';
import { appSubjectFor } from '../src/channels/app-api';
import { PUSHES } from '../src/channels/expo-push';
import { INTERRUPTS_KEY } from '../src/channels/interruptions';
import { loopBook } from '../src/channels/loops';
import { traceBook } from '../src/channels/harness';
import { claimStore } from '../src/memory/claims';
import { ensureSchema } from '../src/tracer/schema';

// An event notice for an app owner reaches Main chat, then raises one push with the event trigger and its fixed line: never the
// event's own title, which an outside sender wrote. An owner whose notices go to WhatsApp or Telegram gets the message itself.
// The push is an unasked message: it holds in quiet hours and on the owner's no (follow-ups off, volume low), and with
// PROACTIVE_GATE it waits on the owner's limits and spends from them.
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

const wire = { pushes: [] as { body: string; data: unknown }[], telegram: [] as string[], admitted: true };
// Noon on a weekday, inside the owner's day, so only the hold under test can stop the push.
const NOON = Date.UTC(2026, 10, 9, 12, 0);
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOON });
  wire.pushes = []; wire.telegram = []; wire.admitted = true;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'owner_runtime_authority') return wire.admitted ? Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' }) : Response.json(null);
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
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

type Owner = Readonly<{ setup(channel: string): { ready: Promise<unknown> }; fetch(request: Request): Promise<Response> }>;
const TITLE = 'Deploy finished for build 4512';
const event = (owner: Owner, id: string) => owner.fetch(new Request('https://telegram-owner/event', { method: 'POST', body: JSON.stringify({ subject: 'fixture', kind: 'incident', title: TITLE }), headers: {
  'x-waldo-origin': 'https://waldo.fixture.invalid', 'x-waldo-event-source': 'uptime', 'x-waldo-event-notify': '1', 'x-waldo-event-delivery': `id:${id}`, 'x-waldo-event-digest': 'a'.repeat(64),
} }));

type Setup = Readonly<{ telegram?: boolean; env?: Readonly<Record<string, string>>; proactivity?: Parameters<ReturnType<typeof loopBook>['setProactivity']>[0] }>;
const withOwner = (name: string, run: (owner: Owner, state: DurableObjectState) => Promise<void>, { telegram = false, env: extra = {}, proactivity }: Setup = {}) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    try {
      claimStore(state.storage.sql); ensureSchema(state.storage); traceBook(state.storage.sql);
      state.storage.kv.put('do_name', name);
      if (telegram) state.storage.kv.put('telegram_subject', '7');
      else state.storage.kv.put('app_subject', String(appSubjectFor(name)));
      state.storage.kv.put('timezone', 'UTC');
      state.storage.kv.put('timezone_confirmed', true);
      await state.storage.put('origin', 'https://fixture.invalid');
      if (proactivity) loopBook(state.storage.sql, { newId: () => 'fixture', now: Date.now }).setProactivity(proactivity);
      const owner = new OwnerDO(state, { ...env, ...directory, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined,
        EXPO_ACCESS_TOKEN: 'synthetic-expo-access', OWNER_SURFACE_DEFAULT: '1', EVENT_PUSH: '1', ...(telegram ? { TELEGRAM_BOT_TOKEN: '7:synthetic-fixture' } : {}), ...extra }) as unknown as Owner;
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
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(wire.pushes).toHaveLength(1);
  });
});

it('an owner whose notices go to Telegram gets the message itself and no push', async () => {
  await withOwner('push-event-telegram', async (owner) => {
    expect((await event(owner, 'push-ev-tg')).status).toBe(200);
    expect(wire.telegram).toContain('sendMessage');
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(wire.pushes).toEqual([]);
  }, { telegram: true });
});

// The push's own log line, so a case that sends nothing shows which rule held it.
const pushCodes = (logs: { mock: { calls: unknown[][] } }) => logs.mock.calls.flatMap(([raw]) => {
  try { const line = JSON.parse(String(raw)) as { hop?: string; code?: string }; return line.hop === 'app_push' && line.code ? [line.code] : []; } catch { return []; }
});
const settle = () => new Promise(resolve => setTimeout(resolve, 50));
const noon = { quiet_start: null, quiet_end: null, volume: 'normal' } as const;

it.each([
  ['the switch is off', { env: { EVENT_PUSH: '0' } }, null],
  ['quiet hours', { proactivity: { ...noon, quiet_start: '11:00', quiet_end: '13:00' } }, 'quiet'],
  ['volume low', { proactivity: { ...noon, volume: 'low' } }, 'held_consent'],
  ['follow-ups off', { proactivity: { ...noon, followups: false } }, 'held_consent'],
  ['no unasked messages a day, under the owner\'s limits', { env: { PROACTIVE_GATE: '1' }, proactivity: { ...noon, interruptions_per_day: 0 } }, 'held_budget'],
] as const)('no event push when %s', async (_case, setup, code) => {
  const logs = vi.spyOn(console, 'log');
  try {
    await withOwner(`push-event-held-${_case.replace(/\W+/g, '-')}`, async (owner) => {
      expect((await event(owner, 'push-held')).status).toBe(200);
      await settle();
      expect(wire.pushes).toEqual([]);
      if (code) expect(pushCodes(logs)).toEqual([code]);
      else expect(pushCodes(logs)).toEqual([]);
    }, setup);
  } finally { logs.mockRestore(); }
});

it('no event push when the notice did not reach the app chat', async () => {
  await withOwner('push-event-unsent', async (owner, state) => {
    wire.admitted = false;
    expect((await event(owner, 'push-unsent')).status).toBe(200);
    await settle();
    expect(wire.pushes).toEqual([]);
    expect(state.storage.kv.get(INTERRUPTS_KEY)).toBeUndefined();
  });
});

it('under the owner\'s limits, an event push spends one unasked message, and a spent day holds the next', async () => {
  const logs = vi.spyOn(console, 'log');
  try {
    await withOwner('push-event-gated', async (owner, state) => {
      expect((await event(owner, 'push-gated-1')).status).toBe(200);
      await vi.waitFor(() => expect(wire.pushes).toHaveLength(1));
      expect(state.storage.kv.get<{ count: number }>(INTERRUPTS_KEY)?.count).toBe(1);
      expect((await event(owner, 'push-gated-2')).status).toBe(200);
      await settle();
      expect(wire.pushes).toHaveLength(1);
      expect(pushCodes(logs)).toEqual(['sent', 'held_budget']);
    }, { env: { PROACTIVE_GATE: '1' }, proactivity: { ...noon, interruptions_per_day: 1 } });
  } finally { logs.mockRestore(); }
});

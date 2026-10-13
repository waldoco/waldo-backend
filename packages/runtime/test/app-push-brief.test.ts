import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LLMGatewayAdapter } from '../src/llm/provider';
import { appSubjectFor } from '../src/channels/app-api';
import { routerSignature } from '../src/identity/owner-directory';
import { dayPlanBook } from '../src/channels/day-cards';
import { traceBook } from '../src/channels/harness';
import { claimStore } from '../src/memory/claims';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';
import { ensureSchema } from '../src/tracer/schema';

// The Brief pushes one fixed line to the owner's app devices, and only when it was delivered to the app.
const CARD_TEXT = 'Your morning is clear until noon.';
const EXPO_TOKEN = 'ExponentPushToken[synthetic-fixture-token]';
const EXPO_ACCESS_TOKEN = 'synthetic-expo-access';
const INSTALLATION = '0f1e2d3c-4b5a-4968-8776-655443322110';
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway: LLMGatewayAdapter = { async complete(request) {
    const content = request.request.messages.at(-1)?.content ?? '';
    const text = String(content).includes('[Scheduled card') ? CARD_TEXT : 'SKIP';
    return { ok: true, data: { model: request.request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '3a4b5c6d-7e8f-4a0b-8c1d-2e3f4a5b6c7d';
const AT = Date.parse('2026-10-03T09:00:00Z');
const DAY = '2026-10-03';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const wire = { expo: 'ok' as 'ok' | 'fails' | 'unregistered', pushes: [] as unknown[], targetsAsked: 0, retired: [] as Record<string, unknown>[], authorization: [] as (string | null)[] };

beforeEach(() => {
  wire.expo = 'ok'; wire.pushes = []; wire.targetsAsked = 0; wire.retired = []; wire.authorization = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    if (fn === 'app_push_targets') {
      wire.targetsAsked += 1;
      return Response.json([{ installation_id: INSTALLATION, device_epoch: 4, token: EXPO_TOKEN }]);
    }
    if (fn === 'app_push_retire') { wire.retired.push(asked); return Response.json(true); }
    if (fn === 'health_log_recent') return Response.json([]);
    if (fn === 'health_context_read') return Response.json(null);
    if (fn === 'assert_channel_presence') return Response.json(true);
    if (url === 'https://exp.host/--/api/v2/push/send') {
      wire.pushes.push(JSON.parse(String(init?.body)));
      wire.authorization.push(new Headers(init?.headers).get('authorization'));
      if (wire.expo === 'fails') throw new Error('network down');
      return Response.json({ data: [wire.expo === 'unregistered' ? { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } } : { status: 'ok', id: 'ticket-1' }] });
    }
    if (url.startsWith('https://api.telegram.org/')) return Response.json({ ok: true, result: { message_id: 1, chat: { id: 7 } } });
    return Response.json(true);
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

type Owner = Readonly<{ setup(channel: string): { ready: Promise<unknown> }; fetch(request: Request): Promise<Response>; alarm(): Promise<void> }>;

// An owner bound to the app, or to Telegram only, with a Brief due now and nothing else scheduled.
const briefFires = async (name: string, surface: 'app' | 'telegram', check: (owner: Owner, state: DurableObjectState) => Promise<void>, configured = true) => {
  const stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name));
  await runInDurableObject(stub, async (_instance, state) => {
    const originalNow = Date.now;
    Date.now = () => AT;
    try {
      claimStore(state.storage.sql); ensureSchema(state.storage); traceBook(state.storage.sql);
      state.storage.kv.put('do_name', name);
      if (surface === 'app') state.storage.kv.put('app_subject', String(appSubjectFor(name)));
      else state.storage.kv.put('telegram_subject', '7');
      state.storage.kv.put('timezone', 'UTC');
      state.storage.kv.put('timezone_confirmed', true);
      const owner = new OwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC',
        WALDO_OWNER_TELEGRAM_ID: undefined, EXPO_ACCESS_TOKEN: configured ? EXPO_ACCESS_TOKEN : undefined }) as unknown as Owner;
      await owner.setup(surface).ready;
      state.storage.sql.exec('DELETE FROM schedule');
      dayPlanBook(state.storage.sql).save(DAY, { card: 'card:brief', time: '00:00', reason: 'planned' });
      await new Scheduler(state.storage.sql, state.storage, productionDeps())
        .schedule({ id: 'card:brief', kind: 'brief', payloadRefs: { id: 'card:brief' }, occurrenceAt: AT - 1000, dueAt: AT - 1000, recurrence: null });
      state.storage.kv.put('owner_alarm_last_v1', 1);
      await owner.alarm();
      await check(owner, state);
    } finally { Date.now = originalNow; await state.storage.deleteAlarm(); }
  });
};
const appChat = async (owner: Owner, name: string) => {
  const response = await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main', { headers: { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'a'.repeat(64) } }));
  return (await response.json() as { messages: { text: string }[] }).messages.map(message => message.text);
};
const pushLog = (state: DurableObjectState) => state.storage.sql.exec<{ ok: number; note: string | null }>("SELECT ok, note FROM trace_log WHERE hop = 'app_push'").toArray();

it('an app owner\'s Brief reaches the app chat, then pushes the fixed line to their Expo device', async () => {
  await briefFires('push-brief-app', 'app', async (owner, state) => {
    expect(await appChat(owner, 'push-brief-app')).toEqual([CARD_TEXT]);
    expect(wire.pushes).toEqual([[{ to: EXPO_TOKEN, body: 'Your Brief is ready', data: { trigger: 'brief', variant: 'morning', card_ref: 'card:brief' }, sound: 'default' }]]);
    expect(wire.authorization).toEqual([`Bearer ${EXPO_ACCESS_TOKEN}`]);
    expect(pushLog(state)).toEqual([{ ok: 1, note: expect.stringMatching(/^sent\b/) }]);
  });
});

it('a Telegram-only owner\'s Brief pushes nothing and never asks for push devices', async () => {
  await briefFires('push-brief-telegram', 'telegram', async (_owner, state) => {
    expect(wire.targetsAsked).toBe(0);
    expect(wire.pushes).toEqual([]);
    expect(pushLog(state)).toEqual([]);
  });
});

it('when Expo cannot be reached, the Brief is still in the app chat, and the failure is one fixed code', async () => {
  wire.expo = 'fails';
  await briefFires('push-brief-down', 'app', async (owner, state) => {
    expect(await appChat(owner, 'push-brief-down')).toEqual([CARD_TEXT]);
    expect(wire.pushes).toHaveLength(1);
    expect(pushLog(state)).toEqual([{ ok: 0, note: expect.stringMatching(/^send_failed\b/) }]);
    expect(JSON.stringify(state.storage.sql.exec("SELECT * FROM trace_log WHERE hop = 'app_push'").toArray())).not.toContain(EXPO_TOKEN);
  });
});

it('without Expo\'s access token the Brief still reaches the app chat, and push reads no devices', async () => {
  await briefFires('push-brief-unconfigured', 'app', async (owner, state) => {
    expect(await appChat(owner, 'push-brief-unconfigured')).toEqual([CARD_TEXT]);
    expect([wire.targetsAsked, wire.pushes.length]).toEqual([0, 0]);
    expect(pushLog(state)).toEqual([{ ok: 0, note: expect.stringMatching(/^not_configured\b/) }]);
  }, false);
});

it('a device Expo no longer reaches is retired in the directory, signed for this owner on the epoch that was read', async () => {
  wire.expo = 'unregistered';
  await briefFires('push-brief-retire', 'app', async (owner, state) => {
    expect(await appChat(owner, 'push-brief-retire')).toEqual([CARD_TEXT]);
    expect(wire.retired).toEqual([{ p_do_name: 'push-brief-retire', p_installation_id: INSTALLATION, p_device_epoch: 4, p_at: expect.any(Number), p_sig: expect.any(String) }]);
    const { p_at: at, p_sig: signature } = wire.retired[0] as { p_at: number; p_sig: string };
    expect(signature).toBe(await routerSignature(directory.WALDO_ROUTER_HMAC_SECRET, at, `app.push.retire.push-brief-retire.${INSTALLATION}.4`));
    expect(pushLog(state).map(row => row.note?.split(':')[0])).toEqual(['partial', 'retired']);
  });
});

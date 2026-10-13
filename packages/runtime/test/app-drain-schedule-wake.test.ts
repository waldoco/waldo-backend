import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appSubjectFor } from '../src/channels/app-api';
import { reminderBook } from '../src/channels/reminders';
import { claimStore } from '../src/memory/claims';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';
import { ensureSchema } from '../src/tracer/schema';

vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete(request: import('../src/llm/provider').LLMGatewayRequest) {
    return { ok: true as const, data: { model: request.request.model, text: 'Noted.', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { TelegramOwnerDO } = await import('../src/channels/telegram-owner-do');

const OWNER_ID = '3d2c1b0a-9e8f-4a7b-8c6d-5e4f3a2b1c0d';
beforeEach(() => {
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

// An app owner with a reminder an hour out: the alarm that will fire it is armed before the message.
const withReminder = (name: string, work: (owner: InstanceType<typeof TelegramOwnerDO>, state: DurableObjectState, armed: number) => Promise<void>) =>
  runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name)), async (_instance, state) => {
    claimStore(state.storage.sql); ensureSchema(state.storage);
    state.storage.kv.put('do_name', name); state.storage.kv.put('app_subject', String(appSubjectFor(name)));
    const owner = new TelegramOwnerDO(state, { ...env, SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret',
      TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined });
    const inAnHour = new Date(Date.now() + 3_600_000).toISOString().slice(0, 16);
    await reminderBook(state.storage.sql, new Scheduler(state.storage.sql, state.storage, productionDeps()), { timezone: 'UTC', now: () => new Date() }, () => 'rem-wake')
      .set({ note: 'call Sam', at: inAnHour, repeat: 'none' });
    const armed = await state.storage.getAlarm();
    expect(armed).toBe(Date.parse(`${inAnHour}:00Z`));
    try { await work(owner, state, armed!); } finally { await state.storage.deleteAlarm(); }
  });
const send = (owner: InstanceType<typeof TelegramOwnerDO>, name: string, clientId: string) => owner.fetch(new Request('https://telegram-owner/app/v1/chat/main/messages', {
  method: 'POST', headers: { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'a'.repeat(64), 'content-type': 'application/json' }, body: JSON.stringify({ client_message_id: clientId, text: 'What is on today?' }) }));

it('an app message leaves the alarm for the owner\'s next scheduled job in place', async () => {
  const name = 'app-drain-keeps-wake';
  await withReminder(name, async (owner, state, armed) => {
    const { message_id: id } = await (await send(owner, name, 'wake-client-0001')).json() as { message_id: string };
    await vi.waitFor(() => expect(state.storage.kv.get<{ state: string }>(`app:inbox-record:${id}`)?.state).toBe('completed'), { timeout: 10_000, interval: 20 });
    await vi.waitFor(async () => expect(await state.storage.getAlarm()).toBe(armed), { timeout: 5_000, interval: 20 });
  });
});


it('a repeated send of a message already answered, which drains nothing, leaves that alarm in place too', async () => {
  const name = 'app-drain-duplicate-keeps-wake';
  await withReminder(name, async (owner, state, armed) => {
    const { message_id: id } = await (await send(owner, name, 'wake-client-0002')).json() as { message_id: string };
    await vi.waitFor(() => expect(state.storage.kv.get<{ state: string }>(`app:inbox-record:${id}`)?.state).toBe('completed'), { timeout: 10_000, interval: 20 });
    const serial = owner as unknown as { serial(work: () => Promise<void>): Promise<void> };
    await serial.serial(async () => undefined);
    await state.storage.setAlarm(armed);
    const again = await send(owner, name, 'wake-client-0002');
    expect(again.status).toBe(202);
    expect(await again.json()).toMatchObject({ message_id: id, state: 'completed' });
    await serial.serial(async () => undefined);
    expect(await state.storage.getAlarm()).toBe(armed);
  });
});

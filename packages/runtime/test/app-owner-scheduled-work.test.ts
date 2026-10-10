import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appSubjectFor } from '../src/channels/app-api';
import { reminderBook } from '../src/channels/reminders';
import { canonicalOwnerConversationStore } from '../src/conversation/canonical-owner-store';
import { claimStore } from '../src/memory/claims';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';
import { ensureSchema } from '../src/tracer/schema';

const REMINDER_TEXT = 'Time to call Sam.';
const model = vi.hoisted(() => ({ calls: 0, requests: [] as string[] }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete(request: import('../src/llm/provider').LLMGatewayRequest) {
    model.calls += 1;
    const sent = JSON.stringify(request);
    model.requests.push(sent);
    return { ok: true as const, data: { model: request.request.model, text: sent.includes('Reminder due now') ? 'Time to call Sam.' : 'Noted.', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { TelegramOwnerDO } = await import('../src/channels/telegram-owner-do');

const OWNER_ID = '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const ownerHex = OWNER_ID.replaceAll('-', '');
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };

type Authority = 'current' | 'revoked' | 'outage';
const wire = { authority: 'current' as Authority, asked: [] as string[], other: [] as string[] };
beforeEach(() => {
  model.calls = 0; model.requests = []; wire.authority = 'current'; wire.asked = []; wire.other = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
    if (fn === 'owner_runtime_authority') {
      wire.asked.push(fn);
      if (wire.authority === 'outage') throw new Error('directory unavailable');
      if (wire.authority === 'revoked') return Response.json(null);
      const asked = JSON.parse(String(init?.body)) as { p_do_name: string };
      return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    }
    if (fn === 'assert_channel_presence') { wire.asked.push(fn); return Response.json(true); }
    if (fn === 'app_session_authority') {
      wire.asked.push(fn);
      const asked = JSON.parse(String(init?.body)) as { p_do_name: string; p_session_hash: string };
      return Response.json({ owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    }
    if (fn === 'health_context_read') { wire.asked.push(fn); return Response.json(null); }
    wire.other.push(url);
    return new Response('unexpected', { status: 500 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

type Identity = Readonly<{ telegram?: boolean; telegramUnlinked?: boolean; app?: 'own' | 'foreign' | 'none' }>;
const driveAlarm = async (name: string, identity: Identity) => {
  const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name));
  return runInDurableObject(stub, async (_instance, state) => {
    claimStore(state.storage.sql);
    ensureSchema(state.storage);
    const clockBack = (ms: number) => () => new Date(Date.now() - ms);
    const book = reminderBook(state.storage.sql, new Scheduler(state.storage.sql, state.storage, productionDeps()), { timezone: 'UTC', now: clockBack(3_600_000) }, () => 'rem-1');
    const reminder = await book.set({ note: 'call Sam', at: clockBack(30 * 60_000)().toISOString().slice(0, 16), repeat: 'none' });
    state.storage.kv.put('do_name', name);
    if (identity.telegram) state.storage.kv.put('telegram_subject', '7');
    if (identity.telegramUnlinked) state.storage.kv.put('telegram_unlinked', true);
    if (identity.app === 'own') state.storage.kv.put('app_subject', String(appSubjectFor(name)));
    if (identity.app === 'foreign') state.storage.kv.put('app_subject', String(appSubjectFor('another-owner')));
    const owner = new TelegramOwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined });
    try {
      await owner.alarm();
      const askedByAlarm = [...wire.asked];
      const wake = await state.storage.getAlarm();
      const principal = `prn_${ownerHex}`, tenant = `ten_${ownerHex}`;
      const history = canonicalOwnerConversationStore(state.storage, { invocation: { verified_authority: { principal_ref: principal, tenant_ref: tenant } }, assertCurrent: async () => undefined } as never);
      // The app's own read, through its real chat route and session check.
      const chat = await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main', { headers: { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'a'.repeat(64) } }));
      const read = chat.status === 200 ? (await chat.json() as { messages: { role: string; text: string; channel: string }[] }).messages.map(({ role, text, channel }) => ({ role, text, channel })) : chat.status;
      return {
        askedByAlarm,
        retriesAt: wake === null ? null : wake - Date.now(),
        chat: read,
        transcript: (await history.load()).entries.map(entry => ({ role: entry.role, surface: entry.surface, text: entry.appPayload })),
        due: state.storage.sql.exec<{ status: string; attempts: number }>("SELECT status, attempts FROM schedule WHERE id = ?", reminder.id).toArray(),
        queuedOnTelegram: ((await state.storage.get<{ payload: { chat_id: number } }[]>('telegram_final_outbox_v1')) ?? []).map(row => row.payload.chat_id),
        outcomes: state.storage.sql.exec<{ outcome: string }>("SELECT outcome FROM schedule_runs WHERE schedule_id = ?", reminder.id).toArray().map(row => row.outcome),
      };
    } finally { await state.storage.deleteAlarm(); }
  });
};

describe('scheduled work for an owner with no Telegram link', () => {
  it('delivers a due reminder into the app transcript, with no Telegram traffic', async () => {
    const outcome = await driveAlarm('app-only-reminder', { app: 'own' });
    expect(outcome.chat).toEqual([{ role: 'assistant', text: REMINDER_TEXT, channel: 'app' }]);
    expect(outcome.transcript).toEqual([{ role: 'assistant', surface: 'app', text: REMINDER_TEXT }]);
    expect(outcome.due).toEqual([]);
    expect(outcome.outcomes).toEqual(['ok']);
    expect(model.calls).toBe(1);
    expect(wire.other).toEqual([]);
  });

  it('does the same for an owner who unlinked Telegram and uses the app', async () => {
    const outcome = await driveAlarm('app-after-unlink', { telegram: true, telegramUnlinked: true, app: 'own' });
    expect(outcome.transcript).toEqual([{ role: 'assistant', surface: 'app', text: REMINDER_TEXT }]);
    expect(outcome.outcomes).toEqual(['ok']);
  });

  it.each([['revoked', false], ['outage', true]] as const)('runs nothing when the directory says %s, keeps the reminder, and only an outage asks again', async (authority, asksAgain) => {
    wire.authority = authority;
    const outcome = await driveAlarm(`app-authority-${authority}`, { app: 'own' });
    expect(outcome).toMatchObject({ transcript: [], queuedOnTelegram: [], due: [{ status: 'armed', attempts: 0 }], outcomes: [] });
    expect(model.calls).toBe(0);
    expect(wire.other).toEqual([]);
    if (asksAgain) expect(outcome.retriesAt).toBeGreaterThan(30_000);
    else expect(outcome.retriesAt).toBeNull();
  });

  it.each([['none'], ['foreign']] as const)('asks the directory nothing and runs nothing without this owner\'s app binding (%s)', async app => {
    const outcome = await driveAlarm(`app-unbound-${app}`, { app });
    expect(outcome).toMatchObject({ transcript: [], queuedOnTelegram: [], due: [{ status: 'armed', attempts: 0 }], outcomes: [] });
    expect(outcome.askedByAlarm).toEqual([]);
    expect(model.calls).toBe(0);
  });

  it('leaves a Telegram-linked owner on Telegram: no authority lookup, nothing in the app transcript', async () => {
    const outcome = await driveAlarm('telegram-linked-with-app', { telegram: true, app: 'own' });
    expect(outcome.askedByAlarm).not.toContain('owner_runtime_authority');
    expect(outcome.transcript).toEqual([]);
    expect(outcome.queuedOnTelegram).toEqual([7]);
  });
});

describe('the owner\'s next app turn after a scheduled message', () => {
  it('sees the reminder in its history and continues the same transcript', async () => {
    const name = 'app-turn-alarm-turn';
    const headers = { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'a'.repeat(64), 'content-type': 'application/json' };
    await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name)), async (_instance, state) => {
      claimStore(state.storage.sql);
      ensureSchema(state.storage);
      const owner = new TelegramOwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined });
      const turn = async (clientId: string, text: string) => {
        const sent = await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main/messages', { method: 'POST', headers, body: JSON.stringify({ client_message_id: clientId, text }) }));
        expect(sent.status).toBe(202);
        const { message_id: id } = await sent.json() as { message_id: string };
        await vi.waitFor(() => expect(state.storage.kv.get<{ state: string }>(`app:inbox-record:${id}`)?.state).toBe('completed'), { timeout: 10_000, interval: 20 });
        return id;
      };
      try {
        const first = await turn('client-turn-0001', 'Hello there.');
        const clockBack = (ms: number) => () => new Date(Date.now() - ms);
        await reminderBook(state.storage.sql, new Scheduler(state.storage.sql, state.storage, productionDeps()), { timezone: 'UTC', now: clockBack(3_600_000) }, () => 'rem-turn')
          .set({ note: 'call Sam', at: clockBack(30 * 60_000)().toISOString().slice(0, 16), repeat: 'none' });
        await owner.alarm();
        const second = await turn('client-turn-0002', 'What was that reminder?');
        const page = await (await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main', { headers }))).json() as { messages: { id: string; role: string; text: string; parent_id: string | null }[] };
        const oldestFirst = [...page.messages].reverse();
        expect(oldestFirst.map(row => [row.role, row.text])).toEqual([['user', 'Hello there.'], ['assistant', 'Noted.'], ['assistant', REMINDER_TEXT], ['user', 'What was that reminder?'], ['assistant', 'Noted.']]);
        expect(oldestFirst[2]!.parent_id).toBe(oldestFirst[1]!.id);
        expect(oldestFirst[3]!.id).toBe(second);
        expect(oldestFirst[3]!.parent_id).toBe(oldestFirst[2]!.id);
        expect(oldestFirst[0]!.id).toBe(first);
        expect(model.requests.at(-1)).toContain(REMINDER_TEXT);
      } finally { await state.storage.deleteAlarm(); }
    });
  });
});

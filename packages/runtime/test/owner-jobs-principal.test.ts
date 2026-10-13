import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LLMGatewayAdapter } from '../src/llm/provider';
import { appSubjectFor } from '../src/channels/app-api';
import { dayPlanBook } from '../src/channels/day-cards';
import { traceBook } from '../src/channels/harness';
import { reminderBook } from '../src/channels/reminders';
import { claimStore } from '../src/memory/claims';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';
import { ensureSchema } from '../src/tracer/schema';

// Scheduled jobs compose as the owner the directory admits for this Durable Object, whichever surface binds it.
const CARD_TEXT = 'Your morning is clear until noon.';
const REMINDER_TEXT = 'Time to call Sam.';
const fixture = vi.hoisted(() => ({ requests: [] as string[] }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway: LLMGatewayAdapter = { async complete(request) {
    fixture.requests.push(JSON.stringify(request.request));
    const content = request.request.messages.at(-1)?.content ?? '';
    const format = request.request.response_format?.name;
    const text = format === 'task_source_scope' ? '{"decision":"retain","sources":[]}'
      : content.includes('[Scheduled card') ? CARD_TEXT
      : content.includes('[Reminder due now') ? REMINDER_TEXT : 'SKIP';
    return { ok: true, data: { model: request.request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '7d5e6f70-8a9b-4cad-9e0f-2a3b4c5d6e7f';
const OWNER_PRINCIPAL = `prn_${OWNER_ID.replaceAll('-', '')}`;
const PRESENCE_ID = '8e6f7081-9bac-4dbe-8f10-3b4c5d6e7f80';
const FIXTURE_PRINCIPAL = 'prn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const AT = Date.parse('2026-10-03T09:00:00Z');
const DAY = '2026-10-03';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
type Answer = 'current' | 'revoked' | 'outage';
const wire = { telegramAuthority: 'current' as Answer, runtimeAuthority: 'current' as Answer, asked: [] as string[], telegramSent: [] as string[] };

beforeEach(() => {
  fixture.requests = [];
  wire.telegramAuthority = 'current'; wire.runtimeAuthority = 'current'; wire.asked = []; wire.telegramSent = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn) wire.asked.push(fn);
    if (fn === 'common_owner_authority') {
      if (wire.telegramAuthority === 'outage') throw new Error('directory unavailable');
      return Response.json(wire.telegramAuthority === 'revoked' ? null : { owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, presence_id: PRESENCE_ID,
        provider: asked.p_provider, subject: asked.p_subject, state_version: 1, admission_revision: '3' });
    }
    if (fn === 'owner_runtime_authority') {
      if (wire.runtimeAuthority === 'outage') throw new Error('directory unavailable');
      return Response.json(wire.runtimeAuthority === 'revoked' ? null : { owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    }
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    if (fn === 'health_log_recent') return Response.json([]);
    if (fn === 'health_context_read') return Response.json(null);
    if (fn === 'assert_channel_presence') return Response.json(true);
    if (/^https:\/\/api\.telegram\.org\/bot[^/]+\/sendMessage$/.test(url)) {
      wire.telegramSent.push((JSON.parse(String(init?.body)) as { text: string }).text);
      return Response.json({ ok: true, result: { message_id: 40 + wire.telegramSent.length, chat: { id: 7 } } });
    }
    if (url.startsWith('https://api.telegram.org/')) return Response.json({ ok: true, result: true });
    return Response.json(true);
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

type Owner = Readonly<{ setup(channel: string): { ready: Promise<unknown> }; fetch(request: Request): Promise<Response>; alarm(): Promise<void>; serial(work: () => Promise<void>): Promise<void> }>;
type Binding = Readonly<{ telegram: boolean; app: boolean; directory: boolean }>;

const withOwner = async (name: string, binding: Binding, run: (owner: Owner, state: DurableObjectState) => Promise<void>) => {
  const stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name));
  await runInDurableObject(stub, async (_instance, state) => {
    const originalNow = Date.now;
    Date.now = () => AT;
    try {
      claimStore(state.storage.sql); ensureSchema(state.storage); traceBook(state.storage.sql);
      state.storage.kv.put('do_name', name);
      if (binding.telegram) state.storage.kv.put('telegram_subject', '7');
      if (binding.app) state.storage.kv.put('app_subject', String(appSubjectFor(name)));
      state.storage.kv.put('timezone', 'UTC');
      state.storage.kv.put('timezone_confirmed', true);
      const owner = new OwnerDO(state, { ...env, ...(binding.directory ? directory : {}), TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture',
        WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: binding.directory ? undefined : '7' }) as unknown as Owner;
      if (binding.telegram) await owner.setup('telegram').ready;
      if (binding.app) await owner.setup('app').ready;
      // Boot work (memory migration, the day plan) is queued behind setup; let it finish before counting the alarm's asks.
      await owner.serial(async () => undefined);
      state.storage.sql.exec('DELETE FROM schedule');
      fixture.requests = []; wire.asked = []; wire.telegramSent = [];
      await run(owner, state);
    } finally { Date.now = originalNow; await state.storage.deleteAlarm(); }
  });
};

const dueBrief = async (state: DurableObjectState) => {
  dayPlanBook(state.storage.sql).save(DAY, { card: 'card:brief', time: '00:00', reason: 'planned' });
  await new Scheduler(state.storage.sql, state.storage, productionDeps())
    .schedule({ id: 'card:brief', kind: 'brief', payloadRefs: { id: 'card:brief' }, occurrenceAt: AT - 1000, dueAt: AT - 1000, recurrence: null });
};
const dueReminder = async (state: DurableObjectState) => {
  const earlier = () => new Date(AT - 3_600_000);
  await reminderBook(state.storage.sql, new Scheduler(state.storage.sql, state.storage, productionDeps()), { timezone: 'UTC', now: earlier }, () => 'rem-1')
    .set({ note: 'call Sam', at: new Date(AT - 30 * 60_000).toISOString().slice(0, 16), repeat: 'none' });
};
const schedulePass = async (owner: Owner, state: DurableObjectState) => { state.storage.kv.put('owner_alarm_last_v1', 1); await owner.alarm(); };
const requestFor = (marker: string) => fixture.requests.find(sent => sent.includes(marker));
const armed = (state: DurableObjectState) => state.storage.sql.exec<{ id: string }>('SELECT id FROM schedule').toArray().map(row => row.id);
const admissionLog = (state: DurableObjectState) => state.storage.sql.exec<{ ok: number; note: string | null }>("SELECT ok, note FROM trace_log WHERE hop = 'scheduled_admission'").toArray();

const expectOwnerRequest = (marker: string) => {
  const request = requestFor(marker);
  expect(request).toContain(`Authenticated owner ${OWNER_PRINCIPAL}`);
  expect(request).toContain(`waldo:${OWNER_PRINCIPAL}`);
  expect(request).not.toContain(FIXTURE_PRINCIPAL);
};

describe('scheduled jobs run as the owner the directory admits', () => {
  it('a Telegram-bound owner\'s Brief and reminder compose as that owner, resolved once through the Telegram presence', async () => {
    await withOwner('jobs-telegram-owner', { telegram: true, app: false, directory: true }, async (owner, state) => {
      await dueBrief(state);
      await dueReminder(state);
      await schedulePass(owner, state);
      expectOwnerRequest('[Scheduled card');
      expectOwnerRequest('[Reminder due now');
      expect(wire.asked.filter(fn => fn === 'common_owner_authority')).toHaveLength(1);
      expect(wire.telegramSent).toEqual([CARD_TEXT]);
    });
  });

  it('a reminder for a Telegram-bound owner stays on the Telegram chain, and the next Telegram turn sees it', async () => {
    await withOwner('jobs-telegram-continuity', { telegram: true, app: false, directory: true }, async (owner, state) => {
      await dueReminder(state);
      await schedulePass(owner, state);
      expectOwnerRequest('[Reminder due now');
      const rows = [...state.storage.kv.list<{ chatId: string; ownerId: string; appPayload: string }>({ prefix: 'conv:' })].map(([, row]) => row);
      expect(rows.find(row => row.appPayload === REMINDER_TEXT)).toMatchObject({ chatId: 'telegram-7', ownerId: OWNER_PRINCIPAL });
      const { TelegramOwnerInbox } = await import('../src/channels/telegram-owner-inbox');
      const { persistInboxWake } = await import('../src/scheduler/alarm-slot');
      const inbox = new TelegramOwnerInbox(state.storage, persistInboxWake);
      await inbox.admit({ bot: '7:synthetic-fixture', subject: '7', doName: 'jobs-telegram-continuity' }, 940001,
        JSON.stringify({ update_id: 940001, message: { message_id: 940001, from: { id: 7, is_bot: false }, chat: { id: 7, type: 'private' }, text: 'Did I call Sam?' } }));
      fixture.requests = [];
      await (owner as unknown as { drainInbox(): Promise<void> }).drainInbox();
      const reply = fixture.requests.find(sent => sent.includes('Did I call Sam?') && !sent.includes('"response_format"'));
      expect(reply).toContain(`Authenticated owner ${OWNER_PRINCIPAL}`);
      expect(reply).toContain(REMINDER_TEXT);
    });
  });

  it('an app-bound owner\'s Brief composes as that owner, resolved once through the runtime authority', async () => {
    await withOwner('jobs-app-owner', { telegram: false, app: true, directory: true }, async (owner, state) => {
      await dueBrief(state);
      await schedulePass(owner, state);
      expectOwnerRequest('[Scheduled card');
      expect(wire.asked).not.toContain('common_owner_authority');
      expect(wire.asked.filter(fn => fn === 'owner_runtime_authority').length).toBeGreaterThan(0);
    });
  });

  it('an owner on both surfaces composes as the account owner', async () => {
    await withOwner('jobs-dual-owner', { telegram: true, app: true, directory: true }, async (owner, state) => {
      await dueBrief(state);
      await schedulePass(owner, state);
      expectOwnerRequest('[Scheduled card');
      expect(wire.telegramSent).toEqual([CARD_TEXT]);
    });
  });

  it('with no directory configured the fixture owner stands and nothing asks a directory', async () => {
    await withOwner('jobs-no-directory', { telegram: true, app: false, directory: false }, async (owner, state) => {
      await dueBrief(state);
      await schedulePass(owner, state);
      const request = requestFor('[Scheduled card');
      expect(request).toContain(`waldo:${FIXTURE_PRINCIPAL}`);
      expect(request).not.toContain(OWNER_PRINCIPAL);
      expect(wire.asked).toEqual([]);
      expect(wire.telegramSent).toEqual([CARD_TEXT]);
    });
  });

  it.each([
    ['Telegram-bound', { telegram: true, app: false, directory: true }, 'telegramAuthority'],
    ['app-bound', { telegram: false, app: true, directory: true }, 'runtimeAuthority'],
  ] as const)('a %s owner the directory no longer admits runs no job and keeps the job armed', async (_label, binding, authority) => {
    await withOwner(`jobs-revoked-${authority}`, binding, async (owner, state) => {
      wire[authority] = 'revoked';
      await dueBrief(state);
      await schedulePass(owner, state);
      expect(fixture.requests).toEqual([]);
      expect(wire.telegramSent).toEqual([]);
      expect(armed(state)).toContain('card:brief');
      if (binding.telegram) expect(admissionLog(state)).toEqual([{ ok: 0, note: 'dormant' }]);
    });
  });

  it('a directory outage holds a Telegram-bound owner\'s jobs, and the next pass runs them as the owner', async () => {
    await withOwner('jobs-outage', { telegram: true, app: false, directory: true }, async (owner, state) => {
      wire.telegramAuthority = 'outage';
      await dueBrief(state);
      await schedulePass(owner, state);
      expect(fixture.requests).toEqual([]);
      expect(armed(state)).toContain('card:brief');
      expect(admissionLog(state)).toEqual([{ ok: 0, note: 'retry' }]);
      wire.telegramAuthority = 'current';
      await schedulePass(owner, state);
      expectOwnerRequest('[Scheduled card');
      expect(wire.telegramSent).toEqual([CARD_TEXT]);
    });
  });
});

// A whole day of Waldo's own sends (PROACTIVE_OVER_TELEGRAM) for an owner still linked on Telegram and bound on the app and
// WhatsApp: the Brief, a reminder, a loop check-back, a task report, an update card and a Google reconnect notice each go where
// the owner chose, and none reaches Telegram. With the switch off, the same scenario reaches Telegram, so each case discriminates.
// The model is scripted per kind, the directory answers from fixtures, WhatsApp's Graph API is the wire and Telegram's sends are
// recorded; a task worker is stood in for: its start is recorded and its report is written to the job book as the worker's would be.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appSubjectFor } from '../src/channels/app-api';
import { dayPlanBook } from '../src/channels/day-cards';
import { BRIEF_SWEEP_ID } from '../src/channels/event-briefs';
import { traceBook } from '../src/channels/harness';
import { HEARTBEAT_ID } from '../src/channels/heartbeat';
import { loopBook } from '../src/channels/loops';
import { PROACTIVE_SURFACE_KEY } from '../src/channels/proactive-surface';
import { reminderBook } from '../src/channels/reminders';
import { FINAL_OUTBOX_KEY, type FinalRecord } from '../src/channels/telegram-final-outbox';
import { reconnectNoticeText } from '../src/connectors/google-reconnect';
import type { LLMGatewayRequest } from '../src/llm/provider';
import { claimStore } from '../src/memory/claims';
import { TASK_JOBS_DUE_KEY } from '../src/scheduler/alarm-slot';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';
import { jobBook, type TaskTicket } from '../src/tasks/jobs';
import { ensureSchema } from '../src/tracer/schema';
import { presenceAuthority } from './helpers/directory-presence';

// Each kind's model turn answers with its own text, so a delivery names the kind that made it.
const REPLY = 'Fixture reply: two meetings, a free hour after lunch.';
const REMINDER = 'Fixture reminder: the plants want water now.';
const CHECK_BACK = 'Fixture check-back: the supplier call happened and the notes come tomorrow.';
const REPORT = 'Fixture report: two vendors fit, vendor A is cheaper.';
const UPDATE = 'Fixture update: the planning sync moved to two.';
const EMAIL = 'owner@example.test';
const RECONNECT = reconnectNoticeText('app', EMAIL);
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete({ request }: LLMGatewayRequest) {
    const reply = (text: string) => ({ ok: true as const, data: { model: request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } });
    if (request.response_format) return reply(request.response_format.name === 'task_source_scope' ? '{"decision":"retain","sources":[]}' : '{}');
    const last = JSON.stringify(request.messages.at(-1)?.content ?? '');
    return reply(last.includes('[Reminder due now') ? REMINDER : last.includes('[Check-back due now') ? CHECK_BACK
      : last.includes('A background task you started has finished') ? REPORT : last.includes('[Update check,') ? UPDATE : REPLY);
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const telegram = vi.hoisted(() => ({ sends: [] as string[], texts: [] as string[] }));
vi.mock('../src/channels/telegram-api', async load => {
  const original = await load<typeof import('../src/channels/telegram-api')>();
  return { ...original, createTelegramCaller: () => async (method: string, payload: { chat_id?: number; text?: string }) => {
    telegram.sends.push(method);
    if (method === 'sendMessage') telegram.texts.push(payload.text ?? '');
    return method === 'sendMessage' ? { message_id: 91, chat: { id: payload.chat_id } } : method === 'getMe' ? { username: 'fixture_bot' } : true;
  } };
});
// The owner's one Google account: its reads find a moved meeting, nothing, or a grant that died (invalid_grant, then a 401).
const grant = vi.hoisted(() => ({ mode: 'quiet' as 'quiet' | 'changed' | 'dead' }));
vi.mock('../src/connectors/google', async load => {
  const original = await load<typeof import('../src/connectors/google')>();
  return { ...original, googleClient: (_app: unknown, _tokens: unknown, _fetch: unknown, health: ((error: string) => void) | undefined) => {
    const read = async <T,>(found: () => T): Promise<T> => {
      if (grant.mode === 'dead') { health?.('google token failed: invalid_grant'); throw new original.GoogleError(401, 'google token failed: invalid_grant'); }
      health?.('');
      return found();
    };
    return {
      events: () => read(() => []), newMail: () => read(() => []),
      changedEvents: () => read(() => grant.mode === 'changed'
        ? [{ id: 'event-sync', title: 'Planning sync', start: new Date(Date.now() + 3 * 3_600_000).toISOString(), end: new Date(Date.now() + 4 * 3_600_000).toISOString(), all_day: false, status: 'confirmed', created: new Date(Date.now() - 60_000).toISOString() }]
        : []),
      calendarPage: () => read(() => ({ events: [], next_page_token: null, fetched_count: 0, observed_at: new Date().toISOString() })),
    };
  } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '4b3a2918-0716-4e5d-9c4b-3a2918070605';
const WA_SUBJECT = '15550007777';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const whatsapp = { WHATSAPP_ACCESS_TOKEN: 'fictional-whatsapp-token', WHATSAPP_PHONE_NUMBER_ID: 'fictional-phone-id' };
const google = { GOOGLE_CLIENT_ID: 'synthetic-client', GOOGLE_CLIENT_SECRET: 'synthetic-secret', WALDO_OAUTH_STATE_SECRET: 'synthetic-state-secret' };
const noTelegram = { TELEGRAM_BOT_TOKEN: undefined, TELEGRAM_WEBHOOK_SECRET: undefined, WALDO_OWNER_TELEGRAM_ID: undefined };
const workers = { idFromName: (name: string) => name, get: () => ({ start: async ({ ticket }: { ticket: TaskTicket }) => { world.started.push(ticket); } }) };

const world = vi.hoisted(() => ({ texts: [] as string[], unlisted: [] as string[], started: [] as TaskTicket[] }));
beforeEach(() => {
  world.texts = []; world.unlisted = []; world.started = []; telegram.sends = []; telegram.texts = []; grant.mode = 'quiet';
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
    if (fn === 'common_owner_authority') return presenceAuthority(OWNER_ID, init?.body);
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: JSON.parse(String(init?.body)).p_do_name, state_version: 1, admission_revision: '2' });
    if (fn === 'assert_channel_presence') return Response.json(true);
    if (fn === 'health_context_read' || fn === 'health_plane' || fn === 'presence_hint') return Response.json(null);
    if (fn === 'health_log_recent' || fn === 'google_connections' || fn === 'connections_list') return Response.json([]);
    if (url === 'https://graph.facebook.com/v26.0/fictional-phone-id/messages') {
      const body = JSON.parse(String(init?.body)) as { to: string; type: string; text?: { body: string } };
      if (body.type === 'text') world.texts.push(body.text!.body);
      return Response.json({ messaging_product: 'whatsapp', contacts: [{ input: body.to, wa_id: body.to.replace(/^\+/, '') }], messages: [{ id: `wamid.out.${world.texts.length}` }] });
    }
    if (url === 'https://directory.fixture.invalid/functions/v1/connector-proxy') return Response.json({ data: [] });
    world.unlisted.push(fn ?? url);
    return new Response('unexpected', { status: 500 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

type Owner = InstanceType<typeof OwnerDO>;
const ownerOn = (name: string, identity: Record<string, string | number | boolean>, settings: Record<string, string | undefined>, work: (owner: Owner, state: DurableObjectState) => Promise<void>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (instance, state) => {
    // The pool's own OwnerDO has none of this config: a real alarm it caught would run a pass this test does not drive.
    const poolAlarm = vi.spyOn(instance as Owner, 'alarm').mockResolvedValue(undefined);
    claimStore(state.storage.sql); ensureSchema(state.storage); traceBook(state.storage.sql);
    state.storage.kv.put('do_name', name);
    for (const [key, value] of Object.entries(identity)) state.storage.kv.put(key, value);
    await state.storage.put('origin', 'https://waldo.fixture.invalid');
    const owner = new OwnerDO(state, { ...env, ...directory, ...whatsapp, ...google, ...noTelegram, TASK_WORKER_DO: workers, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', ...settings } as never);
    try { await work(owner, state); } finally { await state.storage.deleteAlarm(); poolAlarm.mockRestore(); }
  });

const TELEGRAM = { TELEGRAM_BOT_TOKEN: '7:synthetic-fixture' };
const ON = { OWNER_SURFACE_DEFAULT: '1', PROACTIVE_OVER_TELEGRAM: '1', ...TELEGRAM }, OFF = { OWNER_SURFACE_DEFAULT: '1', ...TELEGRAM };
const linked = (name: string, extra: Record<string, string | number | boolean> = {}) =>
  ({ telegram_subject: '7', app_subject: String(appSubjectFor(name)), timezone: 'UTC', timezone_confirmed: true, ...extra });
const withWhatsApp = { whatsapp_subject: WA_SUBJECT, wa_last_inbound_ms: Date.now() - 60 * 60_000 };
const appRows = (state: DurableObjectState) => JSON.stringify([...state.storage.kv.list({ prefix: 'canonical-owner-v1:' })]);

// Alarm passes, each followed by the outbox's quarter-second hold on a new record running out.
const passes = async (owner: Owner, state: DurableObjectState, count: number) => {
  const kv = state.storage.kv;
  for (let pass = 0; pass < count; pass++) {
    await owner.alarm(); await state.storage.deleteAlarm();
    await new Promise(resolve => setTimeout(resolve, 100));
    kv.put(FINAL_OUTBOX_KEY, (kv.get<FinalRecord[]>(FINAL_OUTBOX_KEY) ?? []).map(record => ({ ...record, dueAt: Math.min(record.dueAt, Date.now() - 1) })));
  }
};
const schedulerOf = (state: DurableObjectState) => new Scheduler(state.storage.sql, state.storage, productionDeps());
const FOUND = { status: 'done' as const, summary: 'Checked.', findings: [{ text: 'The supplier wrote after the call: notes come tomorrow.', source_ref: 'msg-9' }], proposals: [], left: [] };
// Every worker the jobs lane started reports what it found; the next pass applies it.
const reportWorkers = async (state: DurableObjectState): Promise<number> => {
  const book = jobBook(state.storage.sql, { now: Date.now, newId: () => crypto.randomUUID().slice(0, 12), newToken: () => crypto.randomUUID() });
  const accepted = world.started.splice(0).filter(ticket => book.report(ticket, FOUND, { rounds: 1, costUsd: 0 }) === 'accepted').length;
  await state.storage.put(TASK_JOBS_DUE_KEY, Date.now());
  return accepted;
};
// Waits for the work the runtime's boot queued behind the object's serial order (the day plan that arms the cards).
const booted = async (owner: Owner, surface: 'app' | 'whatsapp') => {
  const inner = owner as unknown as { setup(channel: string): { ready: Promise<unknown> }; serial(work: () => Promise<void>): Promise<void> };
  await inner.setup(surface).ready;
  await new Promise(resolve => setTimeout(resolve, 50));
  await inner.serial(async () => undefined);
};

type Kind = 'brief' | 'reminder' | 'checkBack' | 'taskReport' | 'update' | 'reconnect';
// Each kind sets itself up in a fresh owner object and runs the passes that take it to the owner.
const KINDS: Readonly<Record<Kind, Readonly<{ text: string; run(owner: Owner, state: DurableObjectState): Promise<void> }>>> = {
  brief: { text: REPLY, run: async (owner, state) => {
    await booted(owner, state.storage.kv.get(PROACTIVE_SURFACE_KEY) === 'whatsapp' ? 'whatsapp' : 'app');
    const today = new Date().toISOString().slice(0, 10);
    dayPlanBook(state.storage.sql).save(today, { card: 'card:brief', time: '00:00', reason: 'planned by the fixture' });
    await schedulerOf(state).schedule({ id: 'card:brief', kind: 'brief', payloadRefs: { id: 'card:brief' }, occurrenceAt: Date.now() - 1000, dueAt: Date.now() - 1000, recurrence: null });
    await passes(owner, state, 4);
    // The card counts as sent only once its surface reports arrival (WhatsApp's status webhook), so only the run is checked here.
    expect(state.storage.sql.exec("SELECT id FROM schedule WHERE id = 'card:brief' AND status = 'armed' AND due_at <= ?", Date.now()).toArray()).toEqual([]);
  } },
  reminder: { text: REMINDER, run: async (owner, state) => {
    await reminderBook(state.storage.sql, schedulerOf(state), { timezone: 'UTC', now: () => new Date(Date.now() - 3_600_000) }, () => 'rem-day')
      .set({ note: 'water the plants', at: new Date(Date.now() - 30 * 60_000).toISOString().slice(0, 16), repeat: 'none' });
    await passes(owner, state, 4);
    expect(state.storage.sql.exec<{ status: string }>("SELECT status FROM schedule WHERE kind = 'reminder'").toArray().map(row => row.status)).not.toContain('armed');
  } },
  // A past-due loop: the heartbeat tick writes a reader job, its worker reports a finding, and the apply turn writes the check-back.
  checkBack: { text: CHECK_BACK, run: async (owner, state) => {
    loopBook(state.storage.sql, { now: Date.now, newId: () => 'supplier' }).open({ title: 'Check how the supplier call went', due: '2026-01-01T09:00' });
    await schedulerOf(state).schedule({ id: HEARTBEAT_ID, kind: 'heartbeat', payloadRefs: { id: HEARTBEAT_ID }, occurrenceAt: Date.now() - 1, dueAt: Date.now() - 1 });
    for (let pass = 0; pass < 4 && world.started.length === 0; pass++) await passes(owner, state, 1);
    expect(await reportWorkers(state)).toBe(1);
    await passes(owner, state, 5);
  } },
  // A background task the owner started, finished by its worker: the jobs lane tells the owner once.
  taskReport: { text: REPORT, run: async (owner, state) => {
    const book = jobBook(state.storage.sql, { now: Date.now, newId: () => 'a1b2c3d4e5f6', newToken: () => 'tok-day' });
    const brief = { title: 'Vendor research', goal: 'Compare the two vendors on price.', context: 'Synthetic vendors A and B.', done_when: 'A short comparison.', effort: 'standard' as const, timezone: 'UTC', started_at: Date.now() };
    const { job } = book.create({ kind: 'task', profile: 'reader', idempotencyKey: 'app-turn:day', origin: 'app-turn', surface: 'app', brief, dueAt: Date.now(), deadlineAt: Date.now() + 3_600_000 });
    expect(book.report(book.startAttempt(job.id)!, { status: 'done', summary: 'Vendor A is cheaper.', findings: [{ text: 'Vendor B ships faster.' }], proposals: [], left: [] }, { rounds: 1, costUsd: 0 })).toBe('accepted');
    await state.storage.put(TASK_JOBS_DUE_KEY, Date.now());
    await passes(owner, state, 5);
    expect(book.get(job.id)!.status).toBe('applied');
  } },
  // The event-brief sweep's update check: the first sweep seeds the cursors, the second finds a moved meeting and writes a job.
  update: { text: UPDATE, run: async (owner, state) => {
    await state.storage.put('google:accounts', [{ id: `local:${EMAIL}`, email: EMAIL, refresh_token: 'synthetic-offline-only', scopes: ['https://www.googleapis.com/auth/calendar.events'] }]);
    for (const mode of ['quiet', 'changed'] as const) {
      grant.mode = mode;
      await schedulerOf(state).schedule({ id: BRIEF_SWEEP_ID, kind: 'pre_activity_spot', payloadRefs: { id: BRIEF_SWEEP_ID }, occurrenceAt: Date.now() - 1, dueAt: Date.now() - 1, recurrence: null });
      for (let pass = 0; pass < 4 && state.storage.sql.exec("SELECT id FROM schedule WHERE id = ? AND status = 'armed' AND due_at <= ?", BRIEF_SWEEP_ID, Date.now()).toArray().length; pass++) await passes(owner, state, 1);
    }
    for (let pass = 0; pass < 4 && world.started.length === 0; pass++) await passes(owner, state, 1);
    expect(await reportWorkers(state)).toBe(1);
    await passes(owner, state, 5);
  } },
  // A scheduled read on a grant that died queues one reconnect notice for the owner.
  reconnect: { text: RECONNECT, run: async (owner, state) => {
    await state.storage.put('google:accounts', [{ id: `local:${EMAIL}`, email: EMAIL, refresh_token: 'synthetic-offline-only', scopes: ['https://www.googleapis.com/auth/calendar.events'] }]);
    for (const mode of ['quiet', 'dead'] as const) {
      grant.mode = mode;
      await schedulerOf(state).schedule({ id: BRIEF_SWEEP_ID, kind: 'pre_activity_spot', payloadRefs: { id: BRIEF_SWEEP_ID }, occurrenceAt: Date.now() - 1, dueAt: Date.now() - 1, recurrence: null });
      for (let pass = 0; pass < 4 && state.storage.sql.exec("SELECT id FROM schedule WHERE id = ? AND status = 'armed' AND due_at <= ?", BRIEF_SWEEP_ID, Date.now()).toArray().length; pass++) await passes(owner, state, 1);
    }
    await vi.waitFor(() => expect(Object.keys(state.storage.kv.get<Record<string, number>>('google:reauth-noticed') ?? {})).toEqual([`local:${EMAIL}`]), { timeout: 5_000, interval: 20 });
    await passes(owner, state, 4);
  } },
};
const ALL = Object.keys(KINDS) as Kind[];
// Choice "both" copies to WhatsApp what the scheduled pass delivers and the outbox records it marks as copied: a check-back,
// an update card, a task report and a reconnect notice. Meeting prep and pause notices stay in the app.
const COPIED: ReadonlySet<Kind> = new Set(['brief', 'reminder', 'checkBack', 'update', 'taskReport', 'reconnect']);
const inApp = (state: DurableObjectState, text: string) => appRows(state).includes(JSON.stringify(text).slice(1, -1));
const onWhatsApp = (text: string) => world.texts.some(sent => sent.includes(text));

describe('a day of Waldo\'s own sends for an owner still linked on Telegram, with the switch on', { timeout: 60_000 }, () => {
  it('Brief, reminder, check-back, task report and reconnect notice all reach the app (and WhatsApp where copied) with choice both, and nothing reaches Telegram', async () => {
    const name = 'day-both-full';
    await ownerOn(name, linked(name, { ...withWhatsApp, [PROACTIVE_SURFACE_KEY]: 'both' }), ON, async (owner, state) => {
      for (const kind of ['brief', 'reminder', 'checkBack', 'taskReport', 'reconnect'] as const) await KINDS[kind].run(owner, state);
      for (const kind of ['brief', 'reminder', 'checkBack', 'taskReport', 'reconnect'] as const) {
        expect(inApp(state, KINDS[kind].text), `${kind} in the app transcript`).toBe(true);
        if (COPIED.has(kind)) expect(onWhatsApp(KINDS[kind].text), `${kind} on WhatsApp`).toBe(true);
      }
      expect(telegram.sends).toEqual([]);
    });
  });

  it.each(ALL)('%s: choice both reaches the app (and WhatsApp where copied), and nothing reaches Telegram', async kind => {
    const name = `day-both-${kind}`;
    await ownerOn(name, linked(name, { ...withWhatsApp, [PROACTIVE_SURFACE_KEY]: 'both' }), ON, async (owner, state) => {
      await KINDS[kind].run(owner, state);
      expect(inApp(state, KINDS[kind].text), 'in the app transcript').toBe(true);
      if (COPIED.has(kind)) expect(onWhatsApp(KINDS[kind].text), 'on WhatsApp').toBe(true);
      expect(telegram.sends).toEqual([]);
    });
  });

  it.each(ALL)('%s: choice app reaches the app transcript only, and nothing reaches Telegram', async kind => {
    const name = `day-app-${kind}`;
    await ownerOn(name, linked(name, { ...withWhatsApp, [PROACTIVE_SURFACE_KEY]: 'app' }), ON, async (owner, state) => {
      await KINDS[kind].run(owner, state);
      expect(inApp(state, KINDS[kind].text), 'in the app transcript').toBe(true);
      expect(onWhatsApp(KINDS[kind].text), 'on WhatsApp').toBe(false);
      expect(telegram.sends).toEqual([]);
    });
  });

  it.each(ALL)('%s: choice whatsapp reaches WhatsApp only, and nothing reaches Telegram', async kind => {
    const name = `day-whatsapp-${kind}`;
    await ownerOn(name, linked(name, { ...withWhatsApp, [PROACTIVE_SURFACE_KEY]: 'whatsapp' }), ON, async (owner, state) => {
      await KINDS[kind].run(owner, state);
      expect(onWhatsApp(KINDS[kind].text), 'on WhatsApp').toBe(true);
      expect(inApp(state, KINDS[kind].text), 'in the app transcript').toBe(false);
      expect(telegram.sends).toEqual([]);
    });
  });
});

describe('the same day with the switch off', { timeout: 60_000 }, () => {
  it.each(ALL)('%s still reaches Telegram', async kind => {
    const name = `day-off-${kind}`;
    await ownerOn(name, linked(name, { ...withWhatsApp, [PROACTIVE_SURFACE_KEY]: 'both' }), OFF, async (owner, state) => {
      await KINDS[kind].run(owner, state);
      expect(telegram.sends).toContain('sendMessage');
      expect(telegram.texts.some(text => text.includes(KINDS[kind].text))).toBe(true);
    });
  });
});

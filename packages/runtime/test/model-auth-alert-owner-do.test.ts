import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LLMGatewayAdapter } from '../src/llm/provider';
import { appSubjectFor } from '../src/channels/app-api';
import { dayPlanBook } from '../src/channels/day-cards';
import { traceBook } from '../src/channels/harness';
import { claimStore } from '../src/memory/claims';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';
import { ensureSchema } from '../src/tracer/schema';
import { MODEL_AUTH_NOTICE } from '../src/scheduler/failure-notice';

// A provider that refuses Waldo's key is told to the owner once per incident, however many calls meet it.
const model = vi.hoisted(() => ({ down: false, calls: 0 }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway: LLMGatewayAdapter = { async complete(request) {
    const content = String(request.request.messages.at(-1)?.content ?? '');
    if (!content.includes('[Scheduled card')) return { ok: true, data: { model: request.request.model, text: 'SKIP', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
    model.calls += 1;
    if (model.down) return { ok: false, code: 'auth_failed', error: 'synthetic provider refused the key (401)' };
    return { ok: true, data: { model: request.request.model, text: 'Your morning is clear until noon.', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f';
const AT = Date.parse('2026-10-03T09:00:00Z');
const DAY = '2026-10-03';
const HASH = 'b'.repeat(64);
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };

beforeEach(() => {
  model.down = false;
  model.calls = 0;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    if (fn === 'console_session_inventory') return Response.json([{ session: HASH, created_at: new Date(AT - 60_000).toISOString(), last_seen_at: new Date(AT).toISOString(), expires_at: new Date(AT - 60_000 + 12 * 60 * 60_000).toISOString(), rotated_to: null, signed_in_at: new Date(AT - 60_000).toISOString() }]);
    if (fn === 'health_log_recent') return Response.json([]);
    if (fn === 'health_context_read') return Response.json(null);
    if (fn === 'assert_channel_presence') return Response.json(false);
    return Response.json(true);
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

type Act = (action: { action: string; id?: string; value?: string }) => Promise<unknown>;
type Owner = Readonly<{ setup(channel: string): { ready: Promise<unknown>; act: Act }; fetch(request: Request): Promise<Response>; alarm(): Promise<void> }>;
type AppDay = Readonly<{ revision: string; cards: readonly Record<string, unknown>[] }>;
type Day = Readonly<{
  appDay(contract?: string): Promise<AppDay>; appAction(body: Record<string, string>): Promise<{ status: number; body: { receipt?: { state: string } } }>;
  act: Act; alarm(): Promise<void>; at(ms: number): void; chatRows(): Promise<number>; chatTexts(): Promise<string[]>;
  brief(): { state?: string } | undefined; row(): { status: string; attempts: number } | undefined; sql: SqlStorage; storage: DurableObjectStorage;
}>;

// An app-only owner whose Brief comes due now and runs once on the first alarm.
const withBriefDue = (name: string, work: (day: Day) => Promise<void>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const originalNow = Date.now;
    let clock = AT;
    Date.now = () => clock;
    try {
      claimStore(state.storage.sql); ensureSchema(state.storage); traceBook(state.storage.sql);
      state.storage.kv.put('do_name', name);
      state.storage.kv.put('app_subject', String(appSubjectFor(name)));
      state.storage.kv.put('timezone', 'UTC');
      state.storage.kv.put('timezone_confirmed', true);
      const owner = new OwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC',
        WALDO_OWNER_TELEGRAM_ID: undefined }) as unknown as Owner;
      const app = owner.setup('app');
      await app.ready;
      state.storage.sql.exec('DELETE FROM schedule');
      dayPlanBook(state.storage.sql).save(DAY, { card: 'card:brief', time: '00:00', reason: 'planned' });
      await new Scheduler(state.storage.sql, state.storage, productionDeps())
        .schedule({ id: 'card:brief', kind: 'brief', payloadRefs: { id: 'card:brief' }, occurrenceAt: AT - 1000, dueAt: AT - 1000, recurrence: null });
      const headers = { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': HASH };
      await work({
        appDay: async contract => {
          const read = await owner.fetch(new Request('https://telegram-owner/app/v1/controls?view=day', { headers: { ...headers, ...(contract ? { 'x-waldo-app-contract': contract } : {}) } }));
          const body = await read.json() as { revision: string; data: { cards: Record<string, unknown>[] } };
          return { revision: body.revision, cards: body.data.cards };
        },
        appAction: async body => {
          const posted = await owner.fetch(new Request('https://telegram-owner/app/v1/actions', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
          return { status: posted.status, body: await posted.json() as { receipt?: { state: string } } };
        },
        act: action => app.act({ id: '', value: '', ...action }),
        alarm: async () => { state.storage.kv.put('owner_alarm_last_v1', 1); await owner.alarm(); },
        at: ms => { clock = ms; },
        chatTexts: async () => ((await (await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main', { headers }))).json()) as { messages: { text?: string; parts?: { type: string; text?: string }[] }[] }).messages
          .map(message => message.text ?? (message.parts ?? []).map(part => part.text ?? '').join('')),
        chatRows: async () => ((await (await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main', { headers }))).json()) as { messages: unknown[] }).messages.length,
        brief: () => dayPlanBook(state.storage.sql).read(DAY).find(row => row.card === 'card:brief'),
        row: () => state.storage.sql.exec<{ status: string; attempts: number }>("SELECT status, attempts FROM schedule WHERE id = 'card:brief'").toArray()[0],
        sql: state.storage.sql,
        storage: state.storage,
      });
    } finally { Date.now = originalNow; await state.storage.deleteAlarm(); }
  });

it('tells the owner once per incident, through every probe of the outage, and again after the key was replaced and refused anew', async () => {
  await withBriefDue('model-auth-alert', async (day) => {
    model.down = true;
    for (let probe = 0; probe < 4; probe += 1) { day.at(AT + probe * 15 * 60_000); await day.alarm(); await day.alarm(); }
    expect((await day.chatTexts()).filter(text => text.includes(MODEL_AUTH_NOTICE))).toHaveLength(1);
    model.down = false;
    day.at(AT + 4 * 15 * 60_000);
    await day.alarm(); await day.alarm();
    expect(day.brief()?.state).toBe('sent');
    model.down = true;
    day.at(AT + 5 * 15 * 60_000);
    await new Scheduler(day.sql, day.storage, productionDeps())
      .schedule({ id: 'card:midday', kind: 'brief', payloadRefs: { id: 'card:midday' }, occurrenceAt: Date.now(), dueAt: Date.now(), recurrence: null });
    for (let pass = 0; pass < 4; pass += 1) { day.at(AT + 5 * 15 * 60_000 + pass * 60_000); await day.alarm(); }
    expect((await day.chatTexts()).filter(text => text.includes(MODEL_AUTH_NOTICE))).toHaveLength(2);
  });
});

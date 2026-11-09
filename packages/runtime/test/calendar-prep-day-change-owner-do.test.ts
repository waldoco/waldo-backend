import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CalendarItem } from '../src/connectors/google';
import type { LLMGatewayAdapter } from '../src/llm/provider';
import { appSubjectFor } from '../src/channels/app-api';
import { BRIEF_SWEEP_ID } from '../src/channels/event-briefs';
import { updateBook, type Change } from '../src/channels/update-cards';
import { traceBook } from '../src/channels/harness';
import { claimStore } from '../src/memory/claims';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';
import { ensureSchema } from '../src/tracer/schema';

// A meeting just after the owner's midnight, judged at 23:45 to need no note, is judged again when its own day changes,
// not the day the sweep runs on.
const OWNER_ID = '3a4b5c6d-7e8f-4a0b-8c1d-2e3f4a5b6c7d';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const fixture = vi.hoisted(() => ({ event: null as CalendarItem | null, asked: 0 }));
vi.mock('../src/connectors/google', async load => {
  const original = await load<typeof import('../src/connectors/google')>();
  return { ...original, googleClient: (_app: unknown, _tokens: unknown, _fetch: unknown, _health: unknown, account: unknown) => ({
    account, events: async () => fixture.event ? [fixture.event] : [],
    calendarPage: async () => ({ events: fixture.event ? [fixture.event] : [], next_page_token: null, fetched_count: 1, account, observed_at: new Date().toISOString() }),
    event: async () => fixture.event, changedEvents: async () => [], newMail: async () => [],
  }) };
});
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway: LLMGatewayAdapter = { async complete(request) {
    const prep = request.request.response_format?.name === 'calendar_prep';
    if (prep) fixture.asked += 1;
    return { ok: true, data: { model: request.request.model, text: prep ? JSON.stringify({ kind: 'no_op', text: '' }) : 'SKIP', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

beforeEach(() => {
  fixture.asked = 0;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(String(input instanceof Request ? input.url : input))?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'app_push_targets') return Response.json([]);
    if (fn === 'health_context_read' || fn === 'health_log_recent') return Response.json(fn === 'health_log_recent' ? [] : null);
    return Response.json(true);
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

type Owner = Readonly<{ setup(channel: string): { ready: Promise<unknown> }; alarm(): Promise<void> }>;
const moved = (start: string, end: string): Change => ({ source: 'calendar', kind: 'changed', detail: JSON.stringify({ id: 'e9', title: 'Moved', start, end, all_day: false }), ref: 'event:e9' });

it.each([
  { name: 'a change on the meeting\'s own day (tomorrow) reopens it', change: moved('2026-10-04T03:30:00Z', '2026-10-04T04:00:00Z'), asked: 2 },
  { name: 'a change on the sweep\'s day (today) leaves it as judged', change: moved('2026-10-03T12:30:00Z', '2026-10-03T13:00:00Z'), asked: 1 },
])('$name', async ({ change, asked }) => {
  const name = `prep-day-change-${asked}`;
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const originalNow = Date.now;
    // 23:45 in Kolkata; the meeting starts at 00:10 the next local day.
    let now = Date.parse('2026-10-03T18:15:00Z');
    Date.now = () => now;
    fixture.event = { id: 'event-1', title: 'Late sync', status: 'confirmed', start: '2026-10-04T00:10:00+05:30', end: '2026-10-04T00:40:00+05:30', all_day: false, etag: 'r1' };
    try {
      claimStore(state.storage.sql); ensureSchema(state.storage); traceBook(state.storage.sql);
      state.storage.kv.put('do_name', name);
      state.storage.kv.put('app_subject', String(appSubjectFor(name)));
      state.storage.kv.put('timezone', 'Asia/Kolkata');
      state.storage.kv.put('timezone_confirmed', true);
      await state.storage.put('origin', 'https://fixture.invalid');
      await state.storage.put('google:accounts', [{ id: 'local:owner@example.test', email: 'owner@example.test', refresh_token: 'synthetic-offline-only', scopes: ['https://www.googleapis.com/auth/calendar.events'] }]);
      const owner = new OwnerDO(state, { ...env, ...directory, CALENDAR_GROUNDED_PREP: '1', TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture',
        WALDO_OWNER_TIMEZONE: 'Asia/Kolkata', WALDO_OWNER_TELEGRAM_ID: undefined, GOOGLE_CLIENT_ID: 'synthetic-client', GOOGLE_CLIENT_SECRET: 'synthetic-secret' }) as unknown as Owner;
      await owner.setup('app').ready;
      const sweep = async () => {
        state.storage.sql.exec('DELETE FROM schedule');
        await new Scheduler(state.storage.sql, state.storage, productionDeps())
          .schedule({ id: BRIEF_SWEEP_ID, kind: 'pre_activity_spot', payloadRefs: { id: BRIEF_SWEEP_ID }, occurrenceAt: now - 1000, dueAt: now - 1000, recurrence: null });
        state.storage.kv.put('owner_alarm_last_v1', 0);
        await owner.alarm();
      };
      await sweep();
      expect(fixture.asked).toBe(1);
      now += 60_000;
      updateBook(state.storage.sql).record('2026-10-03', now, [change], null);
      now += 60_000;
      await sweep();
      expect(fixture.asked).toBe(asked);
    } finally { Date.now = originalNow; await state.storage.deleteAlarm(); }
  });
});

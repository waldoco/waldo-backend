import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CalendarItem } from '../src/connectors/google';
import type { LLMGatewayAdapter } from '../src/llm/provider';
import { appSubjectFor } from '../src/channels/app-api';
import { BRIEF_SWEEP_ID } from '../src/channels/event-briefs';
import { FINAL_OUTBOX_KEY, type FinalRecord } from '../src/channels/telegram-final-outbox';
import { traceBook } from '../src/channels/harness';
import { claimStore } from '../src/memory/claims';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';
import { ensureSchema } from '../src/tracer/schema';

// An app owner's prep note, run by the alarm: it reaches Main chat, then raises its own push. The push names the meeting only
// while PREP_PUSH_NAMES is on; it never carries an attendee's address or the note's own text.
const NOTE = 'Design review at 10:30 IST with pat@example.test. Bring the onboarding mocks.';
const EXPO_TOKEN = 'ExponentPushToken[synthetic-fixture-token]';
const INSTALLATION = '0f1e2d3c-4b5a-4968-8776-655443322110';
const OWNER_ID = '3a4b5c6d-7e8f-4a0b-8c1d-2e3f4a5b6c7d';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const fixture = vi.hoisted(() => ({ event: null as CalendarItem | null }));
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
    return { ok: true, data: { model: request.request.model, text: prep ? JSON.stringify({ kind: 'notify', text: NOTE }) : 'SKIP', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const wire = { pushes: [] as { body: string; data: unknown }[] };
beforeEach(() => {
  wire.pushes = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'app_push_targets') return Response.json([{ installation_id: INSTALLATION, device_epoch: 4, token: EXPO_TOKEN }]);
    if (fn === 'health_context_read') return Response.json(null);
    if (fn === 'health_log_recent') return Response.json([]);
    if (url === 'https://exp.host/--/api/v2/push/send') {
      for (const message of JSON.parse(String(init?.body)) as { body: string; data: unknown }[]) wire.pushes.push({ body: message.body, data: message.data });
      return Response.json({ data: [{ status: 'ok', id: 'ticket-1' }] });
    }
    return Response.json(true);
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

type Owner = Readonly<{ setup(channel: string): { ready: Promise<unknown> }; alarm(): Promise<void> }>;

it.each([
  { names: undefined, body: 'Waldo has a note before your next meeting' },
  { names: '1', body: 'Prep: Design review at 10:30' },
])('an app owner\'s delivered prep note raises the prep push (PREP_PUSH_NAMES=$names)', async ({ names, body }) => {
  const name = `push-prep-app-${names ?? 'off'}`;
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const originalNow = Date.now;
    let now = Date.parse('2026-10-03T04:30:00Z');
    Date.now = () => now;
    fixture.event = { id: 'event-1', title: 'Design review', status: 'confirmed', start: '2026-10-03T10:30:00+05:30', end: '2026-10-03T11:00:00+05:30', all_day: false,
      description: 'Bring the onboarding mocks', etag: 'r1', attendee_emails: ['pat@example.test'] };
    try {
      claimStore(state.storage.sql); ensureSchema(state.storage); traceBook(state.storage.sql);
      state.storage.kv.put('do_name', name);
      state.storage.kv.put('app_subject', String(appSubjectFor(name)));
      state.storage.kv.put('timezone', 'Asia/Kolkata');
      state.storage.kv.put('timezone_confirmed', true);
      await state.storage.put('origin', 'https://fixture.invalid');
      await state.storage.put('google:accounts', [{ id: 'local:owner@example.test', email: 'owner@example.test', refresh_token: 'synthetic-offline-only', scopes: ['https://www.googleapis.com/auth/calendar.events'] }]);
      const owner = new OwnerDO(state, { ...env, ...directory, CALENDAR_GROUNDED_PREP: '1', PREP_PUSH_NAMES: names, TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture',
        WALDO_OWNER_TIMEZONE: 'Asia/Kolkata', WALDO_OWNER_TELEGRAM_ID: undefined, EXPO_ACCESS_TOKEN: 'synthetic-expo-access', GOOGLE_CLIENT_ID: 'synthetic-client', GOOGLE_CLIENT_SECRET: 'synthetic-secret' }) as unknown as Owner;
      await owner.setup('app').ready;
      state.storage.sql.exec('DELETE FROM schedule');
      await new Scheduler(state.storage.sql, state.storage, productionDeps())
        .schedule({ id: BRIEF_SWEEP_ID, kind: 'pre_activity_spot', payloadRefs: { id: BRIEF_SWEEP_ID }, occurrenceAt: now - 1000, dueAt: now - 1000, recurrence: null });
      state.storage.kv.put('owner_alarm_last_v1', 1);
      await owner.alarm();
      const prep = () => (state.storage.kv.get<FinalRecord[]>(FINAL_OUTBOX_KEY) ?? []).filter(record => record.calendarPrep);
      expect(prep()).toHaveLength(1);
      expect(wire.pushes).toEqual([]);
      now += 1000;
      state.storage.kv.put('owner_alarm_last_v1', 0);
      await owner.alarm();
      expect(prep()[0]?.status).toBe('delivered');
      expect(prep()[0]?.settled).toBe(true);
      // The push runs beside the drain, so it may land after the alarm returns.
      await vi.waitFor(() => expect(wire.pushes).toHaveLength(1));
      expect(wire.pushes).toEqual([{ body, data: { trigger: 'pre_activity_spot' } }]);
      expect(JSON.stringify(wire.pushes)).not.toContain('pat@example.test');
      expect(JSON.stringify(wire.pushes)).not.toContain('onboarding mocks');
    } finally { Date.now = originalNow; await state.storage.deleteAlarm(); }
  });
});

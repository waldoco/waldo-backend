import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import type { LLMGatewayAdapter } from '../src/llm/provider';
import type { CalendarChange } from '../src/connectors/google';
import { dayPlanBook } from '../src/channels/day-cards';
import { BRIEF_SWEEP_ID } from '../src/channels/event-briefs';
import { updateBook } from '../src/channels/update-cards';
import { Scheduler } from '../src/scheduler/multiplexer';
import { presenceAuthority } from './helpers/directory-presence';

const UPDATE_TEXT = 'Synthetic update text.';
const fixture = vi.hoisted(() => ({ changes: [] as CalendarChange[], requests: [] as string[], sent: [] as string[] }));
vi.mock('../src/connectors/google', async load => {
  const original = await load<typeof import('../src/connectors/google')>();
  return { ...original, googleClient: (_app: unknown, _tokens: unknown, _fetch: unknown, _health: unknown, account: unknown) => ({
    account, events: async () => [], calendarPage: async () => ({ events: [], next_page_token: null, fetched_count: 0, account, observed_at: new Date().toISOString() }),
    event: async () => null, changedEvents: async () => fixture.changes, newMail: async () => [],
  }) };
});
vi.mock('../src/channels/telegram-api', async load => {
  const original = await load<typeof import('../src/channels/telegram-api')>();
  return { ...original, createTelegramCaller: () => async (method: string, payload: { chat_id?: number; text?: string }) => {
    if (method !== 'sendMessage') return true;
    fixture.sent.push(payload.text ?? '');
    return { message_id: 91, chat: { id: payload.chat_id } };
  } };
});
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway: LLMGatewayAdapter = { async complete(request) {
    fixture.requests.push(JSON.stringify(request.request));
    const name = request.request.response_format?.name;
    const text = name === 'task_source_scope' ? '{"decision":"retain","sources":[]}'
      : name === 'claim_ops' ? JSON.stringify({ add: [], corrections: [], seen: [], confirm: [], dismiss: [], forget_claims: [], forget_nodes: [] })
      : UPDATE_TEXT;
    return { ok: true, data: { model: request.request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
afterEach(() => { vi.unstubAllGlobals(); });

// Every stored copy in the owner DO: KV values and the rows of every table it can read.
const storedText = (state: DurableObjectState) => {
  const kv = [...state.storage.kv.list()].map(([key, value]) => `${key} ${JSON.stringify(value)}`);
  const tables = state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'").toArray().map(row => row.name);
  return [...kv, ...tables.flatMap(table => state.storage.sql.exec(`SELECT * FROM "${table}"`).toArray().map(row => JSON.stringify(row)))].join('\n');
};

it('an update card is written with the owner\'s health logs, no stored copy of its prompt carries their numbers, and /ledger still shows them', async () => {
  const name = 'update-card-health-strip';
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const originalNow = Date.now;
    const at = Date.parse('2026-10-03T08:05:00Z');
    Date.now = () => at;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(String(input instanceof Request ? input.url : input))?.[1];
      if (fn === 'health_log_recent') return Response.json([
        { id: 1, kind: 'meal', logged_at: new Date(at - 3_600_000).toISOString(), payload: { description: 'oat bowl', calories_estimate: 640 } },
        { id: 2, kind: 'workout', logged_at: new Date(at - 3_600_000).toISOString(), payload: { type: 'run', duration_minutes: 37 } },
      ]);
      if (fn === 'health_context_read') return Response.json(null);
      if (fn === 'common_owner_authority') return presenceAuthority('5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d', init?.body);
      return Response.json(true);
    });
    try {
      const owner = new OwnerDO(state, { ...env, ...directory, WALDO_OWNER_TELEGRAM_ID: '7', WALDO_OWNER_TIMEZONE: 'UTC', TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', GOOGLE_CLIENT_ID: 'synthetic-client', GOOGLE_CLIENT_SECRET: 'synthetic-secret' });
      state.storage.kv.put('do_name', name); state.storage.kv.put('telegram_subject', '7');
      await state.storage.put('origin', 'https://fixture.invalid');
      await state.storage.put('google:accounts', [{ id: 'local:owner@example.test', email: 'owner@example.test', refresh_token: 'synthetic-offline-only', scopes: ['https://www.googleapis.com/auth/calendar.events'] }]);
      await owner.alarm();
      state.storage.sql.exec('DELETE FROM schedule');
      dayPlanBook(state.storage.sql).sent('2026-10-03', 'card:brief');
      const updates = updateBook(state.storage.sql);
      updates.mark('calendar_since', at - 3600_000); updates.mark('mail_since', at - 3600_000);
      fixture.changes = [{ id: 'event-1', title: 'Changed event', status: 'confirmed', start: '2026-10-03T10:30:00Z', end: '2026-10-03T11:00:00Z', all_day: false, description: '', etag: 'r1', created: new Date(at - 86400_000).toISOString(), updated: new Date(at).toISOString() } as CalendarChange];
      fixture.requests = [];
      const scheduler = new Scheduler(state.storage.sql, state.storage, { now: () => at, newRunId: () => 'r', newOutboxId: () => 'o', sha256Hex: async () => 's' });
      await scheduler.schedule({ id: BRIEF_SWEEP_ID, kind: 'pre_activity_spot', payloadRefs: { id: BRIEF_SWEEP_ID }, occurrenceAt: at - 1000, dueAt: at - 1000 });
      state.storage.kv.put('owner_alarm_last_v1', 0);
      await owner.alarm();
      expect(state.storage.sql.exec('SELECT pushed FROM update_cards').toArray()).toEqual([{ pushed: 1 }]);
      const update = fixture.requests.find(request => request.includes('Changed event'));
      expect(update).toContain('~640 kcal, estimate');
      expect(update).toContain('run, 37 min');
      const stored = storedText(state);
      expect(stored).toContain('Changed event');
      expect(stored).not.toContain('640 kcal');
      expect(stored).not.toContain('37 min');
      fixture.sent = [];
      const ledger = await owner.fetch(new Request('https://owner.invalid/turn', { method: 'POST', body: JSON.stringify({ update_id: 500, message: { message_id: 500, from: { id: 7, is_bot: false }, chat: { id: 7, type: 'private' }, text: '/ledger' } }) }));
      expect(ledger.status).toBe(200);
      expect(fixture.sent.join('\n')).toContain('~640 kcal, estimate');
    } finally { Date.now = originalNow; await state.storage.deleteAlarm(); }
  });
});

import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import type { LLMGatewayAdapter } from '../src/llm/provider';
import type { CalendarChange } from '../src/connectors/google';
import { dayPlanBook } from '../src/channels/day-cards';
import { BRIEF_SWEEP_ID } from '../src/channels/event-briefs';
import { updateBook } from '../src/channels/update-cards';
import { Scheduler } from '../src/scheduler/multiplexer';

// The update card is stored as pushed only once Telegram acknowledged the send; a blocked send (unlinked or
// rebound owner) returns no message.
const fixture = vi.hoisted(() => ({ sends: 0, blocked: true, changes: [] as CalendarChange[] }));
vi.mock('../src/connectors/google', async load => {
  const original = await load<typeof import('../src/connectors/google')>();
  return { ...original, googleClient: (_app: unknown, _tokens: unknown, _fetch: unknown, _health: unknown, account: unknown) => ({
    account, events: async () => [], calendarPage: async () => ({ events: [], next_page_token: null, fetched_count: 0, account, observed_at: new Date().toISOString() }),
    event: async () => null, changedEvents: async () => fixture.changes, newMail: async () => [],
  }) };
});
vi.mock('../src/channels/telegram-api', async load => {
  const original = await load<typeof import('../src/channels/telegram-api')>();
  return { ...original, createTelegramCaller: () => async (method: string, payload: { chat_id?: number }) => {
    if (method !== 'sendMessage') return true;
    fixture.sends++;
    return fixture.blocked ? undefined : { message_id: 91, chat: { id: payload.chat_id } };
  } };
});
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway: LLMGatewayAdapter = { async complete(request) {
    const name = request.request.response_format?.name;
    const text = name === 'task_source_scope' ? '{"decision":"retain","sources":[]}'
      : name === 'claim_ops' ? JSON.stringify({ add: [], corrections: [], seen: [], confirm: [], dismiss: [], forget_claims: [], forget_nodes: [] })
      : 'Synthetic update text.';
    return { ok: true, data: { model: request.request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { TelegramOwnerDO } = await import('../src/channels/telegram-owner-do');

it.each([true, false])('update card pushed state follows the send: blocked=%s', async blocked => {
  const name = `blocked-update-${blocked}`;
  await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const originalNow = Date.now;
    const at = Date.parse('2026-10-03T08:05:00Z');
    Date.now = () => at;
    try {
      const owner = new TelegramOwnerDO(state, { ...env, WALDO_OWNER_TELEGRAM_ID: '7', WALDO_OWNER_TIMEZONE: 'UTC', TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', GOOGLE_CLIENT_ID: 'synthetic-client', GOOGLE_CLIENT_SECRET: 'synthetic-secret' });
      state.storage.kv.put('do_name', name); state.storage.kv.put('telegram_subject', '7');
      await state.storage.put('origin', 'https://fixture.invalid');
      await state.storage.put('google:accounts', [{ id: 'local:owner@example.test', email: 'owner@example.test', refresh_token: 'synthetic-offline-only', scopes: ['https://www.googleapis.com/auth/calendar.events'] }]);
      await owner.alarm();
      state.storage.sql.exec('DELETE FROM schedule');
      dayPlanBook(state.storage.sql).sent('2026-10-03', 'card:brief');
      const updates = updateBook(state.storage.sql);
      updates.mark('calendar_since', at - 3600_000); updates.mark('mail_since', at - 3600_000);
      fixture.changes = [{ id: 'event-1', title: 'Changed event', status: 'confirmed', start: '2026-10-03T10:30:00Z', end: '2026-10-03T11:00:00Z', all_day: false, description: '', etag: 'r1', created: new Date(at - 86400_000).toISOString(), updated: new Date(at).toISOString() } as CalendarChange];
      fixture.sends = 0; fixture.blocked = blocked;
      const scheduler = new Scheduler(state.storage.sql, state.storage, { now: () => at, newRunId: () => 'r', newOutboxId: () => 'o', sha256Hex: async () => 's' });
      await scheduler.schedule({ id: BRIEF_SWEEP_ID, kind: 'pre_activity_spot', payloadRefs: { id: BRIEF_SWEEP_ID }, occurrenceAt: at - 1000, dueAt: at - 1000 });
      state.storage.kv.put('owner_alarm_last_v1', 0);
      await owner.alarm();
      expect(fixture.sends).toBe(1);
      expect(state.storage.sql.exec('SELECT pushed FROM update_cards').toArray()).toEqual([{ pushed: blocked ? 0 : 1 }]);
    } finally { Date.now = originalNow; await state.storage.deleteAlarm(); }
  });
});

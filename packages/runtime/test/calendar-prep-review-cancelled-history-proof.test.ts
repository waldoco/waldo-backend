import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import type { CalendarItem } from '../src/connectors/google';
import type { LLMGatewayAdapter, LLMGatewayRequest } from '../src/llm/provider';
import { FINAL_OUTBOX_KEY, type FinalRecord } from '../src/channels/telegram-final-outbox';
import { loopBook } from '../src/channels/loops';

const fixture = vi.hoisted(() => ({ event: null as CalendarItem | null, sent: [] as string[], requests: [] as LLMGatewayRequest[], decision: 'notify', mutate: null as (() => void) | null, ack: true }));
vi.mock('../src/connectors/google', async load => {
  const original = await load<typeof import('../src/connectors/google')>();
  return { ...original, googleClient: (_app: unknown, _tokens: unknown, _fetch: unknown, _health: unknown, account: unknown) => ({
    account, events: async () => fixture.event && fixture.event.status !== 'cancelled' ? [fixture.event] : [],
    calendarPage: async () => ({ events: fixture.event && fixture.event.status !== 'cancelled' ? [fixture.event] : [], next_page_token: null, fetched_count: 1, account, observed_at: new Date().toISOString() }),
    event: async () => fixture.event, changedEvents: async () => [], newMail: async () => [],
  }) };
});
vi.mock('../src/channels/telegram-api', async load => {
  const original = await load<typeof import('../src/channels/telegram-api')>();
  return { ...original, createTelegramCaller: () => async (method: string, payload: { chat_id?: number; text?: string }) => {
    if (method !== 'sendMessage') return true;
    fixture.sent.push(payload.text ?? '');
    return fixture.ack ? { message_id: fixture.sent.length, chat: { id: payload.chat_id } } : { message_id: fixture.sent.length, chat: { id: 999 } };
  } };
});
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway: LLMGatewayAdapter = { async complete(request) {
    fixture.requests.push(request);
    const content = request.request.messages.at(-1)?.content ?? '';
    const prep = request.request.response_format?.name === 'calendar_prep';
    if (prep) { const mutate = fixture.mutate; fixture.mutate = null; mutate?.(); }
    return { ok: true, data: { model: request.request.model, text: prep ? JSON.stringify({ kind: fixture.decision, text: fixture.decision === 'notify' ? content.includes('Bring revised diagrams') ? 'Design review at 10:30 IST. Bring revised diagrams.' : 'Design review at 10:30 IST. Bring the onboarding mocks.' : '' }) : 'SKIP', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { TelegramOwnerDO } = await import('../src/channels/telegram-owner-do');

it('review proof: cancelled prep is still retained as Waldo conversation and nightly evidence', async () => {
  const name = 'calendar-review-cancelled-history-proof';
  await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const originalNow = Date.now;
    const now = Date.parse('2026-10-03T04:30:00Z');
    Date.now = () => now;
    fixture.sent = []; fixture.requests = []; fixture.decision = 'notify'; fixture.ack = true;
    fixture.event = { id: 'event-1', title: 'Design review', status: 'confirmed', start: '2026-10-03T10:30:00+05:30', end: '2026-10-03T11:00:00+05:30', all_day: false, description: 'Bring the onboarding mocks.', etag: 'r1' };
    fixture.mutate = () => { fixture.event = { ...fixture.event!, status: 'cancelled' }; };
    const config = { ...env, CALENDAR_GROUNDED_PREP: '1', WALDO_OWNER_TELEGRAM_ID: '7', WALDO_OWNER_TIMEZONE: 'Asia/Kolkata', TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', GOOGLE_CLIENT_ID: 'synthetic-client', GOOGLE_CLIENT_SECRET: 'synthetic-secret' };
    loopBook(state.storage.sql, { newId: () => 'fixture', now: Date.now }).setProactivity({ quiet_start: null, quiet_end: null, volume: 'normal', source_proactivity: true });
    const owner = new TelegramOwnerDO(state, config);
    state.storage.kv.put('do_name', name); state.storage.kv.put('telegram_subject', '7');
    await state.storage.put('origin', 'https://fixture.invalid');
    await state.storage.put('google:accounts', [{ id: 'local:owner@example.test', email: 'owner@example.test', refresh_token: 'synthetic-offline-only', scopes: ['https://www.googleapis.com/auth/calendar.events'] }]);
    try {
      const response = await owner.fetch(new Request('https://owner.invalid/turn', { method: 'POST', body: JSON.stringify({ update_id: 901, message: { message_id: 901, from: { id: 7, is_bot: false }, chat: { id: 7, type: 'private' }, text: '/fire briefs' } }) }));
      expect(response.status).toBe(200);
      expect(state.storage.kv.get<FinalRecord[]>(FINAL_OUTBOX_KEY)?.filter(r => r.calendarPrep) ?? []).toHaveLength(0);
      expect(fixture.sent.filter(t => t.startsWith('Design review'))).toHaveLength(0);
      const rows = state.storage.sql.exec<{entry_id:string;speaker:string;text:string}>("SELECT entry_id, speaker, text FROM episodes WHERE entry_id LIKE 'calendar-prep:%'").toArray();
      expect(rows).toHaveLength(0);
      // This is a regression expectation: no unsent source-derived decision should be
      // classified as Waldo's delivered statement in the nightly consolidation input.
      const { consolidationDay } = await import('../src/channels/episodes');
      expect(consolidationDay(rows.map(r => ({ ...r, speaker: r.speaker as 'system' | 'owner' | 'waldo', at: now })))).toHaveLength(0);
    } finally { Date.now = originalNow; await state.storage.deleteAlarm(); }
  });
});

it('review proof: changed source retry does not reuse cached stale decision', async () => {
  const name = 'calendar-review-stale-cache-proof';
  await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const originalNow = Date.now;
    const now = Date.parse('2026-10-03T04:30:00Z');
    Date.now = () => now;
    fixture.sent = []; fixture.requests = []; fixture.decision = 'notify'; fixture.ack = true;
    fixture.event = { id: 'event-1', title: 'Design review', status: 'confirmed', start: '2026-10-03T10:30:00+05:30', end: '2026-10-03T11:00:00+05:30', all_day: false, description: 'Bring the onboarding mocks.', etag: 'r1' };
    fixture.mutate = () => { fixture.event = { ...fixture.event!, etag: 'r2', description: 'Bring revised diagrams; onboarding mocks are obsolete.' }; };
    const config = { ...env, CALENDAR_GROUNDED_PREP: '1', WALDO_OWNER_TELEGRAM_ID: '7', WALDO_OWNER_TIMEZONE: 'Asia/Kolkata', TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', GOOGLE_CLIENT_ID: 'synthetic-client', GOOGLE_CLIENT_SECRET: 'synthetic-secret' };
    loopBook(state.storage.sql, { newId: () => 'fixture', now: Date.now }).setProactivity({ quiet_start: null, quiet_end: null, volume: 'normal', source_proactivity: true });
    const owner = new TelegramOwnerDO(state, config);
    state.storage.kv.put('do_name', name); state.storage.kv.put('telegram_subject', '7');
    await state.storage.put('origin', 'https://fixture.invalid');
    await state.storage.put('google:accounts', [{ id: 'local:owner@example.test', email: 'owner@example.test', refresh_token: 'synthetic-offline-only', scopes: ['https://www.googleapis.com/auth/calendar.events'] }]);
    try {
      const response = await owner.fetch(new Request('https://owner.invalid/turn', { method: 'POST', body: JSON.stringify({ update_id: 901, message: { message_id: 901, from: { id: 7, is_bot: false }, chat: { id: 7, type: 'private' }, text: '/fire briefs' } }) }));
      expect(response.status).toBe(200);
      expect(state.storage.kv.get<FinalRecord[]>(FINAL_OUTBOX_KEY)?.filter(r => r.calendarPrep) ?? []).toHaveLength(0);
      expect(fixture.sent.filter(t => t.startsWith('Design review'))).toHaveLength(0);
      await owner.fetch(new Request('https://owner.invalid/turn', { method: 'POST', body: JSON.stringify({ update_id: 902, message: { message_id: 902, from: { id: 7, is_bot: false }, chat: { id: 7, type: 'private' }, text: '/fire briefs' } }) }));
      const rows = state.storage.kv.get<FinalRecord[]>(FINAL_OUTBOX_KEY)?.filter(r => r.calendarPrep) ?? [];
      expect(rows).toHaveLength(1);
      expect(rows[0]?.calendarPrep?.revision).toBe('r2');
      expect(rows[0]?.payload.text).toContain('Bring revised diagrams');
      expect(rows[0]?.payload.text).not.toContain('Bring the onboarding mocks');
      expect(fixture.requests.filter(r => r.request.messages.at(-1)?.content.includes('[Meeting prep decision'))).toHaveLength(2);
    } finally { Date.now = originalNow; await state.storage.deleteAlarm(); }
  });
});

it('review proof: literal forget removes source identifiers from every retained prep copy', async () => {
  const name = 'calendar-review-identifier-forget-proof';
  await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const originalNow = Date.now;
    const now = Date.parse('2026-10-03T04:30:00Z');
    Date.now = () => now;
    fixture.sent = []; fixture.requests = []; fixture.decision = 'notify'; fixture.ack = true;
    fixture.event = { id: 'secretmeeting123', title: 'Design review', status: 'confirmed', start: '2026-10-03T10:30:00+05:30', end: '2026-10-03T11:00:00+05:30', all_day: false, description: 'Bring the onboarding mocks.', etag: 'r1' };
    fixture.mutate = null;
    const config = { ...env, CALENDAR_GROUNDED_PREP: '1', WALDO_OWNER_TELEGRAM_ID: '7', WALDO_OWNER_TIMEZONE: 'Asia/Kolkata', TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', GOOGLE_CLIENT_ID: 'synthetic-client', GOOGLE_CLIENT_SECRET: 'synthetic-secret' };
    loopBook(state.storage.sql, { newId: () => 'fixture', now: Date.now }).setProactivity({ quiet_start: null, quiet_end: null, volume: 'normal', source_proactivity: true });
    const owner = new TelegramOwnerDO(state, config);
    state.storage.kv.put('do_name', name); state.storage.kv.put('telegram_subject', '7');
    await state.storage.put('origin', 'https://fixture.invalid');
    await state.storage.put('google:accounts', [{ id: 'local:owner@example.test', email: 'owner@example.test', refresh_token: 'synthetic-offline-only', scopes: ['https://www.googleapis.com/auth/calendar.events'] }]);
    try {
      const response = await owner.fetch(new Request('https://owner.invalid/turn', { method: 'POST', body: JSON.stringify({ update_id: 901, message: { message_id: 901, from: { id: 7, is_bot: false }, chat: { id: 7, type: 'private' }, text: '/fire briefs' } }) }));
      expect(response.status).toBe(200);
      const { redactCalendarPrepEntries } = await import('../src/channels/telegram-final-outbox');
      const cleanup = redactCalendarPrepEntries(state.storage.kv, ['secretmeeting123'], '[forgotten]');
      expect(cleanup.remaining).toBe(0);
      const rows = state.storage.kv.get<FinalRecord[]>(FINAL_OUTBOX_KEY)?.filter(r => r.calendarPrep) ?? [];
      expect(rows).toHaveLength(1);
      const dedup = state.storage.sql.exec<{event_id:string}>('SELECT event_id FROM event_briefs').toArray();
      const cooldown = state.storage.sql.exec<{event_id:string}>('SELECT event_id FROM event_cooldowns').toArray();
      expect(JSON.stringify({ rows, dedup, cooldown })).not.toContain('secretmeeting123');
      expect(rows[0]?.status).toBe('blocked');
    } finally { Date.now = originalNow; await state.storage.deleteAlarm(); }
  });
});

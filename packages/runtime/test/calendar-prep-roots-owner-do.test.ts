import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import type { CalendarItem } from '../src/connectors/google';
import type { LLMGatewayAdapter } from '../src/llm/provider';
import { BRIEF_SWEEP_ID } from '../src/channels/event-briefs';
import { FINAL_OUTBOX_KEY, type FinalRecord } from '../src/channels/telegram-final-outbox';
import { loopBook } from '../src/channels/loops';

// The prep sweep as the scheduler runs it: every pass and every decision closes its trace with a machine_turn root whose
// code says why, so a send or a skip reaches the exporter. Text capture is off here, so only the codes survive the gate.
const fixture = vi.hoisted(() => ({ event: null as CalendarItem | null, reply: '', calendar: true, sent: [] as string[] }));
vi.mock('../src/connectors/google', async load => {
  const original = await load<typeof import('../src/connectors/google')>();
  return { ...original, googleClient: (_app: unknown, _tokens: unknown, _fetch: unknown, _health: unknown, account: unknown) => ({
    account, events: async () => fixture.event ? [fixture.event] : [],
    calendarPage: async () => ({ events: fixture.event ? [fixture.event] : [], next_page_token: null, fetched_count: 1, account, observed_at: new Date().toISOString() }),
    event: async () => fixture.event, changedEvents: async () => [], newMail: async () => [],
  }) };
});
vi.mock('../src/channels/telegram-api', async load => {
  const original = await load<typeof import('../src/channels/telegram-api')>();
  return { ...original, createTelegramCaller: () => async (method: string, payload: { chat_id?: number; text?: string }) => {
    if (method !== 'sendMessage') return true;
    fixture.sent.push(payload.text ?? '');
    return { message_id: fixture.sent.length, chat: { id: payload.chat_id } };
  } };
});
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway: LLMGatewayAdapter = { async complete(request) {
    const prep = request.request.response_format?.name === 'calendar_prep';
    return { ok: true, data: { model: request.request.model, text: prep ? fixture.reply : 'SKIP', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

type Row = { trace: string; hop: string; ok: number; note: string };
const NOTE = JSON.stringify({ kind: 'notify', text: 'Design review at 10:30 IST. Bring the onboarding mocks.' });

it.each([
  { mode: 'queued', reply: NOTE, sweep: 'queued', decision: 'queued' },
  { mode: 'no note', reply: JSON.stringify({ kind: 'no_op', text: '' }), sweep: 'swept', decision: 'no_note' },
  { mode: 'malformed', reply: '{"kind":"notify"', sweep: 'swept', decision: 'malformed_reply' },
  { mode: 'low volume', reply: NOTE, sweep: 'held_volume', decision: null },
  { mode: 'no calendar', reply: NOTE, sweep: 'no_calendar', decision: null },
])('an alarm-run prep sweep closes its traces with coded roots ($mode)', async ({ mode, reply, sweep, decision }) => {
  const name = `calendar-prep-roots-${mode.replace(' ', '-')}`;
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const originalNow = Date.now;
    let now = Date.parse('2026-10-03T04:30:00Z');
    Date.now = () => now;
    fixture.reply = reply; fixture.sent = [];
    fixture.event = { id: 'event-1', title: 'Design review', status: 'confirmed', start: '2026-10-03T10:30:00+05:30', end: '2026-10-03T11:00:00+05:30', all_day: false, description: 'Bring the onboarding mocks', etag: 'r1' };
    const owner = new OwnerDO(state, { ...env, CALENDAR_GROUNDED_PREP: '1', LANGFUSE_CAPTURE_TEXT: undefined, WALDO_OWNER_TELEGRAM_ID: '7', WALDO_OWNER_TIMEZONE: 'Asia/Kolkata', TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', GOOGLE_CLIENT_ID: 'synthetic-client', GOOGLE_CLIENT_SECRET: 'synthetic-secret' });
    state.storage.kv.put('do_name', name); state.storage.kv.put('telegram_subject', '7');
    await state.storage.put('origin', 'https://fixture.invalid');
    await state.storage.put('google:accounts', mode === 'no calendar' ? [] : [{ id: 'local:owner@example.test', email: 'owner@example.test', refresh_token: 'synthetic-offline-only', scopes: ['https://www.googleapis.com/auth/calendar.events'] }]);
    if (mode === 'low volume') loopBook(state.storage.sql, { newId: () => 'fixture', now: () => now }).setProactivity({ quiet_start: '20:00', quiet_end: '08:00', volume: 'low' });
    try {
      // The runtime arms the sweep on its first pass; the scheduler then runs it when it falls due.
      await (owner as unknown as { setup(channel: string): { ready: Promise<void> } }).setup('telegram').ready;
      now += 10 * 60_000 + 1000;
      state.storage.kv.put('owner_alarm_last_v1', 1);
      await owner.alarm();
      const rows = state.storage.sql.exec<Row>('SELECT trace, hop, ok, note FROM trace_log ORDER BY id').toArray();
      const sweeps = rows.filter(row => row.trace.startsWith(`${BRIEF_SWEEP_ID}:`));
      expect(sweeps.filter(row => row.hop === 'machine_turn').map(row => row.note), 'one sweep root, with its code').toEqual([sweep]);
      expect(sweeps.at(-1)).toMatchObject({ hop: 'machine_turn', ok: 1 });
      const decisions = rows.filter(row => row.trace.startsWith('calendar-prep:') && row.hop === 'machine_turn');
      expect(decisions.map(row => [row.note, row.ok])).toEqual(decision === null ? [] : [[decision, decision === 'malformed_reply' ? 0 : 1]]);
      if (decision) expect(sweeps.find(row => row.hop === 'machine_check')?.note).toBe(decision);
      // The update check still runs after every pass, held or not.
      expect(rows.some(row => row.trace.startsWith('update:') && row.hop === 'machine_turn')).toBe(mode !== 'no calendar');
      expect(JSON.stringify(rows)).not.toContain('onboarding mocks');
      const queued = (state.storage.kv.get<FinalRecord[]>(FINAL_OUTBOX_KEY) ?? []).filter(record => record.calendarPrep);
      expect(queued).toHaveLength(decision === 'queued' ? 1 : 0);
    } finally { Date.now = originalNow; await state.storage.deleteAlarm(); }
  });
});

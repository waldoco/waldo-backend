import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import type { LLMGatewayAdapter } from '../src/llm/provider';
import { loopBook } from '../src/channels/loops';
import { dayPlanBook } from '../src/channels/day-cards';
import { claimStore } from '../src/memory/claims';
import { FINAL_OUTBOX_KEY, type FinalRecord } from '../src/channels/telegram-final-outbox';
const fixture = vi.hoisted(() => ({ mail: false, loopId: '', event: false, sent: [] as string[], prompts: [] as string[] }));
vi.mock('../src/connectors/google', async load => {
  const original = await load<typeof import('../src/connectors/google')>();
  return { ...original, googleClient: () => ({ changedEvents: async () => [], newMail: async () => fixture.mail ? [{ id: 'mail-message-1', thread_id: 'mail-thread-1', from: 'Pat <pat@example.test>', subject: 'Review by 10 today', snippet: 'Please review the deck by 10 UTC', at: '2026-10-03T07:00:00Z' }] : [], events: async () => fixture.event ? [{ id: 'due-event', title: 'Design review', start: '2026-10-03T09:30:00Z', end: '2026-10-03T10:00:00Z', all_day: false }] : [] }) };
});
vi.mock('../src/channels/telegram-api', async load => {
  const original = await load<typeof import('../src/channels/telegram-api')>();
  return { ...original, createTelegramCaller: () => async (method: string, payload: { chat_id?: number; text?: string }) => { if (method === 'sendMessage') { fixture.sent.push(payload.text ?? ''); return { message_id: fixture.sent.length, chat: { id: payload.chat_id } }; } return true; } };
});
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway: LLMGatewayAdapter = { async complete(request) {
    const content = request.request.messages.at(-1)?.content ?? '';
    const writer = request.request.response_format !== undefined;
    const firstRound = !request.request.tool_turns?.length;
    const calls = !writer && firstRound && content.includes('set quiet') ? [{ call_id: 'set-quiet', name: 'set_proactivity', arguments: JSON.stringify({ quiet_start: '21:00', quiet_end: '07:00', volume: 'normal' }) }] : [];
    const text = request.request.response_format?.name === 'task_source_scope' ? '{"decision":"retain","sources":[]}' : calls.length ? '' : writer ? '{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}' : 'Done.';
    return { ok: true, data: { model: request.request.model, text, ...(calls.length ? { tool_calls: calls } : {}), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { TelegramOwnerDO } = await import('../src/channels/telegram-owner-do');
it.each(['effect-turn', 'read-only-turn'])('S2b receipt line on the owner reply: %s', async mode => {
  await runInDurableObject(env.TRACER_DO.get(env.TRACER_DO.idFromName(`s2b-receipt-${mode}`)), async (_instance, state) => {
    const originalNow = Date.now;
    let now = Date.parse('2026-10-03T06:59:00Z');
    Date.now = () => now;
    fixture.event = false; fixture.mail = false; fixture.loopId = ''; fixture.sent = []; fixture.prompts = [];
    const config = { ...env, MAIL_SOURCE_FOLLOWUPS: undefined, WALDO_OWNER_TELEGRAM_ID: '7', WALDO_OWNER_TIMEZONE: 'UTC', TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', GOOGLE_CLIENT_ID: 'synthetic-client', GOOGLE_CLIENT_SECRET: 'synthetic-secret' };
    let owner = new TelegramOwnerDO(state, config);
    state.storage.kv.put('do_name', 'synthetic-mail-owner'); state.storage.kv.put('telegram_subject', '7');
    await state.storage.put('origin', 'https://fixture.invalid');
    await state.storage.put('google:accounts', [{ id: 'local:owner@example.test', email: 'owner@example.test', refresh_token: 'synthetic-offline-only', scopes: ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.compose'] }]);
    let update = 100;
    const incoming = async (text: string) => {
      const response = await owner.fetch(new Request('https://owner.invalid/turn', { method: 'POST', body: JSON.stringify({ update_id: update++, message: { message_id: update, from: { id: 7, is_bot: false }, chat: { id: 7, type: 'private' }, text } }) }));
      expect(response.status).toBe(200);
    };
    try {
      await incoming(mode === 'effect-turn' ? 'please set quiet hours' : 'hello there');
      for (let i = 0; i < 3; i++) { now += 61_000; state.storage.kv.put('owner_alarm_last_v1', 0); await owner.alarm(); }
      const replies = fixture.sent.filter(text => text.includes('Done.'));
      expect(replies, JSON.stringify(fixture.sent)).toHaveLength(1);
      if (mode === 'effect-turn') expect(replies[0], 'effect turn: last line is the receipt from the typed tool result').toMatch(/\n\nReceipts: proactivity set \(accepted\)$/);
      else expect(replies[0]).not.toContain('Receipts:');
    } finally { Date.now = originalNow; await state.storage.deleteAlarm(); }
  });
});

import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import type { LLMGatewayAdapter } from '../src/llm/provider';
import { loopBook } from '../src/channels/loops';
import { dayPlanBook } from '../src/channels/day-cards';
import { FINAL_OUTBOX_KEY, type FinalRecord } from '../src/channels/telegram-final-outbox';
const fixture = vi.hoisted(() => ({ mail: false, loopId: '', sent: [] as string[], prompts: [] as string[] }));
vi.mock('../src/connectors/google', async load => {
  const original = await load<typeof import('../src/connectors/google')>();
  return { ...original, googleClient: () => ({ changedEvents: async () => [], newMail: async () => fixture.mail ? [{ id: 'mail-message-1', thread_id: 'mail-thread-1', from: 'Pat <pat@example.test>', subject: 'Review by 10 today', snippet: 'Please review the deck by 10 UTC', at: '2026-10-03T07:00:00Z' }] : [], events: async () => [] }) };
});
vi.mock('../src/channels/telegram-api', async load => {
  const original = await load<typeof import('../src/channels/telegram-api')>();
  return { ...original, createTelegramCaller: () => async (method: string, payload: { chat_id?: number; text?: string }) => { if (method === 'sendMessage') { fixture.sent.push(payload.text ?? ''); return { message_id: fixture.sent.length, chat: { id: payload.chat_id } }; } return true; } };
});
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway: LLMGatewayAdapter = { async complete(request) {
    const content = request.request.messages.at(-1)?.content ?? '';
    fixture.prompts.push(content);
    const writer = request.request.response_format !== undefined;
    const firstRound = !request.request.tool_turns?.length;
    const calls = !writer && firstRound && content.includes('[Update check') ? [{ call_id: 'open-source', name: 'open_loop', arguments: JSON.stringify({ title: 'Check deck review', due: '2026-10-03T10:00', source_ref: 'mail:mail-thread-1' }) }]
      : !writer && firstRound && content === 'done' ? [{ call_id: 'close-source', name: 'close_loop', arguments: JSON.stringify({ id: fixture.loopId, outcome: 'done' }) }] : [];
    const text = calls.length ? '' : writer ? '{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}' : content.includes('[Mail follow-up check') ? 'Have you handled the deck review? Pat requested it by 10 UTC.' : 'SKIP';
    return { ok: true, data: { model: request.request.model, text, ...(calls.length ? { tool_calls: calls } : {}), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { TelegramOwnerDO } = await import('../src/channels/telegram-owner-do');
it('actual default owner ingress retains quiet mail, extracts after wake, nudges without new mail and closes on owner done', async () => {
  await runInDurableObject(env.TRACER_DO.get(env.TRACER_DO.idFromName('mail-follow-up-owner-default')), async (_instance, state) => {
    const originalNow = Date.now;
    let now = Date.parse('2026-10-03T06:59:00Z');
    Date.now = () => now;
    const owner = new TelegramOwnerDO(state, { ...env, WALDO_OWNER_TELEGRAM_ID: '7', WALDO_OWNER_TIMEZONE: 'UTC', TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', GOOGLE_CLIENT_ID: 'synthetic-client', GOOGLE_CLIENT_SECRET: 'synthetic-secret' });
    state.storage.kv.put('do_name', 'synthetic-mail-owner'); state.storage.kv.put('telegram_subject', '7');
    await state.storage.put('origin', 'https://fixture.invalid');
    await state.storage.put('google:accounts', [{ id: 'local:owner@example.test', email: 'owner@example.test', refresh_token: 'synthetic-offline-only', scopes: ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.compose'] }]);
    let update = 100;
    const incoming = async (text: string) => {
      const response = await owner.fetch(new Request('https://owner.invalid/turn', { method: 'POST', body: JSON.stringify({ update_id: update++, message: { message_id: update, from: { id: 7, is_bot: false }, chat: { id: 7, type: 'private' }, text } }) }));
      expect(response.status).toBe(200);
    };
    try {
      await incoming('/fire fetch');
      const loops = loopBook(state.storage.sql, { now: () => now, newId: () => 'test-only' });
      loops.setProactivity({ quiet_start: '20:00', quiet_end: '08:00', volume: 'normal' });
      fixture.mail = true; now += 61_000;
      await incoming('/fire fetch');
      expect(loops.list()).toEqual([]);
      fixture.mail = false; now = Date.parse('2026-10-03T09:00:00Z');
      dayPlanBook(state.storage.sql).sent('2026-10-03', 'card:brief');
      await incoming('/fire fetch');
      const open = loops.list()[0]!; fixture.loopId = open.id;
      expect(open.source_ref).toBe('mail:mail-thread-1');
      expect(fixture.prompts.some(text => text.includes('[source_ref mail:mail-thread-1]'))).toBe(true);
      now += 300_000;
      await incoming('/fire fetch');
      const queued = state.storage.kv.get<FinalRecord[]>(FINAL_OUTBOX_KEY)!.filter(r => r.mailFollowup);
      expect(queued).toHaveLength(1); expect(queued[0]?.status).toBe('pending');
      loops.setProactivity({ quiet_start: '20:00', quiet_end: '08:00', volume: 'low' });
      now += 1000; await owner.alarm();
      expect(fixture.sent.filter(text => text.startsWith('Have you handled'))).toHaveLength(0);
      expect(state.storage.kv.get<FinalRecord[]>(FINAL_OUTBOX_KEY)!.find(r => r.mailFollowup)?.status).toBe('pending');
      loops.setProactivity({ quiet_start: '20:00', quiet_end: '08:00', volume: 'normal' });
      now += 600_000; await owner.alarm();
      expect(fixture.sent.filter(text => text.startsWith('Have you handled'))).toHaveLength(1);
      await incoming('done');
      expect(loops.list()).toEqual([]);
      expect(loops.closed()[0]?.status).toBe('done');
      now += 600_000; await incoming('/fire fetch');
      expect(fixture.sent.filter(text => text.startsWith('Have you handled'))).toHaveLength(1);
    } finally { Date.now = originalNow; await state.storage.deleteAlarm(); }
  });
});

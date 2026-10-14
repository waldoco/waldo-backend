import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import type { LLMGatewayAdapter } from '../src/llm/provider';

// A Telegram owner turn whose reply declares a send it never made is revised once with the findings as host facts.
// A rewrite that still claims it reaches the owner with the not-confirmed line; an honest rewrite reaches them as written.
const fixture = vi.hoisted(() => ({ sent: [] as string[], rewrite: 'still-claims' as 'still-claims' | 'honest', rounds: [] as string[][] }));
vi.mock('../src/channels/telegram-api', async load => {
  const original = await load<typeof import('../src/channels/telegram-api')>();
  return { ...original, createTelegramCaller: () => async (method: string, payload: { chat_id?: number; text?: string }) => { if (method === 'sendMessage') { fixture.sent.push(payload.text ?? ''); return { message_id: fixture.sent.length, chat: { id: payload.chat_id } }; } return true; } };
});
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway: LLMGatewayAdapter = { async complete({ request }) {
    const done = (text: string, tool_calls?: Array<{ call_id: string; name: string; arguments: string }>) => ({ ok: true as const, data: { model: request.model, text, ...(tool_calls ? { tool_calls } : {}), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } });
    if (request.response_format) return done(request.response_format.name === 'task_source_scope' ? '{"decision":"retain","sources":[]}' : '{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}');
    if (!String(request.messages.at(-1)?.content ?? '').includes('message Pat')) return done('Okay.');
    fixture.rounds.push((request.tools ?? []).map(tool => tool.name));
    const claim = [{ call_id: `claim-${fixture.rounds.length}`, name: 'note_done', arguments: JSON.stringify({ effect: 'message_send_proposed' }) }];
    const revising = request.tool_turns?.at(-1)?.output.includes('[host facts:') === true;
    if (revising && fixture.rewrite === 'honest') return done('I have not messaged Pat yet. Want me to?');
    return done('Messaged Pat.', claim);
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

it.each(['still-claims', 'honest'] as const)('Telegram: a claimed send with no effect call is revised once (%s rewrite)', async rewrite => {
  await runInDurableObject(env.TRACER_DO.get(env.TRACER_DO.idFromName(`done-claims-telegram-${rewrite}`)), async (_instance, state) => {
    fixture.sent = []; fixture.rounds = []; fixture.rewrite = rewrite;
    const originalNow = Date.now;
    let now = Date.parse('2026-10-03T06:59:00Z');
    Date.now = () => now;
    const owner = new OwnerDO(state, { ...env, MAIL_SOURCE_FOLLOWUPS: undefined, WALDO_OWNER_TELEGRAM_ID: '7', WALDO_OWNER_TIMEZONE: 'UTC', TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture' });
    state.storage.kv.put('do_name', 'synthetic-claims-owner'); state.storage.kv.put('telegram_subject', '7');
    await state.storage.put('origin', 'https://fixture.invalid');
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const response = await owner.fetch(new Request('https://owner.invalid/turn', { method: 'POST', body: JSON.stringify({ update_id: 900, message: { message_id: 900, from: { id: 7, is_bot: false }, chat: { id: 7, type: 'private' }, text: 'please message Pat that I am late' } }) }));
      expect(response.status).toBe(200);
      for (let i = 0; i < 3; i++) { now += 61_000; state.storage.kv.put('owner_alarm_last_v1', 0); await owner.alarm(); }
      expect(fixture.rounds, 'one reply round, then exactly one revision offering only note_done').toHaveLength(2);
      expect(fixture.rounds[0]).toContain('note_done');
      expect(fixture.rounds[1]).toEqual(['note_done']);
      const reply = fixture.sent.find(text => text.includes('Pat'))!;
      if (rewrite === 'still-claims') expect(reply).toBe('Messaged Pat.\n\nNot confirmed: message send proposed (nothing ran)');
      else expect(reply).toBe('I have not messaged Pat yet. Want me to?');
    } finally { Date.now = originalNow; quiet.mockRestore(); await state.storage.deleteAlarm(); }
  });
}, 30_000);

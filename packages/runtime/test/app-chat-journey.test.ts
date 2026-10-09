import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import type { LLMGatewayAdapter } from '../src/llm/provider';
const fixture = vi.hoisted(() => ({ telegramSends: 0 }));
vi.mock('../src/channels/telegram-api', async load => {
  const original = await load<typeof import('../src/channels/telegram-api')>();
  return { ...original, createTelegramCaller: () => async () => { fixture.telegramSends += 1; return undefined; } };
});
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway: LLMGatewayAdapter = { async complete(request) {
    const writer = request.request.response_format !== undefined;
    const text = request.request.response_format?.name === 'task_source_scope' ? '{"decision":"retain","sources":[]}' : writer ? '{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topics":[]}' : 'Hello from the agent.';
    return { ok: true, data: { model: request.request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { TelegramOwnerDO } = await import('../src/channels/telegram-owner-do');

it('an app message runs a real turn and its reply lands in the shared transcript, not on Telegram', async () => {
  await runInDurableObject(env.TRACER_DO.get(env.TRACER_DO.idFromName('app-chat-journey')), async (_instance, state) => {
    const config = { ...env, WALDO_OWNER_TIMEZONE: 'UTC', TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture' };
    const owner = new TelegramOwnerDO(state, config);
    state.storage.kv.put('do_name', 'app-owner-1');
    await state.storage.put('origin', 'https://fixture.invalid');
    const send = (body: unknown) => owner.fetch(new Request('https://telegram-owner/app/v1/chat/main/messages', { method: 'POST', headers: { 'x-waldo-do-name': 'app-owner-1', 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    const first = await send({ client_message_id: 'client-msg-0001', text: 'hello from the app' });
    expect(first.status).toBe(202);
    const accepted = await first.json() as { accepted: boolean; message_id: string };
    expect(accepted.accepted).toBe(true);
    const again = await send({ client_message_id: 'client-msg-0001', text: 'hello from the app' });
    expect((await again.json() as { message_id: string }).message_id).toBe(accepted.message_id);
    let page: { messages: { id: string; role: string; text: string; parent_id: string | null; channel: string }[] } = { messages: [] };
    for (let i = 0; i < 100 && !page.messages.some(m => m.role === 'assistant'); i += 1) {
      await new Promise(resolve => setTimeout(resolve, 100));
      page = await (await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main', { headers: { 'x-waldo-do-name': 'app-owner-1' } }))).json() as typeof page;
    }
    const reply = page.messages.find(m => m.role === 'assistant');
    expect(reply, JSON.stringify(page)).toBeDefined();
    expect(reply!.parent_id).toBe(accepted.message_id);
    expect(page.messages.find(m => m.role === 'user')).toMatchObject({ id: accepted.message_id, text: 'hello from the app' });
    expect(fixture.telegramSends).toBe(0);
    const bad = await send({ client_message_id: 'x', text: '' });
    expect(bad.status).toBe(403);
  });
}, 30_000);

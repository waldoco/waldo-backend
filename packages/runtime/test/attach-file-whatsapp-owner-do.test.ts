// attach_file through the real owner runtime on WhatsApp, where the surface offers it.
// A WhatsApp turn runs without a run scope today, and the workspace opens only inside one, so the prompt says attachments
// are unavailable, the tool answers "unavailable" without reaching the workspace host, and the reply goes out with no file.
// This pins that gap until WhatsApp turns carry a run scope.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import type { LLMGatewayRequest } from '../src/llm/provider';

const FILE = 'abcdefab-cdef-4abc-8abc-00000000000a';
const world = vi.hoisted(() => ({ requests: [] as LLMGatewayRequest['request'][], workspaceOpened: 0 }));
vi.mock('../src/channels/workspace-host', async load => {
  const original = await load<typeof import('../src/channels/workspace-host')>();
  return { ...original, workspaceOwnerHost: (...args: Parameters<typeof original.workspaceOwnerHost>) => { world.workspaceOpened += 1; return original.workspaceOwnerHost(...args); } };
});
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete({ request }: LLMGatewayRequest) {
    if (request.response_format) return { ok: true as const, data: { model: request.model, text: '{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
    world.requests.push(request);
    const first = !request.tool_turns?.length;
    return { ok: true as const, data: { model: request.model, text: first ? '' : 'Here is the plan.', ...(first ? { tool_calls: [{ call_id: 'attach-1', name: 'attach_file', arguments: JSON.stringify({ file_id: FILE, revision: 1 }) }] } : {}), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

it('a WhatsApp turn without a run scope is told attachments are unavailable, and an attach never reaches the workspace', async () => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('attach-file-whatsapp')), async (_instance, state) => {
    const graph: string[] = [];
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const body = init?.body;
      graph.push(typeof body === 'string' ? JSON.parse(body).type : 'upload');
      return Response.json({ messages: [{ id: 'wamid.out' }] });
    });
    const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const instance = new OwnerDO(state, { ...env, TELEGRAM_BOT_TOKEN: 'fictional-telegram-token', OPENAI_API_KEY: 'fictional-model-key',
      WHATSAPP_ACCESS_TOKEN: 'fictional-whatsapp-token', WHATSAPP_PHONE_NUMBER_ID: 'fictional-phone-id', WALDO_OWNER_TIMEZONE: 'UTC' });
    try {
      const response = await instance.fetch(new Request('https://telegram-owner/whatsapp-admit', {
        method: 'POST', headers: { 'x-waldo-whatsapp-subject': '15550001111' },
        body: JSON.stringify({ messages: [{ from: '15550001111', id: 'wamid.in', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Send me the plan PDF' } }] }),
      }));
      expect(response.status).toBe(200);
      await Promise.all([...(instance as unknown as { whatsappInflight: Set<Promise<void>> }).whatsappInflight]);
      expect(world.requests[0]!.tools?.map(tool => tool.name)).toContain('attach_file');
      expect(world.requests[0]!.system).toContain('Attachment sending: unavailable');
      expect(JSON.stringify(world.requests[1]!.tool_turns)).toContain('\\"reason\\":\\"unavailable\\"');
      expect(world.workspaceOpened).toBe(0);
      expect(graph).toEqual(['text']);
      expect([...state.storage.kv.list({ prefix: 'owner:effect:' })]).toEqual([]);
    } finally { fetcher.mockRestore(); logs.mockRestore(); await state.storage.deleteAlarm(); }
  });
});

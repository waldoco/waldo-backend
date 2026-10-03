// Exercise the deployed two-argument constructor. Provider and Telegram I/O stay local.
import { env, runInDurableObject } from 'cloudflare:test';
import { beforeEach, expect, it, vi } from 'vitest';
import { TelegramOwnerDO } from '../src/channels/telegram-owner-do';

vi.mock('../src/llm/transcriber', () => ({ selectTranscriber: () => ({ provider: 'openai', transcribe: async () => 'Deployed voice transcript marker' }) }));
const seen = vi.hoisted(() => ({ requests: [] as unknown[] }));
vi.mock('../src/channels/telegram-api', async load => ({
  ...await load<typeof import('../src/channels/telegram-api')>(),
  createTelegramCaller: () => async (method: string) => method === 'getMe' ? { username: 'fixture_bot' } : method === 'sendMessage' ? { message_id: 1 } : true,
}));
vi.mock('openai', () => ({ default: class {
  responses = { create: async (body: unknown) => {
    seen.requests.push(body);
    const name = (body as { text?: { format?: { name?: string } } }).text?.format?.name;
    return { id: 'fixture', output_text: name === 'claim_ops'
      ? '{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}'
      : name === 'reaction' ? '{"reaction":"👌"}' : 'Deployed mode fixture reply.', output: [], usage: { input_tokens: 1, output_tokens: 1 } };
  } };
} }));
let sequence = 910000;
beforeEach(() => { seen.requests = []; });

it.each([
  { kind: 'text', content: { text: 'Deployed owner text marker' }, marker: 'Deployed owner text marker' },
  { kind: 'photo', content: { caption: 'Deployed owner photo marker', photo: [{ file_id: 'fictional-photo', width: 2, height: 2, file_size: 3 }] }, marker: 'input_image' },
  { kind: 'document', content: { caption: 'Deployed owner file marker', document: { file_id: 'fictional-file', file_name: 'fixture.txt', mime_type: 'text/plain', file_size: 3 } }, marker: 'input_file' },
  { kind: 'voice', content: { voice: { file_id: 'fictional-voice', duration: 1, mime_type: 'audio/ogg', file_size: 3 } }, marker: 'Deployed voice transcript marker' },
])('deployed two-argument constructor answers authenticated owner $kind with a fenced final', async ({ content, marker }) => {
  const id = ++sequence;
  const name = `deployed-mode-${id}`;
  await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const denyNetwork = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url === 'https://api.telegram.org/bot12345:fictional/getFile') return Response.json({ ok: true, result: { file_path: 'fixture/bytes' } });
      if (url === 'https://api.telegram.org/file/bot12345:fictional/fixture/bytes') return new Response(new Uint8Array([1, 2, 3]));
      throw new Error('local proof denies unexpected network');
    });
    try {
      const instance = new TelegramOwnerDO(state, { ...env, TELEGRAM_BOT_TOKEN: '12345:fictional', TELEGRAM_WEBHOOK_SECRET: 'fictional-inbox-secret', OPENAI_API_KEY: 'fictional-model-key' });
      const response = await instance.fetch(new Request('https://local.invalid/enqueue', {
        method: 'POST', headers: { 'x-waldo-inbox-secret': 'fictional-inbox-secret', 'x-waldo-telegram-subject': '81101', 'x-waldo-do-name': name },
        body: JSON.stringify({ update_id: id, message: { message_id: id, from: { id: 81101, is_bot: false }, chat: { id: 81101, type: 'private' }, ...content } }),
      }));
      expect(response.status).toBe(200);
      await instance.alarm();
      const row = state.storage.kv.get<{ state: string; reason: string; runId: string; attempt: string }[]>('telegram_owner_inbox_v1')!.at(-1)!;
      expect(row.reason).toBe('final_committed');
      expect(row.state).toBe('awaiting_delivery');
      const final = state.storage.kv.get<{ id: string; payload: { text: string }; inbox: { runId: string; attempt: string } }[]>('telegram_final_outbox_v1')!.find(item => item.id.startsWith('turn:'))!;
      expect(final.payload.text).toContain('Deployed mode fixture reply.');
      expect(final.inbox).toMatchObject({ runId: row.runId, attempt: row.attempt });
      expect(JSON.stringify(seen.requests)).toContain(marker);
      if ('photo' in content || 'document' in content) expect(JSON.stringify(seen.requests)).toContain('AQID');
      // Reaction selection needs original text/caption; a bare voice message has neither.
      if ('text' in content || 'caption' in content) expect(seen.requests.some(request => (request as { text?: { format?: { name?: string } } }).text?.format?.name === 'reaction')).toBe(true);
      expect((await state.storage.list({ prefix: 'canonical-owner-v1:' })).size).toBe(0);
    } finally { await state.storage.deleteAlarm(); denyNetwork.mockRestore(); }
  });
});

it.each([null, {}, { mode: 'unknown' }])('rejects an invalid private preparation descriptor at construction: %j', async descriptor => {
  const name = `invalid-mode-${++sequence}`;
  await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name)), async (_instance, state) => {
    expect(() => new TelegramOwnerDO(state, env, descriptor as never)).toThrow('invalid owner preparation mode');
  });
});

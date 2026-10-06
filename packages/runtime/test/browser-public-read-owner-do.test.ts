import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { TelegramOwnerDO } from '../src/channels/telegram-owner-do';
import { configureStagingPublicBrowser } from '../src/channels/browser-public-read-configuration';

const model = vi.hoisted(() => ({ inputs: [] as unknown[] }));
vi.mock('openai', () => ({ default: class { responses = { create: async (input: { text?: { format?: { name?: string } } }) => {
  model.inputs.push(structuredClone(input));
  const structured = input.text?.format?.name;
  const read = !structured && !JSON.stringify(input).includes('function_call_output');
  return { id: 'synthetic-public-browser-reply', output: read ? [{ type: 'function_call', call_id: 'public-menu', name: 'browse_page', arguments: JSON.stringify({ url: 'https://example.com/menu', instruction: 'Find vegetarian options' }) }] : [],
    output_text: structured === 'task_source_scope' ? JSON.stringify({ decision: 'retain', sources: [] }) : structured === 'claim_ops' ? '{"add":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}' : read ? '' : 'Synthetic menu read complete.', usage: { input_tokens: 1, output_tokens: 1 } };
} }; } }));
vi.mock('../src/channels/telegram-api', async load => ({ ...await load<typeof import('../src/channels/telegram-api')>(), createTelegramCaller: () => async (method: string) => method === 'getMe' ? { username: 'public_browser_fixture_bot' } : method === 'sendMessage' ? { message_id: 1 } : true }));

it('the ordinary two-argument owner DO serves configured Cloudflare browse_page with fakes and no fixture grants', async () => {
  let starts = 0, ended = false;
  const sdk = {
    acquire: async () => { starts++; return { sessionId: 'PRIVATE_OWNER_PUBLIC_SESSION' }; },
    endpointURLString: () => { throw Error('must use supported direct binding connect'); },
    connect: async () => ({ newContext: async () => ({ route: async () => {}, newPage: async () => ({ setDefaultTimeout() {}, goto: async () => ({ status: () => 200 }), url: () => 'https://example.com/menu', title: async () => 'Synthetic menu', locator: () => ({ innerText: async () => 'Vegetarian pasta costs twelve pounds.' }) }), close: async () => {} }), close: async () => {}, newBrowserCDPSession: async () => ({ send: async () => { ended = true; } }) }),
    sessions: async () => ended ? [] : [{ sessionId: 'PRIVATE_OWNER_PUBLIC_SESSION' }],
  };
  configureStagingPublicBrowser(async () => sdk as never);
  const doName = `public-browser-two-arg-${crypto.randomUUID()}`, subject = 81101;
  const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(doName));
  await runInDurableObject(stub, async (_instance, state) => {
    const denied = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('live network forbidden'));
    try {
      const instance = new TelegramOwnerDO(state, { ...env, WALDO_ENVIRONMENT: 'staging', WALDO_EGRESS_ALLOWLIST: 'example.com', BROWSER: {} as never, TELEGRAM_BOT_TOKEN: '12345:fictional', TELEGRAM_WEBHOOK_SECRET: 'synthetic-public-browser-secret', OPENAI_API_KEY: 'synthetic-model-key' });
      const response = await instance.fetch(new Request('https://local.invalid/enqueue', { method: 'POST', headers: { 'x-waldo-inbox-secret': 'synthetic-public-browser-secret', 'x-waldo-telegram-subject': String(subject), 'x-waldo-do-name': doName }, body: JSON.stringify({ update_id: 9981001, message: { message_id: 9981001, from: { id: subject, is_bot: false }, chat: { id: subject, type: 'private' }, text: 'Read the public menu at https://example.com/menu.' } }) }));
      expect(response.status).toBe(200);
      for (let i = 0; i < 5 && starts === 0; i++) await instance.alarm();
      expect(starts).toBe(1); expect(ended).toBe(true);
      expect(JSON.stringify(model.inputs)).toContain('Vegetarian pasta costs twelve pounds.');
      expect(JSON.stringify(model.inputs)).not.toContain('PRIVATE_OWNER_PUBLIC_SESSION');
      expect(denied).not.toHaveBeenCalled();
    } finally { await state.storage.deleteAlarm(); denied.mockRestore(); }
  });
});

import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi, type MockInstance } from 'vitest';
import { OPENAI_GPT_6_1_SOL_MODEL, WALDO_CHAT_MODEL } from '@waldo/contracts';
import { OwnerDO } from '../src/channels/owner-do';
import { registerCommonBrowserSdk } from '../src/channels/common-staging-registration';
import type { CloudflareBrowserSdkLoader } from '../src/channels/public-fixture-browser';

const SUBJECT = 81201;
const proof = vi.hoisted(() => ({ models: [] as string[], delivered: [] as string[] }));
vi.mock('openai', () => ({ default: class { responses = { create: async (input: any) => {
  proof.models.push(input.model);
  const format = input.text?.format?.name;
  const read = !format && !(Array.isArray(input.input) && input.input.some((item: any) => item.type === 'function_call_output'));
  return { id: 'synthetic-trial-sol', output: read ? [{ type: 'function_call', call_id: 'read-0', name: 'browse_page', arguments: JSON.stringify({ url: 'https://example.com/a', instruction: 'Read the public page' }) }] : [],
    output_text: format === 'claim_ops' ? '{"add":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}' : format ? '{}' : read ? '' : 'Read A.', usage: { input_tokens: 1, output_tokens: 1 } };
} }; } }));
vi.mock('../src/channels/telegram-api', async load => ({ ...await load<typeof import('../src/channels/telegram-api')>(), createTelegramCaller: () => async (method: string, payload: any) => {
  if (method === 'sendMessage') { proof.delivered.push(payload.text); return { message_id: proof.delivered.length, chat: { id: payload.chat_id } }; }
  return method === 'getMe' ? { username: 'trial_sol_fixture_bot' } : true;
} }));

// The trial prices Luna only. On the production chat model, the owner turn's first call is unfunded and runs; the browse
// funds the run, and the next call is refused with a coded reason the trace records, never metered at Luna prices.
it('an owner turn on Sol that funds a browser trial run gets a coded refusal in the trace and a visible notice', async () => {
  expect(WALDO_CHAT_MODEL).toBe(OPENAI_GPT_6_1_SOL_MODEL);
  const sessions = new Map<string, any[]>();
  const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1cAAAAASUVORK5CYII='), x => x.charCodeAt(0));
  const loader: CloudflareBrowserSdkLoader = async () => ({
    acquire: async (binding: any, options: any) => {
      await binding.fetch(`http://fake.host/v1/devtools/browser?keep_alive=${options.keep_alive}`, { method: 'POST' });
      const id = `private-provider-${crypto.randomUUID()}`, pages: any[] = [];
      sessions.set(id, pages); return { sessionId: id };
    },
    connect: async (binding: any, options: any) => {
      await binding.fetch(`http://fake.host/v1/devtools/browser/${options.sessionId}?persistent=true`, { headers: { upgrade: 'websocket' } });
      const pages = sessions.get(options.sessionId); if (!pages) throw Error('No retained fake session');
      const context = { close: async () => { pages.length = 0; }, serviceWorkers: () => [], addInitScript: async () => {}, routeWebSocket: async () => {}, pages: () => pages.slice(), route: async () => {}, unroute: async () => {},
        newCDPSession: async (page: any) => ({ send: async (method: string) => method === 'Accessibility.getFullAXTree' ? { nodes: [] } : ({ targetInfo: { targetId: page.id } }), detach: async () => {} }),
        newPage: async () => {
          let url = 'about:blank';
          const page = { id: crypto.randomUUID(), url: () => url, title: async () => 'Page A', setDefaultTimeout() {}, locator: (selector: string) => ({ selector }), goto: async (target: string) => { url = target; return { status: () => 200 }; },
            evaluate: async () => ({ url, title: 'Page A', text: `Page A ${url}`, width: 1, height: 1, scrollX: 0, scrollY: 0, elements: [] }), screenshot: async () => png.slice(), close: async () => { pages.splice(pages.indexOf(page), 1); } };
          pages.push(page); return page;
        } };
      return { contexts: () => [context], newContext: async () => context, close: async () => {}, newBrowserCDPSession: async () => ({ send: async () => { sessions.delete(options.sessionId); } }) };
    },
    sessions: async (binding: any) => { await binding.fetch('http://fake.host/v1/sessions'); return [...sessions.keys()].map(sessionId => ({ sessionId })); }, endpointURLString: () => '',
  } as never);
  registerCommonBrowserSdk(loader);
  const now = Date.now(), ownerId = '10000000-0000-0000-0000-000000000021', doName = `trial-sol-${crypto.randomUUID()}`;
  const operator = JSON.stringify({ scope: 'verified_owners', policy: { ref: `trial-sol-${crypto.randomUUID()}`, createdAt: now - 1000, expiresAt: now + 60000, allowedOrigins: ['*'], maxAllocations: 1, maxReservedBrowserMs: 120000, lifetimeMs: 60000, maxScreenshotBytes: 1024 },
    billing: { cloudflareAccountId: 'a'.repeat(32), conservativeWorstCase: true }, spend: { limitMicrousd: 10000000, maxCalls: 100, validUntil: now + 60000 } });
  const directory = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const rpc = String(input), args = JSON.parse(String(init?.body));
    if (rpc.endsWith('/assert_channel_presence')) return Response.json(true);
    if (!rpc.endsWith('/common_owner_authority')) return Response.json([{ do_name: doName, subject: String(SUBJECT), timezone: 'UTC', owner_id: ownerId, owner_email: null }]);
    return Response.json({ owner_id: ownerId, auth_user_id: ownerId, presence_id: ownerId, do_name: doName, provider: 'telegram', subject: args.p_subject, state_version: 1, admission_revision: '1' });
  });
  const logs: MockInstance = vi.spyOn(console, 'log');
  const stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(doName));
  try {
    await runInDurableObject(stub, async (_instance, state) => {
      const privateEnv = { ...env, COMMON_OWNER_TASKS: '0', WALDO_ENVIRONMENT: 'staging', COMMON_BROWSER_REGISTRATION: operator, SUPABASE_PROJECT_URL: 'https://directory.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable-key', WALDO_ROUTER_HMAC_SECRET: 'synthetic-owner-directory-secret',
        LANGFUSE_CAPTURE_TEXT: 'true', WALDO_EGRESS_ALLOWLIST: '*', WALDO_TOOL_OFFLOAD: '0', BROWSER: { fetch: vi.fn(async () => new Response('{}')) } as never, TELEGRAM_BOT_TOKEN: '12345:fictional', TELEGRAM_WEBHOOK_SECRET: 'synthetic-trial-secret', OPENAI_API_KEY: 'synthetic-model-key' };
      const instance = new OwnerDO(state, privateEnv), id = SUBJECT * 100 + 1;
      expect((await instance.fetch(new Request('https://local.invalid/enqueue', { method: 'POST', headers: { 'x-waldo-inbox-secret': privateEnv.TELEGRAM_WEBHOOK_SECRET, 'x-waldo-telegram-subject': String(SUBJECT), 'x-waldo-do-name': doName },
        body: JSON.stringify({ update_id: id, message: { message_id: id, from: { id: SUBJECT, is_bot: false }, chat: { id: SUBJECT, type: 'private' }, text: 'Use Cloudflare to read A.' } }) }))).status).toBe(200);
      await vi.waitFor(async () => {
        await instance.alarm();
        expect(state.storage.kv.get<any[]>('telegram_final_outbox_v1')?.find(row => row.trace === `tg-${id}`)).toMatchObject({ status: 'delivered', settled: true });
      }, { timeout: 8000, interval: 50 });
      const replies = logs.mock.calls.flatMap(([raw]) => { try { const row = JSON.parse(String(raw)); return row.trace === `tg-${id}` && row.hop === 'llm_reply' ? [row] : []; } catch { return []; } });
      expect(replies.map(row => [row.ok, row.code])).toEqual([[true, undefined], [false, 'invalid_args:browser trial model price unavailable']]);
      // Only the unfunded first call reached the provider, and the trial ledger metered the browser and no model call.
      expect(proof.models.filter(model => model === OPENAI_GPT_6_1_SOL_MODEL)).toHaveLength(1);
      const ledgers = [...state.storage.kv.list<any>({ prefix: 'common-spend:' })].map(([, row]) => row);
      expect(ledgers).toHaveLength(1);
      expect(ledgers[0].calls.some((call: any) => call.id.startsWith('browser:'))).toBe(true);
      expect(ledgers[0].calls.some((call: any) => call.id.startsWith('model:'))).toBe(false);
      expect(proof.delivered.at(-1)).toContain('This run did not finish.');
      await state.storage.deleteAlarm();
    });
  } finally { logs.mockRestore(); directory.mockRestore(); }
}, 30000);

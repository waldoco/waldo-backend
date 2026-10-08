import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { TelegramOwnerDO } from '../src/channels/telegram-owner-do';
import { registerCommonBrowserSdk } from '../src/channels/common-staging-registration';
import { routerSignature } from '../src/identity/owner-directory';
import type { CloudflareBrowserSdkLoader } from '../src/channels/public-fixture-browser';

const proof = vi.hoisted(() => ({ subject: 81101, inputs: [] as { subject: number; input: any }[], delivered: [] as { subject: number; text: string }[] }));
vi.mock('openai', () => ({ default: class { responses = { create: async (input: any) => {
  proof.inputs.push({ subject: proof.subject, input: structuredClone(input) });
  const format = input.text?.format?.name;
  const previous = (Array.isArray(input.input) ? input.input : []).filter((item: any) => item.type === 'function_call_output');
  const urls = ['https://example.com/a', 'https://example.com/b', 'https://example.com/a'];
  const read = !format && previous.length < urls.length;
  return { id: 'synthetic-auto-owner', output: read ? [{ type: 'function_call', call_id: `read-${previous.length}`, name: 'browse_page', arguments: JSON.stringify({ provider: 'cloudflare_playwright', url: urls[previous.length], instruction: 'Read the public page' }) }] : [],
    output_text: format === 'claim_ops' ? '{"add":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}' : format ? '{}' : read ? '' : `Owner ${proof.subject} read A/B/A.`, usage: { input_tokens: 1, output_tokens: 1 } };
} }; } }));
vi.mock('../src/channels/telegram-api', async load => ({ ...await load<typeof import('../src/channels/telegram-api')>(), createTelegramCaller: () => async (method: string, payload: any) => {
  if (method === 'sendMessage') { proof.delivered.push({ subject: payload.chat_id, text: payload.text }); return { message_id: proof.delivered.length, chat: { id: payload.chat_id } }; }
  return method === 'getMe' ? { username: 'auto_owner_fixture_bot' } : true;
} }));

it('one explicit bounded operator policy serves two existing owners and a newly admitted owner through their ordinary hosts', async () => {
  const sessions = new Map<string, { subject: number; pages: any[]; context: any }>();
  const allocated: string[] = [], ended: string[] = [];
  const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1cAAAAASUVORK5CYII='), x => x.charCodeAt(0));
  const loader: CloudflareBrowserSdkLoader = async () => ({
    acquire: async (binding: any, options: any) => {
      await binding.fetch(`http://fake.host/v1/devtools/browser?keep_alive=${options.keep_alive}`, { method: 'POST' });
      const id = `private-provider-${crypto.randomUUID()}`, subject = proof.subject;
      const row = { subject, pages: [] as any[], context: undefined as any };
      row.context = { serviceWorkers: () => [], addInitScript: async () => {}, routeWebSocket: async () => {}, pages: () => row.pages.slice(), route: async () => {}, unroute: async () => {},
        newCDPSession: async (page: any) => ({ send: async () => ({ targetInfo: { targetId: page.id } }), detach: async () => {} }),
        newPage: async () => {
          let url = 'about:blank';
          const page = { id: crypto.randomUUID(), url: () => url, title: async () => `Owner ${subject}`, setDefaultTimeout() {}, goto: async (target: string) => { url = target; return { status: () => 200 }; },
            evaluate: async () => ({ url, title: `Owner ${subject}`, text: `Owner ${subject} cookie-${subject} ${url}`, width: 1, height: 1, scrollX: 0, scrollY: 0, elements: [] }), screenshot: async () => png.slice(), close: async () => { row.pages = row.pages.filter(p => p !== page); } };
          row.pages.push(page); return page;
        } };
      sessions.set(id, row); allocated.push(id); return { sessionId: id };
    },
    connect: async (binding: any, options: any) => {
      await binding.fetch(`http://fake.host/v1/devtools/browser/${options.sessionId}?persistent=true`, { headers: { upgrade: 'websocket' } });
      const row = sessions.get(options.sessionId); if (!row) throw Error('No retained fake session');
      return { contexts: () => [row.context], close: async () => {}, newBrowserCDPSession: async () => ({ send: async () => { sessions.delete(options.sessionId); ended.push(options.sessionId); } }) };
    },
    sessions: async (binding: any) => { await binding.fetch('http://fake.host/v1/sessions'); return [...sessions.keys()].map(sessionId => ({ sessionId })); }, endpointURLString: () => '',
  } as never);
  registerCommonBrowserSdk(loader);
  const now = Date.now();
  const operator = JSON.stringify({ scope: 'verified_owners', policy: { ref: `three-owner-${crypto.randomUUID()}`, createdAt: now - 1000, expiresAt: now + 60000, allowedOrigins: ['*'], maxAllocations: 1, maxReservedBrowserMs: 120000, lifetimeMs: 60000, maxScreenshotBytes: 1024 },
    billing: { cloudflareAccountId: 'a'.repeat(32), conservativeWorstCase: true }, spend: { limitMicrousd: 10000000, maxCalls: 100, validUntil: now + 60000 } });
  const owners = [81101, 81102, 81103].map((subject, i) => ({ subject, doName: `automatic-${subject}-${crypto.randomUUID()}`, id: `10000000-0000-0000-0000-00000000000${i + 1}` }));
  const admitted = new Set([81101, 81102]);
  const secret = 'synthetic-owner-directory-secret';
  const denied = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const rpc = String(input);
    if (!['https://directory.invalid/rest/v1/rpc/common_owner_authority', 'https://directory.invalid/rest/v1/rpc/route_presence', 'https://directory.invalid/rest/v1/rpc/assert_channel_presence'].includes(rpc)) throw Error('Live network forbidden');
    const args = JSON.parse(String(init?.body));
    const authority = rpc.endsWith('/common_owner_authority');
    const presence = rpc.endsWith('/assert_channel_presence');
    expect(args.p_sig).toBe(await routerSignature(secret, args.p_at, authority ? `common.owner.${args.p_locator}` : presence ? `presence.${args.p_do_name}.${args.p_provider}.${args.p_subject}` : `route.${args.p_provider}.${args.p_subject}`));
    if (authority) expect(JSON.parse(args.p_locator)).toEqual(['telegram', args.p_subject, args.p_do_name]);
    const owner = owners.find(row => String(row.subject) === args.p_subject && (!authority || row.doName === args.p_do_name));
    if (presence) return Response.json(Boolean(owner && owner.doName === args.p_do_name && admitted.has(owner.subject)));
    if (!authority) return Response.json(owner && admitted.has(owner.subject) ? [{ do_name: owner.doName, subject: String(owner.subject), timezone: 'UTC', owner_id: owner.id, owner_email: null }] : []);
    return Response.json(owner && admitted.has(owner.subject) ? { owner_id: owner.id, auth_user_id: owner.id, presence_id: owner.id, do_name: owner.doName, provider: 'telegram', subject: String(owner.subject), state_version: 1, admission_revision: String(owner.subject) } : null);
  });
  const receipts: { ownerId: string; handle: string; ref: string; reserved: number }[] = [];
  try {
    for (const owner of owners) {
      proof.subject = owner.subject;
      const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(owner.doName));
      await runInDurableObject(stub, async (_instance, state) => {
        const binding = { fetch: vi.fn(async () => new Response('{}')) };
        const privateEnv = { ...env, COMMON_OWNER_TASKS: '0', WALDO_ENVIRONMENT: 'staging', COMMON_BROWSER_REGISTRATION: operator, SUPABASE_PROJECT_URL: 'https://directory.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable-key', WALDO_ROUTER_HMAC_SECRET: secret,
          LANGFUSE_CAPTURE_TEXT: 'true', WALDO_EGRESS_ALLOWLIST: '*', WALDO_TOOL_OFFLOAD: '0', BROWSER: binding as never, TELEGRAM_BOT_TOKEN: '12345:fictional', TELEGRAM_WEBHOOK_SECRET: 'synthetic-auto-secret', OPENAI_API_KEY: 'synthetic-model-key' };
        let instance = new TelegramOwnerDO(state, privateEnv), updateId = owner.subject * 100;
        const send = async (text: string, expectedStatus = 'delivered') => {
          const id = ++updateId;
          const deliveredBefore = proof.delivered.length;
          expect((await instance.fetch(new Request('https://local.invalid/enqueue', { method: 'POST', headers: { 'x-waldo-inbox-secret': privateEnv.TELEGRAM_WEBHOOK_SECRET, 'x-waldo-telegram-subject': String(owner.subject), 'x-waldo-do-name': owner.doName }, body: JSON.stringify({ update_id: id, message: { message_id: id, from: { id: owner.subject, is_bot: false }, chat: { id: owner.subject, type: 'private' }, text } }) }))).status).toBe(200);
          await vi.waitFor(async () => {
            await instance.alarm();
            if (text === '/stop') {
              const row = state.storage.kv.get<any[]>('telegram_owner_inbox_v1')?.find(row => row.updateId === id);
              expect(['consumed', 'completed']).toContain(row?.state);
              expect(proof.delivered.slice(deliveredBefore).some(row => Number(row.subject) === owner.subject && row.text.includes('Nothing is running'))).toBe(true);
              return;
            }
            const final = state.storage.kv.get<any[]>('telegram_final_outbox_v1')?.find(row => row.trace === `tg-${id}`);
            expect(final).toMatchObject({ status: expectedStatus, settled: true });
          }, { timeout: 8000, interval: 50 });
        };
        if (!admitted.has(owner.subject)) {
          const calls = proof.inputs.length;
          await send('Use Cloudflare for A/B/A.', 'blocked');
          expect(proof.inputs).toHaveLength(calls); expect(allocated).toHaveLength(2);
          // Admission changes in the existing directory; no operator/browser
          // registration changes are needed for this newly invited owner.
          admitted.add(owner.subject); instance = new TelegramOwnerDO(state, privateEnv);
        }
        await send('Use Cloudflare to read A, B, then revisit A.');
        const final = proof.inputs.filter(row => row.subject === owner.subject).map(row => row.input).find(input => Array.isArray(input.input) && input.input.filter((item: any) => item.type === 'function_call_output').length === 3);
        expect(final).toBeDefined();
        const outputs = final.input.filter((item: any) => item.type === 'function_call_output').map((item: any) => JSON.parse(item.output));
        expect(outputs).toHaveLength(3); expect(outputs.every((row: any) => row.ok && row.data.text.includes(`cookie-${owner.subject}`))).toBe(true);
        expect(new Set(outputs.map((row: any) => row.data.session_handle)).size).toBe(1);
        expect(JSON.stringify(final)).toContain('data:image/png;base64,iVBOR');
        expect(JSON.stringify(final)).not.toContain('private-provider-');
        expect(proof.delivered.some(row => Number(row.subject) === owner.subject && row.text === `Owner ${owner.subject} read A/B/A.`)).toBe(true);
        const records = [...state.storage.kv.list<any>({ prefix: 'common-browser:' })].map(([, row]) => row);
        expect(records).toHaveLength(1); expect(records[0]).toMatchObject({ cleanup: 'closed', session: { state: 'ended' } });
        const ledgers = [...state.storage.kv.list<any>({ prefix: 'common-spend:' })].map(([, row]) => row);
        expect(ledgers).toHaveLength(1); expect(ledgers[0].calls[0]?.id).toMatch(/^model:/);
        expect(ledgers[0].policy.ownerId).toBe(`prn_${owner.id.replaceAll('-', '')}`);
        expect(ledgers[0].reservedMicrousd).toBeLessThanOrEqual(10000000);
        receipts.push({ ownerId: records[0].session.ownerId, handle: outputs[0].data.session_handle, ref: ledgers[0].policy.ref, reserved: ledgers[0].reservedMicrousd });
        const snapshot = structuredClone(ledgers[0]);
        instance = new TelegramOwnerDO(state, privateEnv); await send('/stop');
        expect([...state.storage.kv.list<any>({ prefix: 'common-spend:' })][0]?.[1]).toEqual(snapshot);
        await state.storage.deleteAlarm();
      });
    }
    expect(new Set(receipts.map(row => row.ownerId)).size).toBe(3);
    expect(new Set(receipts.map(row => row.handle)).size).toBe(3);
    expect(new Set(receipts.map(row => row.ref)).size).toBe(3);
    expect(allocated).toHaveLength(3); expect(new Set(allocated).size).toBe(3);
    expect(ended.sort()).toEqual(allocated.sort()); expect(sessions.size).toBe(0);
  } finally { denied.mockRestore(); }
}, 30000);

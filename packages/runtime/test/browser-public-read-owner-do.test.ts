import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { TelegramOwnerDO } from '../src/channels/telegram-owner-do';
import { configureCommonPublicBrowser } from '../src/channels/common-public-browser-configuration';
import { commonBrowserFixture, commonBrowserMeteredFixtureLoader } from './fixtures/common-browser-sdk';

const proof = vi.hoisted(() => ({ inputs: [] as any[], delivered: [] as string[], directoryOwner: '10000000-0000-0000-0000-000000000001', doName: '', subject: '81101' }));
vi.mock('../src/identity/common-owner-authority', () => ({ commonOwnerAuthority: () => ({ resolve: async () => ({ directoryOwnerId: proof.directoryOwner, custodyDigest: 'a'.repeat(64) }) }) }));
vi.mock('openai', () => ({ default: class { responses = { create: async (input: any) => {
  proof.inputs.push(structuredClone(input));
  const format = input.text?.format?.name;
  const previous = (Array.isArray(input.input) ? input.input : []).filter((item: any) => item.type === 'function_call_output');
  const urls = ['https://example.com/a', 'https://www.iana.org/b', 'https://example.com/a'];
  const read = !format && previous.length < urls.length;
  return { id: 'synthetic-public-browser-reply', output: read ? [{ type: 'function_call', call_id: `public-read-${previous.length}`, name: 'browse_page', arguments: JSON.stringify({ provider: 'cloudflare_playwright', url: urls[previous.length], instruction: 'Read the public page' }) }] : [],
    output_text: format === 'claim_ops' ? '{"add":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}' : format ? '{}' : read ? '' : 'Option A costs 10 fictional tokens; option B costs 20 fictional tokens. A was revisited.', usage: { input_tokens: 1, output_tokens: 1 } };
} }; } }));
vi.mock('../src/channels/telegram-api', async load => ({ ...await load<typeof import('../src/channels/telegram-api')>(), createTelegramCaller: () => async (method: string, payload: any) => {
  if (method === 'sendMessage') { proof.delivered.push(payload.text); return { message_id: proof.delivered.length }; }
  return method === 'getMe' ? { username: 'public_browser_fixture_bot' } : true;
} }));

it('ordinary two-argument owner constructor reads A/B in one selected Cloudflare session and refuses identical A without an action, forwards PNG, delivers evidence and closes without common activation', async () => {
  commonBrowserFixture.reset();
  const doName = proof.doName = `public-browser-two-arg-${crypto.randomUUID()}`, subject = Number(proof.subject);
  const now = Date.now(), ref = `public-proof-${crypto.randomUUID()}`;
  configureCommonPublicBrowser({ ref, doName, subject: String(subject), directoryOwnerId: proof.directoryOwner, createdAt: now - 1000, expiresAt: now + 60000, allowedOrigins: ['*'], maxAllocations: 1, maxReservedBrowserMs: 120000, lifetimeMs: 60000, maxScreenshotBytes: 1024 }, commonBrowserMeteredFixtureLoader,
    { policy: { ref, ownerId: `prn_${proof.directoryOwner.replaceAll('-', '')}`, validUntil: now + 60000, limitMicrousd: 10000, maxCalls: 100 }, quote: kind => kind === 'browser' ? 0 : 1, allocationMicrousd: 100 });
  const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(doName));
  await runInDurableObject(stub, async (_instance, state) => {
    const denied = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('live network forbidden'));
    const binding = { fetch: vi.fn(async () => new Response('{}', { status: 200 })) };
    const privateEnv = { ...env, COMMON_OWNER_TASKS: '0', WALDO_ENVIRONMENT: 'staging', LANGFUSE_CAPTURE_TEXT: 'true', WALDO_EGRESS_ALLOWLIST: '*', WALDO_TOOL_OFFLOAD: '0', BROWSER: binding as never, TELEGRAM_BOT_TOKEN: '12345:fictional', TELEGRAM_WEBHOOK_SECRET: 'synthetic-public-browser-secret', OPENAI_API_KEY: 'synthetic-model-key' };
    let instance = new TelegramOwnerDO(state, privateEnv);
    let updateId = 9981000;
    const send = async (text: string) => {
      const id = ++updateId;
      const response = await instance.fetch(new Request('https://local.invalid/enqueue', { method: 'POST', headers: { 'x-waldo-inbox-secret': privateEnv.TELEGRAM_WEBHOOK_SECRET, 'x-waldo-telegram-subject': String(subject), 'x-waldo-do-name': doName }, body: JSON.stringify({ update_id: id, message: { message_id: id, from: { id: subject, is_bot: false }, chat: { id: subject, type: 'private' }, text } }) }));
      expect(response.status).toBe(200);
      for (let i = 0; i < 8; i++) {
        await instance.alarm();
        const row = state.storage.kv.get<any[]>('telegram_owner_inbox_v1')?.find(row => row.updateId === id);
        if (row?.closedAt !== undefined || row?.state === 'completed' || row?.state === 'consumed') return;
      }
      throw Error('Owner turn did not finish');
    };
    try {
      await send('Use Cloudflare to read A, B, then revisit A in the same browser task.');
      // Final commitment closes inbox custody before asynchronous outbox delivery.
      await vi.waitFor(async () => { await instance.alarm(); expect(proof.delivered.some(text => text.includes('Option A costs 10') && text.includes('option B costs 20'))).toBe(true); }, { timeout: 3000, interval: 50 });
      expect(commonBrowserFixture.allocations).toBe(1);
      const replies = proof.inputs.filter(input => !input.text?.format);
      const final = replies.find(input => Array.isArray(input.input) && input.input.filter((item: any) => item.type === 'function_call_output').length === 3);
      expect(final).toBeDefined();
      const outputs = final.input.filter((item: any) => item.type === 'function_call_output').map((item: any) => JSON.parse(item.output));
      expect(outputs.slice(0,2).every((row: any) => row.ok === true)).toBe(true);
      expect(outputs.slice(0,2).map((row: any) => row.data.url)).toEqual(['https://example.com/a', 'https://www.iana.org/b']);
      expect(outputs[2]).toMatchObject({ok:false,code:'repeat_refusal'});
      expect(new Set(outputs.slice(0,2).map((row: any) => row.data.session_handle)).size).toBe(1);
      expect(outputs[0].data.text).toContain('Option A costs 10'); expect(outputs[1].data.text).toContain('Option B costs 20');
      expect(JSON.stringify(final)).toContain('data:image/png;base64,iVBOR');
      expect(JSON.stringify(proof.inputs)).not.toContain('fixture-retained-provider');
      expect(proof.delivered.some(text => text.includes('Option A costs 10') && text.includes('option B costs 20'))).toBe(true);
      expect(state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='owner_task_source_scope'").toArray()).toHaveLength(0);
      const records = [...state.storage.kv.list<any>({ prefix: 'common-browser:' })].map(([, row]) => row);
      expect(records).toHaveLength(1); expect(records[0]).toMatchObject({ allocation: 'observed', cleanup: 'closed', session: { state: 'ended' } });
      expect(commonBrowserFixture.ends).toBe(1); expect(await (await commonBrowserMeteredFixtureLoader()).sessions(binding as never)).toEqual([]);
      expect(commonBrowserFixture.pages).toHaveLength(0);
      expect(binding.fetch).toHaveBeenCalled(); expect(denied).not.toHaveBeenCalled();
      instance = new TelegramOwnerDO(state, privateEnv);
      await send('/stop');
      expect(commonBrowserFixture.allocations).toBe(1); expect(commonBrowserFixture.ends).toBe(1);
      const ledger = state.storage.kv.get<any>(`common-spend:${ref}`);
      expect(ledger.reservedMicrousd).toBeGreaterThanOrEqual(100);
      expect(ledger.calls.filter((call: any) => call.id.startsWith('model:')).length).toBeGreaterThanOrEqual(3);
      expect(ledger.reservedMicrousd).toBeLessThanOrEqual(10000);
    } finally { await state.storage.deleteAlarm(); denied.mockRestore(); }
  });
});
